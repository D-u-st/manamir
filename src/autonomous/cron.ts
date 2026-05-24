// Cron serialization (legacy setInterval-based Cron + minimal 5-field cron parser).
//
// History: this file used to also house a "Hardened CronScheduler" subsystem
// (file-lock, pre-advance, persistent state) that was never wired into any
// entry point. v2.3.0 audit removed it (-205 LOC). The bottom-of-file
// `nextCronMatch` parser is still used by user-cron.ts for cron-string
// validation + next-run computation, so it stays.

import { log } from '../utils/logger';

// ---------------------------------------------------------------------------
// Legacy Cron (kept for back-compat)
// ---------------------------------------------------------------------------

export interface CronJobInfo {
  name: string;
  intervalMs: number;
  lastRunTime: number | null;
  nextRunTime: number;
  runCount: number;
  lastError: string | null;
}

interface CronJobInternal {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
  timer: ReturnType<typeof setInterval> | null;
  lastRunTime: number | null;
  nextRunTime: number;
  runCount: number;
  lastError: string | null;
}

export class Cron {
  private jobs = new Map<string, CronJobInternal>();
  private chain: Promise<void> = Promise.resolve();

  addJob(name: string, intervalMs: number, fn: () => Promise<void>): void {
    if (this.jobs.has(name)) this.removeJob(name);
    const now = Date.now();
    const job: CronJobInternal = {
      name,
      intervalMs,
      fn,
      timer: null,
      lastRunTime: null,
      nextRunTime: now + intervalMs,
      runCount: 0,
      lastError: null,
    };
    job.timer = setInterval(() => this.enqueue(job), intervalMs);
    this.jobs.set(name, job);
    log.info('Cron job added', { name, intervalMs });
  }

  removeJob(name: string): void {
    const job = this.jobs.get(name);
    if (!job) return;
    if (job.timer) clearInterval(job.timer);
    this.jobs.delete(name);
    log.info('Cron job removed', { name });
  }

  getJob(name: string): CronJobInfo | null {
    const job = this.jobs.get(name);
    if (!job) return null;
    return {
      name: job.name,
      intervalMs: job.intervalMs,
      lastRunTime: job.lastRunTime,
      nextRunTime: job.nextRunTime,
      runCount: job.runCount,
      lastError: job.lastError,
    };
  }

  listJobs(): CronJobInfo[] {
    return [...this.jobs.values()].map((j) => ({
      name: j.name,
      intervalMs: j.intervalMs,
      lastRunTime: j.lastRunTime,
      nextRunTime: j.nextRunTime,
      runCount: j.runCount,
      lastError: j.lastError,
    }));
  }

  stopAll(): void {
    for (const [name] of this.jobs) this.removeJob(name);
  }

  private enqueue(job: CronJobInternal): void {
    this.chain = this.chain.then(async () => {
      const start = Date.now();
      try {
        await job.fn();
        job.lastError = null;
      } catch (err) {
        job.lastError = String(err);
        log.error(`Cron job "${job.name}" failed`, { error: job.lastError });
      }
      job.lastRunTime = start;
      job.runCount++;
      job.nextRunTime = Date.now() + job.intervalMs;
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it — still alive.
    return code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Minimal 5-field cron parser: "M H D M DOW"
// Supports: "*", single numbers, comma lists ("1,15,30"), and "*/N" steps.
// No ranges (1-5) or named months/days — enough for common reminder jobs.
// ---------------------------------------------------------------------------

interface CronField {
  values: Set<number> | null;  // null = wildcard
}

function parseField(spec: string, min: number, max: number): CronField {
  if (spec === '*') return { values: null };
  const values = new Set<number>();
  for (const part of spec.split(',')) {
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step <= 0) {
        throw new Error(`bad cron step: ${part}`);
      }
      for (let n = min; n <= max; n += step) values.add(n);
    } else {
      const n = parseInt(part, 10);
      if (isNaN(n) || n < min || n > max) {
        throw new Error(`bad cron value: ${part} (expected ${min}-${max})`);
      }
      values.add(n);
    }
  }
  return { values };
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.values === null || field.values.has(value);
}

export function nextCronMatch(expression: string, from: number): number {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got: "${expression}"`);
  }
  const minuteF = parseField(parts[0], 0, 59);
  const hourF = parseField(parts[1], 0, 23);
  const domF = parseField(parts[2], 1, 31);
  const monthF = parseField(parts[3], 1, 12);
  const dowF = parseField(parts[4], 0, 6);

  // Start from the next minute boundary to avoid re-firing in the same minute.
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  // Scan forward up to 4 years (covers leap-day edge cases).
  const limit = from + 4 * 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() < limit) {
    const month = d.getMonth() + 1;
    const dom = d.getDate();
    const dow = d.getDay();
    const hour = d.getHours();
    const minute = d.getMinutes();
    if (
      fieldMatches(monthF, month) &&
      fieldMatches(domF, dom) &&
      fieldMatches(dowF, dow) &&
      fieldMatches(hourF, hour) &&
      fieldMatches(minuteF, minute)
    ) {
      return d.getTime();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error(`no cron match within 4 years for: "${expression}"`);
}
