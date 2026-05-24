// Daily log + distillation (P-22)
// Appends key events to data/logs/daily-YYYY-MM-DD.jsonl
// Hooks into executor:complete, executor:error, session:rotate, shutdown
// Generates distilled summary at midnight (or first morning tick)

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { log } from '../utils/logger';
import { hooks } from '../hooks';
import type { HookEvent } from '../hooks';
import type { MemoryStore } from '../memory/store';

export interface DailyLogEntry {
  ts: number;
  event: string;
  data: Record<string, unknown>;
}

export interface DailyLogOptions {
  logDir: string;
  memoryStore?: MemoryStore;
}

export class DailyLog {
  private logDir: string;
  private memoryStore: MemoryStore | null;
  private lastDistillDate: string | null = null;
  private dayStats = { tasks: 0, errors: 0, rotations: 0, memorySaves: 0, totalCostUsd: 0 };

  constructor(opts: DailyLogOptions) {
    this.logDir = resolve(opts.logDir);
    this.memoryStore = opts.memoryStore ?? null;

    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  /** Wire into the hook system to auto-capture events */
  wireHooks(): void {
    const handler = (event: HookEvent, data: Record<string, unknown>) => {
      switch (event) {
        case 'executor:complete':
          this.dayStats.tasks++;
          this.append('task_complete', {
            sessionId: data.sessionId,
            durationMs: data.durationMs,
            costUsd: data.costUsd
          });
          if (typeof data.costUsd === 'number') {
            this.dayStats.totalCostUsd += data.costUsd;
          }
          break;
        case 'executor:error':
          this.dayStats.errors++;
          this.append('error', {
            sessionId: data.sessionId,
            error: data.error
          });
          break;
        case 'session:rotate':
          this.dayStats.rotations++;
          this.append('session_rotate', {
            oldSessionId: data.oldSessionId,
            newSessionId: data.newSessionId
          });
          break;
        case 'shutdown':
          this.append('shutdown', { signal: data.signal });
          break;
      }
    };

    hooks.on('executor:complete', handler);
    hooks.on('executor:error', handler);
    hooks.on('session:rotate', handler);
    hooks.on('shutdown', handler);

    log.info('DailyLog: hooks wired');
  }

  /** Append an event to today's log file */
  append(event: string, data: Record<string, unknown> = {}): void {
    const entry: DailyLogEntry = { ts: Date.now(), event, data };
    const dateStr = this.todayStr();
    const filepath = join(this.logDir, `daily-${dateStr}.jsonl`);

    try {
      appendFileSync(filepath, JSON.stringify(entry) + '\n');
    } catch (err) {
      log.error('DailyLog: write failed', { error: String(err) });
    }
  }

  /** Check if we should distill yesterday's log (call on each cron tick) */
  checkDistill(): void {
    const today = this.todayStr();

    // If we haven't distilled yet today, distill yesterday
    if (this.lastDistillDate !== today) {
      const yesterday = this.yesterdayStr();
      this.distill(yesterday);
      this.lastDistillDate = today;
      // Reset day stats for the new day
      this.dayStats = { tasks: 0, errors: 0, rotations: 0, memorySaves: 0, totalCostUsd: 0 };
    }
  }

  /** Distill a day's log into a summary and save as memory */
  private distill(dateStr: string): void {
    const filepath = join(this.logDir, `daily-${dateStr}.jsonl`);
    if (!existsSync(filepath)) {
      log.info('DailyLog: no log to distill', { date: dateStr });
      return;
    }

    try {
      const raw = readFileSync(filepath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const entries: DailyLogEntry[] = lines.map(l => JSON.parse(l));

      // Aggregate stats
      let tasks = 0;
      let errors = 0;
      let rotations = 0;
      let totalCost = 0;
      const errorMessages: string[] = [];

      for (const entry of entries) {
        switch (entry.event) {
          case 'task_complete':
            tasks++;
            if (typeof entry.data.costUsd === 'number') totalCost += entry.data.costUsd;
            break;
          case 'error':
            errors++;
            if (entry.data.error) errorMessages.push(String(entry.data.error).slice(0, 80));
            break;
          case 'session_rotate':
            rotations++;
            break;
        }
      }

      const summary = [
        `Daily summary ${dateStr}: ${tasks} tasks completed, ${errors} errors, ${rotations} session rotations, $${totalCost.toFixed(3)} spent.`,
        errors > 0 ? `Errors: ${errorMessages.slice(0, 3).join('; ')}` : null
      ].filter(Boolean).join('\n');

      // Save as memory if store available
      if (this.memoryStore) {
        this.memoryStore.save({
          name: `daily-summary-${dateStr}`,
          description: `Daily activity summary for ${dateStr}`,
          type: 'project',
          content: summary,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        log.info('DailyLog: distilled and saved to memory', { date: dateStr, tasks, errors });
      } else {
        log.info('DailyLog: distilled (no memory store)', { date: dateStr, summary });
      }
    } catch (err) {
      log.error('DailyLog: distill failed', { date: dateStr, error: String(err) });
    }
  }

  getStats(): typeof this.dayStats {
    return { ...this.dayStats };
  }

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private yesterdayStr(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
}
