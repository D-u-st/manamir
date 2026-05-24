// Global state singleton (P-25 dual-layer state)
// Import-DAG leaf node — no imports from other core/ modules

import type { SessionId, SessionStatus } from '../types';
import type { ManamirConfig } from '../config';

export interface SessionEntry {
  id: SessionId;
  channelId: string;
  userId: string;
  status: SessionStatus;
  createdAt: number;
  lastActivity: number;
  claudeSessionId: string | null;
}

export interface GlobalState {
  // Boot info
  startedAt: number;
  pid: number;

  // Config reference
  config: ManamirConfig | null;

  // Session registry
  sessions: Map<SessionId, SessionEntry>;

  // Executor tracking
  activeExecutorCount: number;
  totalExecutions: number;

  // Cost tracking
  totalCostUsd: number;
  sessionCosts: Map<SessionId, number>;

  // Rate limiting
  lastExecutionAt: number;

  // Health
  lastHeartbeat: number;
  isShuttingDown: boolean;

  // Metrics
  totalMessages: number;
  totalErrors: number;
  uptimeMs: () => number;
}

function createState(): GlobalState {
  const startedAt = Date.now();

  return {
    startedAt,
    pid: process.pid,
    config: null,
    sessions: new Map(),
    activeExecutorCount: 0,
    totalExecutions: 0,
    totalCostUsd: 0,
    sessionCosts: new Map(),
    lastExecutionAt: 0,
    lastHeartbeat: Date.now(),
    isShuttingDown: false,
    totalMessages: 0,
    totalErrors: 0,
    uptimeMs: () => Date.now() - startedAt
  };
}

// Singleton — one per process
export const state: GlobalState = createState();

// Session registry helpers
export function registerSession(entry: SessionEntry): void {
  state.sessions.set(entry.id, entry);
}

export function unregisterSession(id: SessionId): boolean {
  state.sessionCosts.delete(id);
  return state.sessions.delete(id);
}

export function getSession(id: SessionId): SessionEntry | undefined {
  return state.sessions.get(id);
}

export function trackCost(sessionId: SessionId, costUsd: number): void {
  state.totalCostUsd += costUsd;
  const prev = state.sessionCosts.get(sessionId) ?? 0;
  state.sessionCosts.set(sessionId, prev + costUsd);
}

export function trackExecution(start: boolean): void {
  if (start) {
    state.activeExecutorCount++;
    state.totalExecutions++;
    state.lastExecutionAt = Date.now();
  } else {
    state.activeExecutorCount = Math.max(0, state.activeExecutorCount - 1);
  }
}

export function trackError(): void {
  state.totalErrors++;
}

export function trackMessage(): void {
  state.totalMessages++;
}

// Snapshot for status reporting
export function stateSnapshot(): Record<string, unknown> {
  return {
    uptimeMs: state.uptimeMs(),
    pid: state.pid,
    sessions: state.sessions.size,
    activeExecutors: state.activeExecutorCount,
    totalExecutions: state.totalExecutions,
    totalCostUsd: state.totalCostUsd,
    totalMessages: state.totalMessages,
    totalErrors: state.totalErrors,
    isShuttingDown: state.isShuttingDown
  };
}
