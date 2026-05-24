// Message handler — processes incoming Discord messages (extracted from index.ts)

import { log } from '../utils/logger';
import { trackMessage, trackCost, trackExecution, trackError } from '../core/state';
import { sessionId, taskId } from '../types';
import { hooks } from '../hooks';
import type { IncomingMessage } from '../channel/types';
import type { DiscordChannel } from '../channel/discord';
import type { SessionManager } from '../session/manager';
import type { ProgressTracker } from '../comms/progress';
import type { NotificationManager } from '../comms/notifications';
import type { WsServer } from '../comms/ws-server';

export interface MessageHandlerDeps {
  sessionManager: SessionManager;
  discord: DiscordChannel;
  progressTracker: ProgressTracker;
  notifications: NotificationManager;
  getWsServer: () => WsServer | null;
  handleCommand: (msg: IncomingMessage) => Promise<void>;
}

export function createMessageHandler(deps: MessageHandlerDeps) {
  const { sessionManager, discord, progressTracker, notifications, getWsServer, handleCommand } = deps;

  return async (msg: IncomingMessage): Promise<void> => {
    log.info('Incoming message', {
      channel: msg.channelId,
      user: msg.username,
      length: msg.content.length
    });

    trackMessage();
    await hooks.emit('message:receive', { channelId: msg.channelId, userId: msg.userId, contentLength: msg.content.length });

    // Auto-subscribe this channel to notifications
    if (!notifications.getSubscribedChannels().includes(msg.channelId)) {
      notifications.setChannelPreferences(msg.channelId, { minLevel: 'info' });
    }

    if (msg.content.startsWith('/')) {
      await handleCommand(msg);
      return;
    }

    await discord.sendTyping(msg.channelId);

    trackExecution(true);
    const execTaskId = taskId(`task_${Date.now()}`);

    progressTracker.setSink(async (formatted) => {
      await discord.send({ channelId: msg.channelId, content: formatted });
    });
    progressTracker.start(execTaskId, sessionManager.getSession(msg.channelId)?.id ?? sessionId(msg.channelId), msg.content.slice(0, 50));

    // Streaming editMessage state
    let streamMsgId: string | undefined;
    let streamBuffer = '';
    let editInterval = 500;
    let editFailures = 0;
    const MAX_EDIT_FAILURES = 3;
    let editTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingEdit = false;
    const CURSOR = '\u2589';

    const flushEdit = async () => {
      if (!streamMsgId || !streamBuffer || editFailures >= MAX_EDIT_FAILURES) return;
      pendingEdit = false;
      const display = streamBuffer + CURSOR;
      const success = await discord.editMessage(msg.channelId, streamMsgId, display);
      if (!success) {
        editFailures++;
        if (editFailures >= MAX_EDIT_FAILURES) {
          log.warn('Streaming edit: flood control, falling back to final message', { channelId: msg.channelId });
        } else {
          editInterval = Math.min(editInterval * 2, 2000);
        }
      }
    };

    const scheduleEdit = () => {
      if (editFailures >= MAX_EDIT_FAILURES) return;
      if (editTimer) return;
      pendingEdit = true;
      editTimer = setTimeout(() => {
        editTimer = null;
        if (pendingEdit) flushEdit();
      }, editInterval);
    };

    // Wire session events for real-time Discord streaming + WS broadcast
    const session = sessionManager.getSession(msg.channelId);

    // Refs for finally-block cleanup (Bug 7 fix)
    let textHandler: ((chunk: string) => Promise<void>) | null = null;
    let toolUseHandler: ((tool: string, input: Record<string, unknown>) => Promise<void>) | null = null;
    let toolResultHandler: ((tool: string, resultContent: string, isError: boolean) => void) | null = null;
    let idleCheck: ReturnType<typeof setInterval> | null = null;

    if (session) {
      // Track in-flight initial send so concurrent chunks don't each create
      // their own message while the first send is still awaiting Discord.
      let initialSendInFlight: Promise<string | undefined> | null = null;

      textHandler = async (chunk: string) => {
        if (streamMsgId) {
          streamBuffer += chunk;
          scheduleEdit();
          return;
        }
        if (initialSendInFlight) {
          // First send already kicked off — just append to the buffer; the
          // edit timer will pick it up once streamMsgId is set.
          streamBuffer += chunk;
          return;
        }
        // First chunk: claim the slot synchronously by holding the promise.
        streamBuffer = chunk;
        initialSendInFlight = discord.send({
          channelId: msg.channelId,
          content: streamBuffer + CURSOR
        });
        const sentId = await initialSendInFlight;
        initialSendInFlight = null;
        if (sentId) {
          streamMsgId = sentId;
          // If chunks arrived during the await, push the accumulated buffer.
          if (streamBuffer !== chunk) scheduleEdit();
        }
      };

      toolUseHandler = async (tool: string, input: Record<string, unknown>) => {
        // Finalize current streaming message
        if (streamMsgId && streamBuffer) {
          await discord.editMessage(msg.channelId, streamMsgId, streamBuffer);
          streamMsgId = undefined;
          streamBuffer = '';
        }

        progressTracker.update(execTaskId, 'working', 50, `Using ${tool}`);

        const inputPreview = JSON.stringify(input).slice(0, 150);
        discord.send({
          channelId: msg.channelId,
          content: `\u{1F527} \`${tool}\`: ${inputPreview}`
        }).catch(err => log.warn('Discord send failed', { error: String(err) }));

        const wsServer = getWsServer();
        if (wsServer) {
          wsServer.broadcast({
            type: 'tool_use',
            sessionId: session.id,
            tool,
            input
          });
        }
      };

      toolResultHandler = (_tool: string, resultContent: string, isError: boolean) => {
        const preview = resultContent.slice(0, 200);
        const icon = isError ? '\u274C' : '\u{1F4C4}';
        discord.send({
          channelId: msg.channelId,
          content: `${icon} ${preview}${resultContent.length > 200 ? '...' : ''}`
        }).catch(err => log.warn('Discord send failed', { error: String(err) }));
      };

      session.on('text', textHandler);
      session.on('tool_use', toolUseHandler);
      session.on('tool_result', toolResultHandler);

      idleCheck = setInterval(() => {
        // Bug 7 fix: check if session was destroyed before accessing status
        if (!sessionManager.getSession(msg.channelId)) {
          if (idleCheck) {
            clearInterval(idleCheck);
            idleCheck = null;
          }
          return;
        }
        if (session.status === 'idle') {
          if (idleCheck) {
            clearInterval(idleCheck);
            idleCheck = null;
          }
        }
      }, 1000);
    }

    try {
      const result = await sessionManager.handleMessage(
        msg.channelId,
        msg.userId,
        msg.content
      );

      // Finalize any streaming message (remove cursor)
      if (streamMsgId && streamBuffer) {
        await discord.editMessage(msg.channelId, streamMsgId, streamBuffer);
      }
      if (editTimer) {
        clearTimeout(editTimer);
        editTimer = null;
      }

      trackExecution(false);

      if (result.costUsd && result.sessionId) {
        trackCost(result.sessionId, result.costUsd);
      }

      await progressTracker.complete(
        execTaskId,
        msg.content.slice(0, 80),
        result.numTurns,
        result.costUsd ?? 0
      );

      await hooks.emit('message:send', { channelId: msg.channelId, contentLength: result.content.length });
      // Send final response as new message (not edit)
      await discord.send({
        channelId: msg.channelId,
        content: result.content
      });

      const wsServer = getWsServer();
      if (wsServer) {
        wsServer.broadcast({
          type: 'result',
          sessionId: result.sessionId,
          content: result.content,
          costUsd: result.costUsd,
          durationMs: result.durationMs
        });
      }

      if (result.isError) {
        trackError();
        await notifications.notify('warning', `Error in channel ${msg.channelId}: ${result.content.slice(0, 100)}`);
      } else {
        log.info('Response sent', {
          channel: msg.channelId,
          durationMs: result.durationMs,
          cost: result.costUsd,
          turns: result.numTurns
        });

        if (result.costUsd && result.costUsd > 0.5) {
          await notifications.notify('info', `High-cost session: $${result.costUsd.toFixed(3)} in channel ${msg.channelId}`);
        }
      }
    } finally {
      // Bug 7 fix: always remove session listeners + clear timers, even on error
      if (session) {
        if (textHandler) session.off('text', textHandler);
        if (toolUseHandler) session.off('tool_use', toolUseHandler);
        if (toolResultHandler) session.off('tool_result', toolResultHandler);
      }
      if (idleCheck) {
        clearInterval(idleCheck);
        idleCheck = null;
      }
      if (editTimer) {
        clearTimeout(editTimer);
        editTimer = null;
      }
    }
  };
}
