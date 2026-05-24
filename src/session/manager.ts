// SessionManager — creates/tracks/cleans up sessions
// One session per channel (P-73 Session Persistence)
// Uses KeyedAsyncQueue for serial-per-session execution (P-64)
// Supports both auth (Claude CLI) and api (DeepSeek/OpenAI) backends

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { Session, type ExecutorBackend } from './session';
import { HistoryStore } from './history';
import { SessionRotator } from './rotation';
import { KeyedAsyncQueue } from '../queue/keyed-async-queue';
import { MemoryStore } from '../memory';
import { hooks } from '../hooks';
import { log } from '../utils/logger';
import type { ManamirConfig } from '../config';
import type { ExecutorResult } from '../types';
import { sessionId } from '../types';
import { buildSystemPrompt } from '../prompts/system';
import { FailoverExecutor, type ProviderConfig } from '../executor/failover';
import { toFunctionDefinitions, getTool } from '../tools';
import type { MessageEvent } from '../channel/types';
import {
  buildSessionKey,
  DEFAULT_ROUTING,
  type SessionRoutingConfig,
} from '../channel/session-router';

// Session map entry persisted to disk
interface SessionMapEntry {
  sessionId: string;
  channelId: string;
  userId: string;
  createdAt: number;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map(); // channelId → Session
  private queue: KeyedAsyncQueue = new KeyedAsyncQueue();
  private history: HistoryStore;
  private rotator: SessionRotator;
  private memoryStore: MemoryStore;
  private failoverExecutor: FailoverExecutor | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private sessionMapPath: string;

  private frozenMemorySnapshots: Map<string, string> = new Map();

  constructor(private config: ManamirConfig) {
    this.history = new HistoryStore(config.session.dataDir);
    this.sessionMapPath = join(config.session.dataDir, 'session-map.json');
    this.rotator = new SessionRotator({
      enabled: config.rotation.enabled,
      maxTurns: config.rotation.maxTurns,
      maxMinutes: config.rotation.maxMinutes,
      handoffDir: config.session.dataDir.replace(/sessions$/, 'handoffs')
    });
    this.memoryStore = new MemoryStore(config.memory);
  }

