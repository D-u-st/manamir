// Session Rotation — prevents hallucination by cycling sessions (v2.1)
// After N turns or M minutes, rotate to a fresh session with a handoff summary.

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { log } from '../utils/logger';
import type { Session } from './session';
import type { SessionId } from '../types';
import { sessionId } from '../types';

export interface RotationConfig {
  enabled: boolean;
  maxTurns: number;       // rotate after this many turns (default 30)
  maxMinutes: number;     // rotate after this many minutes (default 20)
  handoffDir: string;     // directory for handoff files
}

export interface HandoffSummary {
  previousSessionId: string;
  newSessionId: string;
  timestamp: number;
  turnCount: number;
  durationMinutes: number;
  summary: string;        // what was done, what's pending, key context
  recentMessages: Array<{ role: string; content: string }>;
}

export class SessionRotator {
  private handoffDir: string;

  constructor(private config: RotationConfig) {
    this.handoffDir = resolve(config.handoffDir);
    if (!existsSync(this.handoffDir)) {
      mkdirSync(this.handoffDir, { recursive: true });
    }
  }

  /**
   * Check if a session should be rotated based on turn count or elapsed time.
   */
  shouldRotate(session: Session): boolean {
    if (!this.config.enabled) return false;

    const turnCount = this.getMessageCount(session);
    if (turnCount >= this.config.maxTurns) {
      log.info('SessionRotator: rotation triggered by turn count', {
        sessionId: session.id,
        turnCount,
        maxTurns: this.config.maxTurns
      });
      return true;
    }

    const elapsedMs = Date.now() - session.createdAt;
    const elapsedMinutes = elapsedMs / 60_000;
    if (elapsedMinutes >= this.config.maxMinutes) {
      log.info('SessionRotator: rotation triggered by time', {
        sessionId: session.id,
        elapsedMinutes: Math.round(elapsedMinutes),
        maxMinutes: this.config.maxMinutes
      });
      return true;
    }

    return false;
  }

  /**
   * Generate a handoff summary from the session's conversation history.
   * Captures recent messages and produces a text summary.
   */
  generateHandoff(session: Session): HandoffSummary {
    const history = session.getHistory();
    const turnCount = history.length;
    const elapsedMs = Date.now() - session.createdAt;

    // Take last 10 messages for context
    const recentMessages = history.slice(-10).map(msg => ({
      role: msg.role,
      content: msg.content.length > 500
        ? msg.content.slice(0, 500) + '...[truncated]'
        : msg.content
    }));

    // Build a text summary from the conversation
    const userMessages = history.filter(m => m.role === 'user');
    const assistantMessages = history.filter(m => m.role === 'assistant');

    const topics = userMessages
      .slice(-5)
      .map(m => m.content.length > 100 ? m.content.slice(0, 100) + '...' : m.content);

    const lastAssistant = assistantMessages.length > 0
      ? assistantMessages[assistantMessages.length - 1].content
      : '';
    const lastResponse = lastAssistant.length > 300
      ? lastAssistant.slice(0, 300) + '...'
      : lastAssistant;

    const summary = [
      `Session ${session.id} ran for ${Math.round(elapsedMs / 60_000)} minutes with ${turnCount} messages.`,
      topics.length > 0 ? `Recent topics: ${topics.join(' | ')}` : '',
      lastResponse ? `Last response: ${lastResponse}` : ''
    ].filter(Boolean).join('\n');

    return {
      previousSessionId: session.id,
      newSessionId: '', // filled in by caller
      timestamp: Date.now(),
      turnCount,
      durationMinutes: Math.round(elapsedMs / 60_000),
      summary,
      recentMessages
    };
  }

  /**
   * Save a handoff summary to disk.
   */
  saveHandoff(handoff: HandoffSummary): void {
    const filename = `${handoff.previousSessionId}.json`;
    const filepath = join(this.handoffDir, filename);
    writeFileSync(filepath, JSON.stringify(handoff, null, 2), 'utf-8');
    log.info('SessionRotator: handoff saved', { filepath });
  }

  /**
   * Load the most recent handoff for injection into a new session's system prompt.
   */
  loadLatestHandoff(): HandoffSummary | null {
    if (!existsSync(this.handoffDir)) return null;

    const files = readdirSync(this.handoffDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    try {
      const content = readFileSync(join(this.handoffDir, files[0]), 'utf-8');
      return JSON.parse(content) as HandoffSummary;
    } catch (err) {
      log.error('SessionRotator: failed to load handoff', { error: String(err) });
      return null;
    }
  }

  /**
   * Load a specific handoff by session ID.
   */
  loadHandoff(previousSessionId: string): HandoffSummary | null {
    const filepath = join(this.handoffDir, `${previousSessionId}.json`);
    if (!existsSync(filepath)) return null;

    try {
      const content = readFileSync(filepath, 'utf-8');
      return JSON.parse(content) as HandoffSummary;
    } catch (err) {
      log.error('SessionRotator: failed to load handoff', { error: String(err) });
      return null;
    }
  }

  /**
   * Format a handoff summary for injection into a system prompt.
   */
  formatForPrompt(handoff: HandoffSummary): string {
    const lines = [
      '# Previous Session Context',
      `This is a continuation from session ${handoff.previousSessionId}.`,
      `Previous session ran for ${handoff.durationMinutes} minutes with ${handoff.turnCount} messages.`,
      '',
      '## Summary',
      handoff.summary,
      '',
      '## Recent conversation',
    ];

    for (const msg of handoff.recentMessages) {
      const prefix = msg.role === 'user' ? 'User' : 'Assistant';
      lines.push(`**${prefix}**: ${msg.content}`);
    }

    return lines.join('\n');
  }

  private getMessageCount(session: Session): number {
    return session.getHistory().length;
  }
}
