// Branded types (P-84) — prevent SessionId/TaskId/MessageId confusion
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type SessionId = Brand<string, 'SessionId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type ChannelId = Brand<string, 'ChannelId'>;
export type UserId = Brand<string, 'UserId'>;

export function sessionId(raw: string): SessionId { return raw as SessionId; }
export function taskId(raw: string): TaskId { return raw as TaskId; }
export function messageId(raw: string): MessageId { return raw as MessageId; }
export function channelId(raw: string): ChannelId { return raw as ChannelId; }
export function userId(raw: string): UserId { return raw as UserId; }

// Message types
export interface ChatMessage {
  id: MessageId;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  sessionId: SessionId;
  metadata?: Record<string, unknown>;
}

// Session status
export type SessionStatus = 'idle' | 'running' | 'error' | 'stopped';

// Executor result
export interface ExecutorResult {
  sessionId: SessionId;
  content: string;
  costUsd?: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
}
