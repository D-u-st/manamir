// Stream watchdog (v2.6.0): per-model stall detection
//
// timeouts. DeepSeek can
// genuinely take 90s+ between tokens on cold loads, and reasoner pauses for
// thinking. Single fixed threshold either too aggressive (kills slow but
// healthy stream) or too lax (user waits 5min on truly stuck stream).
//
// This module: per-model adaptive 3-tier (warn / abort / kill).
// - warn: log but keep streaming, emit event so UI can show "still thinking"
// - abort: soft cancel reader.cancel() + raise stalled error → withRetry
// - kill: 1.5x abort, hard fail (used when soft abort hung)
//
// Why 3-tier not 2:
// - Soft abort first lets withRetry give the model another shot (often works,
//   first stall is flaky network not stuck model)
// - Hard kill catches the case where reader.cancel() itself hangs (Bun bug,
//   GH#32920-style native socket)
//
// Per-model rationale:
// - DS chat: warn 30s / abort 90s / kill 135s — observed p95 chunks ~5s, p99 ~25s
// - DS reasoner: warn 60s / abort 180s / kill 270s — thinking blocks burst
// - Claude: warn 15s / abort 60s / kill 90s — cloud SLO tighter
//
// Usage:
//   const wd = new StreamWatchdog('deepseek-chat')
//   wd.start(() => { onAbort })
//   for await chunk { wd.tick(); ... }
//   wd.stop()

import { EventEmitter } from 'events';
import { log } from '../utils/logger';

export interface WatchdogConfig {
  warnMs: number;
  abortMs: number;
  killMs: number;
}

const PROFILES: Record<string, WatchdogConfig> = {
  'deepseek-chat': { warnMs: 30_000, abortMs: 90_000, killMs: 135_000 },
  'deepseek-reasoner': { warnMs: 60_000, abortMs: 180_000, killMs: 270_000 },
  'claude-3.5-sonnet': { warnMs: 15_000, abortMs: 60_000, killMs: 90_000 },
  'claude-sonnet': { warnMs: 15_000, abortMs: 60_000, killMs: 90_000 },
  'claude-opus': { warnMs: 15_000, abortMs: 60_000, killMs: 90_000 },
  'gpt-4o': { warnMs: 15_000, abortMs: 60_000, killMs: 90_000 },
  'gpt-4': { warnMs: 15_000, abortMs: 60_000, killMs: 90_000 },
  default: { warnMs: 30_000, abortMs: 90_000, killMs: 135_000 },
};

export const DEFAULT_PROFILE = PROFILES.default;

/** Look up watchdog config; falls back to default for unknown models. */
export function getWatchdogConfig(model: string): WatchdogConfig {
  // Allow env override (used by tests + production tuning).
  const envWarn = Number(process.env.MANAMIR_STREAM_WARN_MS);
  const envAbort = Number(process.env.MANAMIR_STREAM_ABORT_MS);
  const envKill = Number(process.env.MANAMIR_STREAM_KILL_MS);
  if (envAbort > 0 && envWarn > 0 && envKill > 0) {
    return { warnMs: envWarn, abortMs: envAbort, killMs: envKill };
  }
  // Match by exact key first, then by prefix (deepseek-chat-v3 → deepseek-chat).
  if (PROFILES[model]) return PROFILES[model];
  for (const key of Object.keys(PROFILES)) {
    if (key !== 'default' && model.startsWith(key)) return PROFILES[key];
  }
  return PROFILES.default;
}

export type StallEvent = 'warn' | 'abort' | 'kill';

export interface StallReport {
  event: StallEvent;
  elapsedMs: number;
  model: string;
  // Index signature so log.warn(report) typechecks against Record<string, unknown>.
  [key: string]: unknown;
}

export class StreamWatchdog extends EventEmitter {
  private config: WatchdogConfig;
  private warnTimer: NodeJS.Timeout | null = null;
  private abortTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private lastTickAt = 0;
  private warned = false;
  private aborted = false;
  private softAbortFn: (() => void | Promise<void>) | null = null;
  private hardKillFn: (() => void) | null = null;

  constructor(public readonly model: string, configOverride?: Partial<WatchdogConfig>) {
    super();
    const base = getWatchdogConfig(model);
    this.config = { ...base, ...(configOverride ?? {}) };
  }

  /**
   * Start watching. softAbort fires at abortMs, hardKill at killMs (only if
   * stop() not called first).
   */
  start(handlers: { softAbort: () => void | Promise<void>; hardKill?: () => void }): void {
    if (this.warnTimer || this.abortTimer || this.killTimer) {
      throw new Error('StreamWatchdog already started');
    }
    this.startedAt = Date.now();
    this.lastTickAt = this.startedAt;
    this.softAbortFn = handlers.softAbort;
    this.hardKillFn = handlers.hardKill ?? null;
    this.scheduleAll();
  }

  /**
   * Call on each chunk received. Resets all timers — anything streaming is
   * proof of life.
   */
  tick(): void {
    if (this.aborted) return;
    this.lastTickAt = Date.now();
    this.warned = false;
    this.clearTimers();
    this.scheduleAll();
  }

  /**
   * Manually stop. Always call in finally — leaving timers running pins the
   * event loop (timer.unref alone may not be enough
   * if we explicitly resolved/rejected).
   */
  stop(): void {
    this.clearTimers();
    this.softAbortFn = null;
    this.hardKillFn = null;
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  /** For tests + diagnostics. */
  get elapsedMs(): number {
    return this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
  }

  get sinceLastChunkMs(): number {
    return this.lastTickAt === 0 ? 0 : Date.now() - this.lastTickAt;
  }

  private scheduleAll(): void {
    this.warnTimer = setTimeout(() => this.fireWarn(), this.config.warnMs);
    this.warnTimer.unref?.();
    this.abortTimer = setTimeout(() => this.fireAbort(), this.config.abortMs);
    this.abortTimer.unref?.();
    this.killTimer = setTimeout(() => this.fireKill(), this.config.killMs);
    this.killTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.warnTimer) clearTimeout(this.warnTimer);
    if (this.abortTimer) clearTimeout(this.abortTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.warnTimer = null;
    this.abortTimer = null;
    this.killTimer = null;
  }

  private fireWarn(): void {
    if (this.warned || this.aborted) return;
    this.warned = true;
    const report: StallReport = {
      event: 'warn',
      elapsedMs: this.sinceLastChunkMs,
      model: this.model,
    };
    log.warn('StreamWatchdog: stall warning', report);
    this.emit('stall', report);
  }

  private async fireAbort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    const report: StallReport = {
      event: 'abort',
      elapsedMs: this.sinceLastChunkMs,
      model: this.model,
    };
    log.error('StreamWatchdog: soft-abort triggered', report);
    this.emit('stall', report);
    try {
      await this.softAbortFn?.();
    } catch (err) {
      log.warn('StreamWatchdog: softAbort threw (will fall through to kill)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private fireKill(): void {
    const report: StallReport = {
      event: 'kill',
      elapsedMs: this.sinceLastChunkMs,
      model: this.model,
    };
    log.error('StreamWatchdog: hard-kill triggered (soft-abort did not return)', report);
    this.emit('stall', report);
    this.hardKillFn?.();
  }
}

/** Sentinel error thrown by softAbort path so withRetry sees a stall not a parse fail. */
export class StreamStalledError extends Error {
  constructor(public readonly elapsedMs: number, public readonly model: string) {
    super(`Stream stalled ${elapsedMs}ms on ${model}`);
    this.name = 'StreamStalledError';
  }
}
