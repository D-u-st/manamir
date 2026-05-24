// Discord channel adapter
// Implements P-70 Channel abstraction for Discord

import {
  Client,
  GatewayIntentBits,
  Events,
  type Message,
  type TextChannel
} from 'discord.js';
import { ProxyAgent } from 'undici';
import type {
  ChannelAdapter,
  IncomingMessage,
  MessageEvent,
  OutgoingMessage,
} from './types';
import { eventToIncoming } from './types';
import { log } from '../utils/logger';
import { MessageDedup, type MessageDedupOptions } from './message-dedup';
import { processDiscordImages } from '../multimodal/discord-image-handler';

// Discord message size limits
const MAX_CHARS = 2000;
const MAX_LINES = 80;

export class DiscordChannel implements ChannelAdapter {
  readonly name = 'discord';
  private client: Client;
  private messageHandler: ((msg: IncomingMessage) => void) | null = null;
  private eventHandler: ((event: MessageEvent) => void) | null = null;
  private allowedUserIds: Set<string>;
  private typingIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  private dedup: MessageDedup;

  constructor(
    private token: string,
    allowedUserIds: string[] = [],
    dedupOptions: MessageDedupOptions = {}
  ) {
    this.allowedUserIds = new Set(allowedUserIds);
    this.dedup = new MessageDedup(dedupOptions);

    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const restOptions = proxyUrl
      ? { agent: new ProxyAgent(proxyUrl) as InstanceType<typeof ProxyAgent> }
      : undefined;

    if (proxyUrl) {
      log.info(`Discord: REST proxy ${proxyUrl}`);
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
      ],
      rest: restOptions
    });
  }

  async connect(): Promise<void> {
    // Restore dedup state from disk before listening for messages, so a
    // RESUME-replay immediately on connect is recognized as duplicate.
    await this.dedup.load();
    this.dedup.startAutoFlush();

    return new Promise((resolve, reject) => {
      this.client.once(Events.ClientReady, (ready) => {
        log.info(`Discord: logged in as ${ready.user.tag}`);
        this.setupMessageListener();
        resolve();
      });

      this.client.login(this.token).catch(reject);
    });
  }

  async disconnect(): Promise<void> {
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Final flush of dedup state before tearing down.
    this.dedup.stopAutoFlush();
    try {
      await this.dedup.flush();
    } catch (err) {
      log.warn('Discord: dedup final flush failed', { error: String(err) });
    }

    await this.client.destroy();
    log.info('Discord: disconnected');
  }

  /** Expose dedup stats for /status display. */
  getDedupStats(): { totalSeen: number; duplicatesRejected: number; windowSize: number } {
    return this.dedup.stats();
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  onEvent(handler: (event: MessageEvent) => void): void {
    this.eventHandler = handler;
  }

  async send(msg: OutgoingMessage): Promise<string | undefined> {
    const channel = await this.client.channels.fetch(msg.channelId) as TextChannel;
    if (!channel) {
      log.error('Discord: channel not found', { channelId: msg.channelId });
      return undefined;
    }

    // Stop typing indicator for this channel
    this.stopTyping(msg.channelId);

    const chunks = this.chunkText(msg.content);
    let lastId: string | undefined;
    for (const chunk of chunks) {
      const sent = await channel.send(chunk);
      lastId = sent.id;
    }
    return lastId;
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      if (!channel) return false;
      const msg = await channel.messages.fetch(messageId);
      if (!msg) return false;
      await msg.edit(content);
      return true;
    } catch (err) {
      log.warn('Discord: editMessage failed', { channelId, messageId, error: String(err) });
      return false;
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      if (!channel) return;

      // Send immediately
      await channel.sendTyping();

      // Continue sending every 4s (Discord typing indicator lasts ~10s)
      if (!this.typingIntervals.has(channelId)) {
        const interval = setInterval(() => {
          channel.sendTyping().catch((err) => {
            log.warn('Discord: typing indicator failed, stopping', { channelId, error: String(err) });
            this.stopTyping(channelId);
          });
        }, 4000);
        this.typingIntervals.set(channelId, interval);

        // Safety cap: auto-stop after 5 minutes
        const maxTypingMs = 300_000;
        setTimeout(() => this.stopTyping(channelId), maxTypingMs);
      }
    } catch {
      // Don't crash on typing failure
    }
  }

  private stopTyping(channelId: string): void {
    const interval = this.typingIntervals.get(channelId);
    if (interval) {
      clearInterval(interval);
    }
    this.typingIntervals.delete(channelId);
  }

  private setupMessageListener(): void {
    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot) return;
      if (!message.mentions.has(this.client.user!)) return;

      // Dedup check BEFORE authorization to also short-circuit replayed
      // unauthorized-bounces from a RESUME. We use the raw message content
      // (not the stripped one) so the hash is stable regardless of how we
      // post-process the text.
      if (this.dedup.isDuplicate({
        id: message.id,
        channelId: message.channelId,
        userId: message.author.id,
        content: message.content
      })) {
        log.info(`MessageDedup: rejected duplicate ${message.id}`);
        return;
      }

      // Authorization check
      if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(message.author.id)) {
        message.reply('You are not authorized to use this bot.').catch(() => {});
        return;
      }

      // Strip mention from content
      const content = message.content.replace(/<@!?\d+>/g, '').trim();
      const hasAttachments = message.attachments.size > 0;
      if (!content && !hasAttachments) return;

      const source: MessageEvent['source'] =
        message.channel.isDMBased() ? 'dm'
        : message.channel.isThread() ? 'thread'
        : 'group';

      const mediaUrls: string[] = [];
      const mediaTypes: string[] = [];
      for (const att of message.attachments.values()) {
        mediaUrls.push(att.url);
        mediaTypes.push(att.contentType ?? 'application/octet-stream');
      }

      // Preprocess images: download + OCR + prepend each as a [image: ...]
      // block to the text the executor sees. Keep it best-effort — OCR failures
      // must never drop the original message.
      let enhancedText = content;
      if (mediaUrls.length > 0) {
        try {
          const ocrBlocks = await processDiscordImages(mediaUrls, mediaTypes);
          if (ocrBlocks.length > 0) {
            enhancedText = [...ocrBlocks, content].filter((s) => s.length > 0).join('\n\n');
          }
        } catch (err) {
          log.warn('Discord: image preprocessing failed', { error: String(err) });
        }
      }

      const event: MessageEvent = {
        text: enhancedText,
        messageType: mediaUrls.length > 0 ? this.classifyMedia(mediaTypes[0]) : 'text',
        source,
        channelId: message.channelId,
        userId: message.author.id,
        username: message.author.username,
        messageId: message.id,
        replyToMessageId: message.reference?.messageId,
        mediaUrls: mediaUrls.length ? mediaUrls : undefined,
        mediaTypes: mediaTypes.length ? mediaTypes : undefined,
        timestamp: message.createdTimestamp,
        rawMessage: message,
        platform: 'discord',
      };

      if (this.eventHandler) {
        this.eventHandler(event);
      }
      if (this.messageHandler) {
        this.messageHandler(eventToIncoming(event));
      }
    });
  }

  private classifyMedia(mimeType: string | undefined): MessageEvent['messageType'] {
    if (!mimeType) return 'file';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'voice';
    return 'file';
  }

  // Code-fence-aware text chunking (from v1 chunk.ts, cleaned up)
  chunkText(text: string): string[] {
    if (!text || text.length === 0) return [];
    if (text.length <= MAX_CHARS) return [text];

    const chunks: string[] = [];
    const lines = text.split('\n');
    let currentLines: string[] = [];
    let currentLength = 0;

    const flush = () => {
      if (currentLines.length === 0) return;
      let chunk = currentLines.join('\n');

      // Close open code fences
      const openFence = getOpenFence(chunk);
      if (openFence !== null) {
        chunk += '\n```';
      }

      // Close open italics
      if (hasOpenItalic(chunk)) {
        chunk += '*';
      }

      chunks.push(chunk);

      // Re-open fence in next chunk
      currentLines = openFence !== null ? ['```' + openFence] : [];
      currentLength = currentLines.length > 0 ? currentLines[0].length + 1 : 0;
    };

    for (const line of lines) {
      const addedLength = currentLines.length === 0 ? line.length : line.length + 1;

      if ((currentLength + addedLength > MAX_CHARS || currentLines.length >= MAX_LINES) && currentLines.length > 0) {
        flush();
      }

      // Hard-split single lines that exceed MAX_CHARS
      if (line.length > MAX_CHARS) {
        let remaining = line;
        while (remaining.length > 0) {
          if (currentLines.length > 0) flush();
          const slice = remaining.slice(0, MAX_CHARS);
          remaining = remaining.slice(MAX_CHARS);
          if (remaining.length === 0) {
            currentLines.push(slice);
            currentLength = slice.length;
          } else {
            chunks.push(slice);
          }
        }
        continue;
      }

      currentLines.push(line);
      currentLength += addedLength;
    }

    flush();
    return chunks;
  }
}

// Helpers for code fence tracking
function getOpenFence(text: string): string | null {
  const fencePattern = /^```([a-zA-Z0-9_+-]*)$/gm;
  let openTag: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text)) !== null) {
    openTag = openTag === null ? match[1] : null;
  }
  return openTag;
}

function hasOpenItalic(text: string): boolean {
  const stripped = text.replace(/\*\*/g, '');
  return ((stripped.match(/\*/g) ?? []).length) % 2 !== 0;
}