  start(): void {
    // Initialize FailoverExecutor if multiple providers configured
    const providers = this.config.executor.providers;
    if (providers && providers.length > 0) {
      this.failoverExecutor = new FailoverExecutor(providers, {
        maxTokens: this.config.executor.maxTokens,
        temperature: this.config.executor.temperature,
        timeoutMs: this.config.claude.maxTurnDurationMs,
        systemPrompt: this.config.executor.systemPrompt,
        maxTurns: this.config.executor.maxTurns
      });
      // Wire tools into all failover executors
      this.failoverExecutor.setTools(
        toFunctionDefinitions(),
        async (name, args) => {
          const tool = getTool(name);
          if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
          return tool.execute(args);
        }
      );
      log.info('SessionManager: failover executor initialized', {
        providers: providers.map(p => p.name)
      });
    }

    // Restore sessions from disk (P-73)
    this.restoreSessionMap();

    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 60_000);
    log.info('SessionManager: started', {
      dataDir: this.config.session.dataDir,
      backend: this.config.executor.type,
      restoredSessions: this.sessions.size
    });
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const session of this.sessions.values()) {
      session.destroy();
    }
    this.sessions.clear();
    this.frozenMemorySnapshots.clear();
    log.info('SessionManager: stopped');
  }

  async handleEvent(
    event: MessageEvent,
    routing: SessionRoutingConfig = DEFAULT_ROUTING
  ): Promise<ExecutorResult> {
    const key = buildSessionKey(event, routing);
    return this.handleMessage(key, event.userId, event.text);
  }

  async handleMessage(channelId: string, userId: string, content: string): Promise<ExecutorResult> {
    let session = this.getOrCreateSession(channelId, userId);

    // Check if session should be rotated before processing
    if (this.rotator.shouldRotate(session)) {
      session = this.rotateSession(channelId, userId, session);
    }

    return this.queue.enqueue(session.id, async () => {
      const result = await session.sendMessage(content);

      // Persist session map after each message
      this.saveSessionMap();

      // Auto-extract memories from conversation (P-16)
      this.autoExtractMemory(content, result.content);

      // Check rotation after message too
      if (this.rotator.shouldRotate(session)) {
        log.info('SessionManager: session marked for rotation on next message', {
          sessionId: session.id
        });
      }

      return result;
    });
  }

  getSession(channelId: string): Session | undefined {
    return this.sessions.get(channelId);
  }

  /** Read-only access to the HistoryStore (for browsing past sessions). */
  get historyStore(): HistoryStore {
    return this.history;
  }

  /**
   * Reassign an existing session ID to `channelId`, loading prior history
   * from the HistoryStore and seeding the new Session's executor with it.
   *
   * Returns the adopted Session, or null if no history exists for `sessionId`.
   *
   * Side effects:
   *   - Destroys any session currently bound to `channelId`.
   *   - Updates session-map.json so the adoption survives a restart.
   */
  adoptSession(channelId: string, userId: string, targetSessionId: string): Session | null {
    const id = sessionId(targetSessionId);
    const history = this.history.load(id);
    if (history.length === 0) {
      log.warn('SessionManager.adoptSession: no history for target', {
        targetSessionId,
        channelId,
      });
      return null;
    }

    // Destroy whatever session was on this channel — we're replacing it.
    const existing = this.sessions.get(channelId);
    if (existing) {
      this.frozenMemorySnapshots.delete(existing.id);
      existing.destroy();
      this.sessions.delete(channelId);
      hooks.emit('session:destroy', { sessionId: existing.id, channelId });
    }

    // Freeze a fresh memory snapshot for the adopted session.
    const snapshot = this.memoryStore.formatForPrompt();
    if (snapshot) {
      this.frozenMemorySnapshots.set(id, snapshot);
    }

    const backend = this.buildBackend(undefined, id);
    const session = new Session({
      id,
      channelId,
      userId,
      backend,
      history: this.history,
      maxHistoryMessages: this.config.session.maxHistoryMessages,
      externalExecutor: this.failoverExecutor ?? undefined,
    });

    // Seed the executor's conversation history so the next turn has context.
    session.preloadHistory(history);

    this.sessions.set(channelId, session);
    this.saveSessionMap();
    hooks.emit('session:adopt', {
      sessionId: id,
      channelId,
      userId,
      messageCount: history.length,
    });
    log.info('SessionManager: session adopted', {
      sessionId: id,
      channelId,
      messageCount: history.length,
    });

    return session;
  }

  interruptSession(channelId: string): boolean {
    const session = this.sessions.get(channelId);
    if (session) {
      session.interrupt();
      return true;
    }
    return false;
  }

  destroySession(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (session) {
      this.frozenMemorySnapshots.delete(session.id);
      session.destroy();
      this.sessions.delete(channelId);
      hooks.emit('session:destroy', { sessionId: session.id, channelId });
      log.info('SessionManager: session destroyed', { channelId });
    }
  }

  private getOrCreateSession(channelId: string, userId: string): Session {
    let session = this.sessions.get(channelId);

    if (session && session.status !== 'stopped') {
      return session;
    }

    const id = sessionId(`sw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    // Freeze memory snapshot at session creation — never reload mid-session
    // This preserves prompt cache (system prompt stays identical between turns)
    const snapshot = this.memoryStore.formatForPrompt();
    if (snapshot) {
      this.frozenMemorySnapshots.set(id, snapshot);
    }

    const backend = this.buildBackend(undefined, id);

    session = new Session({
      id,
      channelId,
      userId,
      backend,
      history: this.history,
      maxHistoryMessages: this.config.session.maxHistoryMessages,
      externalExecutor: this.failoverExecutor ?? undefined
    });

    this.sessions.set(channelId, session);
    this.saveSessionMap();
    hooks.emit('session:create', { sessionId: id, channelId, userId });
    log.info('SessionManager: new session', {
      sessionId: id,
      channelId,
      userId,
      backend: this.config.executor.type
    });

    return session;
  }

  private rotateSession(channelId: string, userId: string, oldSession: Session): Session {
    // CRITICAL ORDER (Bug 6 fix): delete OLD session's frozen snapshot BEFORE
    // creating any new session resources, to prevent memory leak if any
    // subsequent step throws.
    const hadOldSnapshot = this.frozenMemorySnapshots.delete(oldSession.id);
    if (hadOldSnapshot) {
      log.info('SessionManager: cleared frozen snapshot for rotated session', {
        oldSessionId: oldSession.id
      });
    }

    // Generate and save handoff
    const handoff = this.rotator.generateHandoff(oldSession);
    const newId = sessionId(`sw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    handoff.newSessionId = newId;
    this.rotator.saveHandoff(handoff);

    // Destroy old session
    oldSession.destroy();
    this.sessions.delete(channelId);

    // Freeze memory snapshot for new session
    const snapshot = this.memoryStore.formatForPrompt();
    if (snapshot) {
      this.frozenMemorySnapshots.set(newId, snapshot);
    }

    // Create new session with handoff context
    const backend = this.buildBackend(handoff.previousSessionId, newId);
    const newSession = new Session({
      id: newId,
      channelId,
      userId,
      backend,
      history: this.history,
      maxHistoryMessages: this.config.session.maxHistoryMessages,
      externalExecutor: this.failoverExecutor ?? undefined
    });

    this.sessions.set(channelId, newSession);
    hooks.emit('session:rotate', {
      oldSessionId: oldSession.id,
      newSessionId: newId,
      channelId
    });
    log.info('SessionManager: session rotated', {
      oldSessionId: oldSession.id,
      newSessionId: newId,
      channelId
    });

    return newSession;
  }

  private buildBackend(previousSessionId?: string, sessionId?: string): ExecutorBackend {
    const cfg = this.config.executor;

    if (cfg.type === 'api') {
      // Use frozen snapshot if available, otherwise load fresh
      const memoryContext = (sessionId && this.frozenMemorySnapshots.get(sessionId))
        || this.memoryStore.formatForPrompt();
      let handoffContext: string | undefined;
      if (previousSessionId) {
        const handoff = this.rotator.loadHandoff(previousSessionId);
        if (handoff) {
          handoffContext = this.rotator.formatForPrompt(handoff);
        }
      }

      // Use explicit SYSTEM_PROMPT env var if set, otherwise build from prompt config
      const systemPrompt = cfg.systemPrompt || buildSystemPrompt({
        name: this.config.prompt.name,
        serverContext: this.config.prompt.serverContext,
        extraInstructions: this.config.prompt.extraInstructions,
        memoryContext: memoryContext || undefined,
        handoffContext
      });

      return {
        type: 'api',
        options: {
          apiKey: cfg.apiKey!,
          baseUrl: cfg.baseUrl!,
          model: cfg.model!,
          maxTokens: cfg.maxTokens,
          temperature: cfg.temperature,
          timeoutMs: this.config.claude.maxTurnDurationMs,
          systemPrompt
        }
      };
    }

    return {
      type: 'auth',
      options: {
        cliPath: this.config.claude.cliPath,
        model: this.config.claude.model,
        maxTurns: this.config.claude.maxTurns,
        timeoutMs: this.config.claude.maxTurnDurationMs
      }
    };
  }

  private cleanupIdleSessions(): void {
    const timeout = this.config.session.idleTimeoutMs;
    let cleaned = 0;

    for (const [channelId, session] of this.sessions) {
      if (session.status === 'idle' && session.idleDurationMs > timeout) {
        this.frozenMemorySnapshots.delete(session.id);
        session.destroy();
        this.sessions.delete(channelId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log.info('SessionManager: cleaned idle sessions', { count: cleaned });
    }
  }

  get stats(): { activeSessions: number; queuedKeys: number } {
    return {
      activeSessions: this.sessions.size,
      queuedKeys: this.queue.activeKeys
    };
  }

  // --- Session Map Persistence (P-73) ---

  private saveSessionMap(): void {
    const entries: SessionMapEntry[] = [];
    for (const [channelId, session] of this.sessions) {
      if (session.status !== 'stopped') {
        entries.push({
          sessionId: session.id,
          channelId,
          userId: session.userId,
          createdAt: session.createdAt
        });
      }
    }
    try {
      const dir = dirname(this.sessionMapPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.sessionMapPath, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (err) {
      log.warn('Failed to save session map', { error: String(err) });
    }
  }

  private restoreSessionMap(): void {
    if (!existsSync(this.sessionMapPath)) return;

    try {
      const data = readFileSync(this.sessionMapPath, 'utf-8');
      const entries: SessionMapEntry[] = JSON.parse(data);

      for (const entry of entries) {
        // Check if session history exists
        const historyMessages = this.history.load(sessionId(entry.sessionId), 1);
        if (historyMessages.length === 0) continue; // No history, skip

        const backend = this.buildBackend();
        const session = new Session({
          id: sessionId(entry.sessionId),
          channelId: entry.channelId,
          userId: entry.userId,
          backend,
          history: this.history,
          maxHistoryMessages: this.config.session.maxHistoryMessages,
          externalExecutor: this.failoverExecutor ?? undefined
        });

        this.sessions.set(entry.channelId, session);
        log.info('SessionManager: restored session', {
          sessionId: entry.sessionId,
          channelId: entry.channelId
        });
      }
    } catch (err) {
      log.warn('Failed to restore session map', { error: String(err) });
    }
  }

  // --- Auto Memory Extraction (P-16) ---

  private autoExtractMemory(userMessage: string, assistantResponse: string): void {
    // Simple keyword-based extraction — no LLM call needed
    const combined = userMessage + ' ' + assistantResponse;

    // Detect todolist/reminder patterns
    if (/todo|remind|记住|备忘|待办/i.test(combined) && assistantResponse.length > 10) {
      this.memoryStore.save({
        name: `todo-${Date.now()}`,
        description: userMessage.slice(0, 80),
        type: 'project',
        content: `User request: ${userMessage}\nResult: ${assistantResponse.slice(0, 200)}`,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      log.info('Auto-extracted memory: todo/reminder');
    }

    // Detect preference/feedback patterns
    if (/不要|别|停止|don't|stop|prefer|偏好|习惯/i.test(userMessage)) {
      this.memoryStore.save({
        name: `feedback-${Date.now()}`,
        description: userMessage.slice(0, 80),
        type: 'feedback',
        content: userMessage,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      log.info('Auto-extracted memory: feedback');
    }

    // Detect project/context patterns
    if (/项目|project|部署|deploy|服务器|server|配置|config/i.test(combined) && assistantResponse.length > 50) {
      this.memoryStore.save({
        name: `project-${Date.now()}`,
        description: userMessage.slice(0, 80),
        type: 'project',
        content: `${userMessage}\n---\n${assistantResponse.slice(0, 300)}`,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      log.info('Auto-extracted memory: project context');
    }
  }
}
