// WebSocket server for remote control (P-28 + P-56)
// Uses Node 'ws' package (not Bun)
// NDJSON protocol, token-based auth, heartbeat ping/pong

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { SessionId } from '../types';
import { log } from '../utils/logger';

// --- Inbound message types ---

export interface WsSendMessage {
  type: 'send_message';
  sessionId: string;
  content: string;
}

export interface WsInterrupt {
  type: 'interrupt';
  sessionId: string;
}

export interface WsStatusRequest {
  type: 'status_request';
  sessionId?: string;
}

export interface WsListSessions {
  type: 'list_sessions';
}

export type WsInbound = WsSendMessage | WsInterrupt | WsStatusRequest | WsListSessions;

// --- Outbound message types ---

export interface WsTextStream {
  type: 'text_stream';
  sessionId: string;
  content: string;
}

export interface WsToolUse {
  type: 'tool_use';
  sessionId: string;
  tool: string;
  input: unknown;
}

export interface WsProgress {
  type: 'progress';
  sessionId: string;
  stage: string;
  percentage: number;
  action: string;
}

export interface WsResult {
  type: 'result';
  sessionId: string;
  content: string;
  costUsd?: number;
  durationMs: number;
}

export interface WsError {
  type: 'error';
  message: string;
  code?: string;
}

export type WsOutbound = WsTextStream | WsToolUse | WsProgress | WsResult | WsError;

// --- Handler interface ---

export type WsMessageHandler = (msg: WsInbound, clientId: string) => void | Promise<void>;

// --- Per-client state ---

interface ClientState {
  id: string;
  authenticated: boolean;
  lastPong: number;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;

export interface WsServerOptions {
  port?: number;
  authToken?: string;
}

export class WsServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private handler: WsMessageHandler | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private clientCounter = 0;
  private port: number;
  private authToken: string | null;
  private clients = new Map<WebSocket, ClientState>();

  constructor(opts: WsServerOptions = {}) {
    this.port = opts.port ?? Number(process.env.WS_PORT) ?? 7777;
    this.authToken = opts.authToken ?? process.env.WS_AUTH_TOKEN ?? null;
  }

  /** Register a handler for incoming WebSocket messages */
  onMessage(handler: WsMessageHandler): void {
    this.handler = handler;
  }

  /** Start the WebSocket server */
  start(): void {
    if (this.httpServer) return;

    this.httpServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    this.wss = new WebSocketServer({ noServer: true });

    // Handle HTTP upgrade on /ws path
    this.httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://localhost:${this.port}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws) => {
      const clientId = `ws-${++this.clientCounter}`;
      const state: ClientState = {
        id: clientId,
        authenticated: !this.authToken,
        lastPong: Date.now()
      };
      this.clients.set(ws, state);

      log.info('WS client connected', { clientId });

      if (this.authToken) {
        ws.send(JSON.stringify({ type: 'auth_required' }) + '\n');
      }

      ws.on('message', async (rawMsg) => {
        const text = typeof rawMsg === 'string' ? rawMsg : rawMsg.toString('utf-8');

        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' } satisfies WsError) + '\n');
            continue;
          }

          // Auth handling
          if (!state.authenticated) {
            if (parsed.type === 'auth' && typeof parsed.token === 'string') {
              if (parsed.token === this.authToken) {
                state.authenticated = true;
                ws.send(JSON.stringify({ type: 'auth_ok' }) + '\n');
                log.info('WS client authenticated', { clientId });
              } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid token', code: 'AUTH_FAILED' } satisfies WsError) + '\n');
                ws.close(4001, 'Authentication failed');
              }
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated', code: 'AUTH_REQUIRED' } satisfies WsError) + '\n');
            }
            continue;
          }

          // Pong response
          if (parsed.type === 'pong') {
            state.lastPong = Date.now();
            continue;
          }

          // Route to handler
          if (this.handler) {
            try {
              await this.handler(parsed as unknown as WsInbound, state.id);
            } catch (err) {
              log.error('WS handler error', { error: String(err), clientId: state.id });
              ws.send(JSON.stringify({ type: 'error', message: 'Internal error' } satisfies WsError) + '\n');
            }
          }
        }
      });

      ws.on('close', () => {
        log.info('WS client disconnected', { clientId });
        this.clients.delete(ws);
      });

      ws.on('error', (err) => {
        log.error('WS client error', { clientId, error: String(err) });
      });
    });

    // Heartbeat: send ping every 30s, prune dead clients
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const pingData = JSON.stringify({ type: 'ping', ts: now }) + '\n';
      for (const [ws, state] of this.clients) {
        if (!state.authenticated) continue;
        if (now - state.lastPong > PONG_TIMEOUT_MS) {
          log.info('WS client timed out, closing', { clientId: state.id });
          ws.close(4002, 'Pong timeout');
          this.clients.delete(ws);
          continue;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(pingData);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    this.httpServer.listen(this.port, () => {
      log.info(`WS server listening on port ${this.port}`);
    });
  }

  /** Broadcast a message to all authenticated, connected clients */
  broadcast(msg: WsOutbound): void {
    if (!this.wss) return;
    const data = JSON.stringify(msg) + '\n';
    for (const [ws, state] of this.clients) {
      if (state.authenticated && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  /** Stop the server */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.wss) {
      for (const [ws] of this.clients) {
        ws.close(1001, 'Server shutting down');
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
      log.info('WS server stopped');
    }
  }

  /** Get the port the server is listening on */
  getPort(): number {
    return this.port;
  }

  /** Get the underlying HTTP server */
  getHttpServer(): http.Server | null {
    return this.httpServer;
  }
}
