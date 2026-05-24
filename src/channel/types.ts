// Channel abstraction
// Unified interface for Discord, Telegram, Web, etc.
// Upgraded with MessageEvent .

export type MessageType = 'text' | 'voice' | 'image' | 'video' | 'file' | 'sticker';
export type SessionSource = 'dm' | 'group' | 'thread' | 'channel';

export interface MessageEvent {
  text: string;
  messageType: MessageType;
  source: SessionSource;
  channelId: string;
  userId: string;
  username: string;
  messageId?: string;
  replyToMessageId?: string;
  replyToText?: string;
  mediaUrls?: string[];
  mediaTypes?: string[];
  autoSkill?: string | string[];
  internal?: boolean;
  timestamp: number;
  rawMessage?: unknown;
  platform?: string;
}

// Back-compat: IncomingMessage is the legacy shape. Kept as a structural alias
// so existing handlers continue to compile. New code should consume MessageEvent.
export interface IncomingMessage {
  channelId: string;
  userId: string;
  content: string;
  username: string;
  timestamp: number;
  raw?: unknown;
}

export function eventToIncoming(event: MessageEvent): IncomingMessage {
  return {
    channelId: event.channelId,
    userId: event.userId,
    content: event.text,
    username: event.username,
    timestamp: event.timestamp,
    raw: event.rawMessage,
  };
}

export function incomingToEvent(
  msg: IncomingMessage,
  overrides: Partial<MessageEvent> = {}
): MessageEvent {
  return {
    text: msg.content,
    messageType: 'text',
    source: 'dm',
    channelId: msg.channelId,
    userId: msg.userId,
    username: msg.username,
    timestamp: msg.timestamp,
    rawMessage: msg.raw,
    ...overrides,
  };
}

export interface OutgoingMessage {
  content: string;
  channelId: string;
  replyTo?: string;
}

export interface ChannelAdapter {
  readonly name: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  send(msg: OutgoingMessage): Promise<string | undefined>;
  sendTyping(channelId: string): Promise<void>;

  // Legacy handler: IncomingMessage. New code should use onEvent.
  onMessage(handler: (msg: IncomingMessage) => void): void;
  onEvent?(handler: (event: MessageEvent) => void): void;

  chunkText(text: string): string[];
}
