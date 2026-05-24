// User-defined cron entries that schedule autonomous tasks.
//
// Storage: <dataDir>/cron.json — JSON array, hand-editable.
//   [{ name, schedule, prompt, enabled, lastRunAt?, lastError?, runCount? }]
//
// Schedule format: 5-field cron expression (min hour dom month dow), parsed
// by the existing `nextCronMatch` from src/autonomous/cron.ts. Wildcards
// "*" and step "*/N" supported, plus comma lists. No ranges (1-5).
//
// On schedule fire we add a Scheduler task with the configured prompt; the
// autonomous worker picks it up exactly like any other task.

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic-write';
import { log } from '../utils/logger';
import { nextCronMatch } from './cron';
import type { Scheduler } from './scheduler';

export interface UserCronEntry {
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastError?: string | null;
  runCount?: number;
}

export interface UserCronOptions {
  dataDir: string;
  scheduler: Scheduler;
  /** Tick interval in ms. Defaults to 30s. */
  tickMs?: number;
}

const FILENAME = 'cron.json';
const DEFAULT_TICK_MS = 30_000;

/**
 * Validate a cron entry's shape and schedule. Returns null if invalid.
 * Used by both the loader and the CLI/Discord add command.
 */
export function validateCronEntry(raw: unknown): UserCronEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  const schedule = typeof r.schedule === 'string' ? r.schedule.trim() : '';
  const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
  const enabled = r.enabled === undefined ? true : Boolean(r.enabled);
  if (!name || !schedule || !prompt) return null;
  // Check the schedule actually parses.
  try {
    nextCronMatch(schedule, Date.now());
  } catch {
    return null;
  }
  const out: UserCronEntry = {
    name,
    schedule,
    prompt,
    enabled,
    nextRunAt: typeof r.nextRunAt === 'number' ? r.nextRunAt : undefined,
    lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : undefined,
    lastError: typeof r.lastError === 'string' ? r.lastError : null,
    runCount: typeof r.runCount === 'number' ? r.runCount : 0
  };
  return out;
}

export class UserCron {
  private readonly filePath: string;
  private readonly scheduler: Scheduler;
  private readonly tickMs: number;
  private entries: Map<string, UserCronEntry> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: UserCronOptions) {
    if (!existsSync(opts.dataDir)) {
      mkdirSync(opts.dataDir, { recursive: true });
    }
    this.filePath = join(opts.dataDir, FILENAME);
    this.scheduler = opts.scheduler;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.load();
  }

  /** Read cron.json from disk. Tolerant of missing/corrupt file. */
  load(): { loaded: number; rejected: number } {
    this.entries.clear();
    if (!existsSync(this.filePath)) return { loaded: 0, rejected: 0 };
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      log.warn('UserCron: failed to read cron.json', { error: String(err) });
      return { loaded: 0, rejected: 0 };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn('UserCron: failed to parse cron.json', { error: String(err) });
      return { loaded: 0, rejected: 0 };
    }
    if (!Array.isArray(parsed)) return { loaded: 0, rejected: 0 };
    let rejected = 0;
    const now = Date.now();
    for (const item of parsed) {
      const entry = validateCronEntry(item);
      if (!entry) {
        rejected++;
        continue;
      }
      // Recompute nextRunAt if missing — first scheduled time after now.
      if (entry.nextRunAt === undefined) {
        try {
          entry.nextRunAt = nextCronMatch(entry.schedule, now);
        } catch {
          rejected++;
          continue;
        }
      }
      this.entries.set(entry.name, entry);
    }
    log.info('UserCron: loaded', { count: this.entries.size, rejected });
    return { loaded: this.entries.size, rejected };
  }

  /** Persist current entries to cron.json (atomic). */
  save(): void {
    const out = [...this.entries.values()];
    atomicWriteSync(this.filePath, JSON.stringify(out, null, 2), false);
  }

  list(): UserCronEntry[] {
    return [...this.entries.values()];
  }

  get(name: string): UserCronEntry | undefined {
    return this.entries.get(name);
  }

  /** Add (or replace) a cron entry. Returns false if the schedule is invalid. */
  add(name: string, schedule: string, prompt: string, enabled = true): boolean {
    const candidate = validateCronEntry({ name, schedule, prompt, enabled });
    if (!candidate) return false;
    try {
      candidate.nextRunAt = nextCronMatch(schedule, Date.now());
    } catch {
      return false;
    }
    this.entries.set(name, candidate);
    this.save();
    log.info('UserCron: entry added', { name, schedule });
    return true;
  }

  /** Remove an entry by name. Returns false if it didn't exist. */
  remove(name: string): boolean {
    const removed = this.entries.delete(name);
    if (removed) this.save();
    return removed;
  }

  /** Enable / disable in place. */
  setEnabled(name: string, enabled: boolean): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    entry.enabled = enabled;
    this.save();
    return true;
  }

  /** Run a single tick — fires any due entries. Pure, callable from tests. */
  tick(now: number = Date.now()): { fired: string[] } {
    const fired: string[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.enabled) continue;
      if (entry.nextRunAt === undefined) {
        try {
          entry.nextRunAt = nextCronMatch(entry.schedule, now);
        } catch (err) {
          entry.lastError = `bad schedule: ${String(err)}`;
          entry.enabled = false;
          continue;
        }
      }
      if (entry.nextRunAt > now) continue;

      // Pre-advance BEFORE firing so a crash doesn't double-fire.
      try {
        entry.nextRunAt = nextCronMatch(entry.schedule, now);
      } catch (err) {
        entry.lastError = `next-run failed: ${String(err)}`;
        entry.enabled = false;
        this.save();
        continue;
      }
      entry.lastRunAt = now;
      entry.runCount = (entry.runCount ?? 0) + 1;
      entry.lastError = null;

      this.scheduler.addTask(entry.prompt, {
        metadata: {
          source: 'user-cron',
          cronName: entry.name,
          schedule: entry.schedule
        }
      });
      fired.push(entry.name);
    }
    if (fired.length > 0) this.save();
    return { fired };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.error('UserCron: tick threw', { error: String(err) });
      }
    }, this.tickMs);
    // Allow the process to exit while the timer is pending.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    log.info('UserCron: started', { tickMs: this.tickMs, entries: this.entries.size });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
