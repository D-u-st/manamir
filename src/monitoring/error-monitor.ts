// Structured error monitoring — tracks failures, classifies, alerts on critical.
//
// Design: lightweight (no external deps like Sentry — pure local). Writes
// structured error records to disk for later analysis. Emits hooks on
// critical/escalation events so notification.ts can push to Discord.
//
// Three severity tiers:
//   - debug:   verbose, only logged
//   - warning: tracked, log + persist
//   - critical: tracked + persist + emit alert hook
//
// Escalation logic: if same error code repeats N times in M minutes, escalate
// to critical regardless of original severity.

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { atomicWrite } from '../utils/atomic-write';
import { hooks } from '../hooks';
import { log } from '../utils/logger';

export type ErrorSeverity = 'debug' | 'warning' | 'critical';

export interface ErrorRecord {
  timestamp: number;
  code: string;
  severity: ErrorSeverity;
  message: string;
  context?: Record<string, unknown>;
  stack?: string;
}

export interface MonitorConfig {
  /** Where to persist error log (JSONL). */
  logPath?: string;
  /** Window for repeat detection (ms). Default 10 min. */
  escalationWindowMs?: number;
  /** N occurrences within window → escalate. Default 5. */
  escalationThreshold?: number;
  /** Cap in-memory recent record count. Default 1000. */
  maxRecentRecords?: number;
  /** Auto-flush interval (ms). Default 30s. */
  flushIntervalMs?: number;
}

const DEFAULT_LOG_PATH = './data/errors.jsonl';
const DEFAULT_WINDOW_MS = 600_000;
const DEFAULT_ESCALATION = 5;
const DEFAULT_MAX_RECENT = 1000;
const DEFAULT_FLUSH_MS = 30_000;

interface CodeWindow {
  /** Timestamps of recent occurrences (ms epoch). */
  recent: number[];
  /** Have we already escalated this code in the current window? */
  escalated: boolean;
}

/**
 * In-process error monitor. Singleton-friendly (one per process), but you can
 * instantiate multiple if you want isolated tracking.
 */
export class ErrorMonitor {
  private logPath: string;
  private escalationWindowMs: number;
  private escalationThreshold: number;
  private maxRecentRecords: number;
  private flushIntervalMs: number;
  private recent: ErrorRecord[] = [];
  private byCode: Map<string, CodeWindow> = new Map();
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: MonitorConfig = {}) {
    this.logPath = config.logPath ?? DEFAULT_LOG_PATH;
    this.escalationWindowMs = config.escalationWindowMs ?? DEFAULT_WINDOW_MS;
    this.escalationThreshold = config.escalationThreshold ?? DEFAULT_ESCALATION;
    this.maxRecentRecords = config.maxRecentRecords ?? DEFAULT_MAX_RECENT;
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    const dir = this.logPath.includes('/')
      ? this.logPath.substring(0, this.logPath.lastIndexOf('/'))
      : '.';
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Record an error. */
  record(input: {
    code: string;
    severity?: ErrorSeverity;
    message: string;
    context?: Record<string, unknown>;
    error?: Error | unknown;
  }): void {
    const severity = input.severity ?? 'warning';
    const stack =
      input.error instanceof Error ? input.error.stack : undefined;

    const record: ErrorRecord = {
      timestamp: Date.now(),
      code: input.code,
      severity,
      message: input.message,
      context: input.context,
      stack,
    };

    this.recent.push(record);
    if (this.recent.length > this.maxRecentRecords) {
      this.recent.shift();
    }

    this.dirty = true;
    this.trackOccurrence(input.code, severity, record);
    this.logRecord(record);
  }

  /** Classify and log a thrown exception. */
  reportException(err: unknown, code: string, context?: Record<string, unknown>): void {
    const message = err instanceof Error ? err.message : String(err);
    this.record({
      code,
      severity: 'critical',
      message,
      context,
      error: err,
    });
  }

  /** Get recent error records (newest first). */
  getRecent(limit = 50): ErrorRecord[] {
    return [...this.recent].slice(-limit).reverse();
  }

  /** Snapshot for /status display. */
  summary(): {
    totalRecorded: number;
    bySeverity: Record<ErrorSeverity, number>;
    topCodes: Array<{ code: string; count: number }>;
    lastError?: { code: string; message: string; ageMs: number };
  } {
    const bySeverity: Record<ErrorSeverity, number> = {
      debug: 0,
      warning: 0,
      critical: 0,
    };
    const codeCount = new Map<string, number>();
    for (const r of this.recent) {
      bySeverity[r.severity]++;
      codeCount.set(r.code, (codeCount.get(r.code) ?? 0) + 1);
    }
    const topCodes = [...codeCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([code, count]) => ({ code, count }));

    const last = this.recent[this.recent.length - 1];
    return {
      totalRecorded: this.recent.length,
      bySeverity,
      topCodes,
      lastError: last
        ? {
            code: last.code,
            message: last.message,
            ageMs: Date.now() - last.timestamp,
          }
        : undefined,
    };
  }

  /** Start periodic auto-flush. */
  startAutoFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      if (this.dirty) void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Persist recent records to JSONL (atomic). */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    const lines = this.recent.map((r) => JSON.stringify(r)).join('\n') + '\n';
    try {
      await atomicWrite(this.logPath, lines);
      this.dirty = false;
    } catch (err) {
      // Don't recurse — just log and continue
      log.error('ErrorMonitor: flush failed', { error: String(err) });
    }
  }

  // ── Internal ──

  private trackOccurrence(
    code: string,
    severity: ErrorSeverity,
    record: ErrorRecord
  ): void {
    let window = this.byCode.get(code);
    if (!window) {
      window = { recent: [], escalated: false };
      this.byCode.set(code, window);
    }
    const now = Date.now();
    // Prune occurrences outside window
    window.recent = window.recent.filter(
      (t) => now - t <= this.escalationWindowMs
    );
    window.recent.push(now);

    // If we drop below threshold (window expired), reset escalation flag
    if (window.recent.length < this.escalationThreshold) {
      window.escalated = false;
    }

    // Critical events bypass threshold — alert immediately, but only once per
    // window to avoid spam.
    if (severity === 'critical' && !window.escalated) {
      window.escalated = true;
      this.emitAlert('critical_event', code, record, {
        countInWindow: window.recent.length,
      });
      return;
    }

    // Escalate non-critical when threshold exceeded
    if (
      severity !== 'critical' &&
      window.recent.length >= this.escalationThreshold &&
      !window.escalated
    ) {
      window.escalated = true;
      this.emitAlert('escalated', code, record, {
        countInWindow: window.recent.length,
        windowMs: this.escalationWindowMs,
      });
    }
  }

  private emitAlert(
    reason: 'critical_event' | 'escalated',
    code: string,
    record: ErrorRecord,
    extra: Record<string, unknown>
  ): void {
    void hooks.emit('error_monitor_alert', {
      reason,
      code,
      message: record.message,
      severity: record.severity,
      timestamp: record.timestamp,
      ...extra,
    });
    log.error(`ErrorMonitor [${reason.toUpperCase()}]: ${code} — ${record.message}`, extra);
  }

  private logRecord(r: ErrorRecord): void {
    const meta = { code: r.code, ...r.context };
    if (r.severity === 'critical') {
      log.error(r.message, meta);
    } else if (r.severity === 'warning') {
      log.warn(r.message, meta);
    } else {
      log.debug(r.message, meta);
    }
  }
}
