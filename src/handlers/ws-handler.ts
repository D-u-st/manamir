// WebSocket message handler — processes WS inbound messages (extracted from index.ts)

import { stateSnapshot } from '../core/state';
import type { SessionManager } from '../session/manager';
import type { WsServer, WsInbound } from '../comms/ws-server';

export interface WsHandlerDeps {
  sessionManager: SessionManager;
  getWsServer: () => WsServer | null;
}

export function createWsHandler(deps: WsHandlerDeps) {
  const { sessionManager, getWsServer } = deps;

  return async (wsMsg: WsInbound, clientId: string): Promise<void> => {
    const wsServer = getWsServer();

    switch (wsMsg.type) {
      case 'send_message': {
        const wsResult = await sessionManager.handleMessage(
          wsMsg.sessionId,
          clientId,
          wsMsg.content
        );
        wsServer?.broadcast({
          type: 'result',
          sessionId: wsResult.sessionId,
          content: wsResult.content,
          costUsd: wsResult.costUsd,
          durationMs: wsResult.durationMs
        });
        break;
      }
      case 'interrupt': {
        sessionManager.interruptSession(wsMsg.sessionId);
        break;
      }
      case 'status_request': {
        wsServer?.broadcast({
          type: 'result',
          sessionId: wsMsg.sessionId ?? 'global',
          content: JSON.stringify(stateSnapshot(), null, 2),
          durationMs: 0
        });
        break;
      }
      case 'list_sessions': {
        const stats = sessionManager.stats;
        wsServer?.broadcast({
          type: 'result',
          sessionId: 'list',
          content: JSON.stringify(stats),
          durationMs: 0
        });
        break;
      }
    }
  };
}
