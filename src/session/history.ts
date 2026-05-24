// Session history storage (P-73)
// JSONL files per session — append-only, atomic writes
// data/sessions/<sessionId>.jsonl

import { existsSync, mkdirSync, readFileSync, appendFileSync, statSync } from 'fs';
import { join } from 'path';
import { log } from '../utils/logger';
import type { ChatMessage, SessionId } from '../types';

export interface SessionPreview {
  messageCount: number;
  firstMessage: number; // unix ms timestamp of the first message, or 0 if none
  lastActivity: number; // unix ms timestamp of the last message, or 0 if none
  firstUser: string;    // first user message content (empty if none)
  firstAssistant: string; // first assistant message content (empty if none)
}

export class HistoryStore {
  constructor(private dataDir: string) {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
  }

  private sessionPath(sessionId: SessionId): string {
    return join(this.dataDir, `${sessionId}.jsonl`);
  }

  append(message: ChatMessage): void {
    const path = this.sessionPath(message.sessionId);
    const line = JSON.stringify(message) + '\n';
    try {
      appendFileSync(path, line, 'utf-8');
    } catch (err) {
      log.error('Failed to append to history', {
        sessionId: message.sessionId,
        error: String(err)
      });
    }
  }

  load(sessionId: SessionId, limit?: number): ChatMessage[] {
    const path = this.sessionPath(sessionId);
    if (!existsSync(path)) return [];

    try {
      const content = readFileSync(path, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const messages = lines.map(line => JSON.parse(line) as ChatMessage);

      if (limit && messages.length > limit) {
        return messages.slice(-limit);
      }
      return messages;
    } catch (err) {
      log.error('Failed to load history', { sessionId, error: String(err) });
      return [];
    }
  }

  getMessageCount(sessionId: SessionId): number {
    const path = this.sessionPath(sessionId);
    if (!existsSync(path)) return 0;

    try {
      const content = readFileSync(path, 'utf-8');
      return content.trim().split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  listSessions(): SessionId[] {
    if (!existsSync(this.dataDir)) return [];

    try {
      const { readdirSync } = require('fs');
      const files = readdirSync(this.dataDir) as string[];
      return files
        .filter((f: string) => f.endsWith('.jsonl'))
        .map((f: string) => f.replace('.jsonl', '') as SessionId);
    } catch {
      return [];
    }
  }

  /**
   * Read the JSONL for `sessionId` and return a lightweight summary suitable
   * for a session-picker UI. Reads the whole file (sessions are usually small);
   * falls back to file mtime for lastActivity if the file has no parseable
   * messages but does exist.
   *
   * Returns a zeroed SessionPreview if the file does not exist.
   */
  getSessionPreview(sessionId: SessionId): SessionPreview {
    const path = this.sessionPath(sessionId);
    const empty: SessionPreview = {
      messageCount: 0,
      firstMessage: 0,
      lastActivity: 0,
      firstUser: '',
      firstAssistant: '',
    };
    if (!existsSync(path)) return empty;

    try {
      const content = readFileSync(path, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      const messages: ChatMessage[] = [];
      for (const line of lines) {
        try {
          messages.push(JSON.parse(line) as ChatMessage);
        } catch {
          // Skip malformed lines — partial writes shouldn't crash the picker.
        }
      }

      if (messages.length === 0) {
        // File exists but no valid messages — use file mtime as a hint.
        let mtime = 0;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          // ignore
        }
        return { ...empty, lastActivity: mtime };
      }

      const firstMessage = messages[0].timestamp || 0;
      const lastActivity = messages[messages.length - 1].timestamp || firstMessage;
      const firstUserMsg = messages.find((m) => m.role === 'user');
      const firstAssistantMsg = messages.find((m) => m.role === 'assistant');

      return {
        messageCount: messages.length,
        firstMessage,
        lastActivity,
        firstUser: firstUserMsg?.content ?? '',
        firstAssistant: firstAssistantMsg?.content ?? '',
      };
    } catch (err) {
      log.warn('HistoryStore.getSessionPreview: failed to read', {
        sessionId,
        error: String(err),
      });
      return empty;
    }
  }
}
