// Persistent cost tracker.
//
// Stores one JSONL line per day in <dataDir>/cost-history.jsonl with the
// shape:
//   { date: 'YYYY-MM-DD', byModel: { [model]: { inputTokens, outputTokens, calls, costUsd } } }
//
// We rewrite the whole file on every record() because the file stays small
// (one line per day) and we keep an in-memory mirror so the rewrite is cheap.

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic-write';
import { log } from '../utils/logger';
import { computeCost, getRate, USD_TO_CNY } from '../executor/cost-rates';

export interface ModelDayUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costUsd: number;
}

export interface DayUsage {
  date: string; // YYYY-MM-DD
  byModel: Record<string, ModelDayUsage>;
}

export interface CostRecordInput {
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Override the day boundary (test only). */
  now?: number;
}

export interface CostSummary {
  costUsd: number;
  costCny: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  byModel: Record<string, ModelDayUsage>;
}

export interface CostTrackerOptions {
  /** Directory where cost-history.jsonl will be stored. */
  dataDir: string;
  /** Filename override (default cost-history.jsonl). */
  filename?: string;
}

const DEFAULT_FILENAME = 'cost-history.jsonl';

/** Format a YYYY-MM-DD UTC date string for the given timestamp. */
export function dateKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class CostTracker {
  private readonly filePath: string;
  private days = new Map<string, DayUsage>();

  constructor(opts: CostTrackerOptions) {
    if (!existsSync(opts.dataDir)) {
      mkdirSync(opts.dataDir, { recursive: true });
    }
    this.filePath = join(opts.dataDir, opts.filename ?? DEFAULT_FILENAME);
    this.load();
  }

  /** Replay cost-history.jsonl into the in-memory map. */
  load(): { days: number } {
    this.days.clear();
    if (!existsSync(this.filePath)) return { days: 0 };
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      log.warn('CostTracker: failed to read history', { error: String(err) });
      return { days: 0 };
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const day = JSON.parse(trimmed) as DayUsage;
        if (typeof day.date === 'string' && day.byModel && typeof day.byModel === 'object') {
          this.days.set(day.date, day);
        }
      } catch {
        // Tolerate corrupted lines.
      }
    }
    return { days: this.days.size };
  }

  /**
   * Record one API call's usage. Idempotent only by call site — pass the
   * exact prompt/completion counts the API returned.
   */
  record(input: CostRecordInput): { day: string; deltaUsd: number } {
    const now = input.now ?? Date.now();
    const day = dateKey(now);
    const entry = this.days.get(day) ?? { date: day, byModel: {} };
    const model = input.model || 'unknown';
    const slot = entry.byModel[model] ?? {
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      costUsd: 0
    };
    const deltaUsd = computeCost(model, input.promptTokens, input.completionTokens);
    slot.inputTokens += Math.max(0, input.promptTokens || 0);
    slot.outputTokens += Math.max(0, input.completionTokens || 0);
    slot.calls += 1;
    slot.costUsd += deltaUsd;
    entry.byModel[model] = slot;
    this.days.set(day, entry);
    this.persist();
    return { day, deltaUsd };
  }

  /** Whole-store reset (used by /cost reset --confirm). */
  reset(): void {
    this.days.clear();
    this.persist();
  }

  /** Snapshot of one day. Empty struct if the day has no entries. */
  getDay(day: string): DayUsage {
    return this.days.get(day) ?? { date: day, byModel: {} };
  }

  /**
   * Aggregate summary across [day-(window-1), day]. windowDays = 1 returns
   * just that day; 7 returns a weekly rollup.
   */
  summarize(day: string, windowDays = 1): CostSummary {
    const target = new Date(`${day}T00:00:00Z`).getTime();
    const summary: CostSummary = {
      costUsd: 0,
      costCny: 0,
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      byModel: {}
    };
    for (let i = 0; i < windowDays; i++) {
      const ts = target - i * 86_400_000;
      const dayKey = dateKey(ts);
      const dayUsage = this.days.get(dayKey);
      if (!dayUsage) continue;
      for (const [model, usage] of Object.entries(dayUsage.byModel)) {
        summary.costUsd += usage.costUsd;
        summary.inputTokens += usage.inputTokens;
        summary.outputTokens += usage.outputTokens;
        summary.calls += usage.calls;
        const slot = summary.byModel[model] ?? {
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          costUsd: 0
        };
        slot.inputTokens += usage.inputTokens;
        slot.outputTokens += usage.outputTokens;
        slot.calls += usage.calls;
        slot.costUsd += usage.costUsd;
        summary.byModel[model] = slot;
      }
    }
    summary.costCny = summary.costUsd * USD_TO_CNY;
    return summary;
  }

  /**
   * Build a human-readable text block. Used by /cost (today / week / month).
   * windowLabel is rendered above the body ("Today (...)", "Week", etc).
   */
  formatSummary(day: string, windowDays: number, windowLabel: string): string {
    const summary = this.summarize(day, windowDays);
    const lines: string[] = [];
    lines.push(`${windowLabel}:`);
    lines.push(
      `  Total: $${summary.costUsd.toFixed(2)} (\u00A5${summary.costCny.toFixed(2)})`
    );
    if (summary.calls === 0) {
      lines.push('  (no API calls)');
      return lines.join('\n');
    }
    lines.push('  By model:');
    const modelEntries = Object.entries(summary.byModel).sort(
      (a, b) => b[1].costUsd - a[1].costUsd
    );
    for (const [model, usage] of modelEntries) {
      const inK = (usage.inputTokens / 1000).toFixed(1) + 'K';
      const outK = (usage.outputTokens / 1000).toFixed(1) + 'K';
      lines.push(
        `    ${model.padEnd(20)} $${usage.costUsd.toFixed(2)}` +
          `  (${inK} in / ${outK} out, ${usage.calls} calls)`
      );
    }
    return lines.join('\n');
  }

  /** Compare two days. Positive = costUsd grew between earlier→later. */
  compareDays(earlierDay: string, laterDay: string): {
    earlierUsd: number;
    laterUsd: number;
    deltaUsd: number;
    deltaPct: number;
  } {
    const e = this.summarize(earlierDay, 1).costUsd;
    const l = this.summarize(laterDay, 1).costUsd;
    const delta = l - e;
    const pct = e > 0 ? (delta / e) * 100 : 0;
    return { earlierUsd: e, laterUsd: l, deltaUsd: delta, deltaPct: pct };
  }

  /**
   * Pretty-print rate sheet for a list of models (so /cost can show
   * "current rates" alongside totals if desired).
   */
  formatRates(models: string[]): string {
    const lines: string[] = ['Current rates ($/M tokens):'];
    for (const model of models) {
      const rate = getRate(model);
      lines.push(
        `  ${model.padEnd(20)} in $${rate.inputPerMillion.toFixed(2)}` +
          `  out $${rate.outputPerMillion.toFixed(2)}`
      );
    }
    return lines.join('\n');
  }

  /** All loaded day records, oldest first. */
  listDays(): DayUsage[] {
    return [...this.days.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  // ── internal ─────────────────────────────────────────────────────────────

  private persist(): void {
    const lines: string[] = [];
    const sorted = [...this.days.values()].sort((a, b) => a.date.localeCompare(b.date));
    for (const day of sorted) lines.push(JSON.stringify(day));
    const body = lines.length > 0 ? lines.join('\n') + '\n' : '';
    try {
      atomicWriteSync(this.filePath, body, false);
    } catch (err) {
      log.error('CostTracker: failed to persist', { error: String(err) });
    }
  }
}

// ── Global singleton ───────────────────────────────────────────────────────
//
// Most call sites don't carry a CostTracker reference (they're deep inside
// the API executor). We keep an optional singleton that the bootstrapper
// installs on startup; the api-executor records into it through this
// indirection.

let globalTracker: CostTracker | null = null;

export function setGlobalCostTracker(tracker: CostTracker | null): void {
  globalTracker = tracker;
}

export function getGlobalCostTracker(): CostTracker | null {
  return globalTracker;
}

export function recordGlobalCost(input: CostRecordInput): void {
  if (globalTracker) globalTracker.record(input);
}
