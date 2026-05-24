import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  CostTracker,
  dateKey,
  setGlobalCostTracker,
  getGlobalCostTracker,
  recordGlobalCost
} from '../src/utils/cost-tracker';
import {
  computeCost,
  getRate,
  MODEL_RATES,
  DEFAULT_RATE,
  USD_TO_CNY
} from '../src/executor/cost-rates';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sw-cost-'));
}

describe('cost-rates', () => {
  test('exact match returns the rate', () => {
    const r = getRate('deepseek-chat');
    assert.strictEqual(r.inputPerMillion, 0.27);
    assert.strictEqual(r.outputPerMillion, 1.10);
  });

  test('prefix match falls back to longest matching key', () => {
    const r = getRate('deepseek-chat-v3-experimental');
    assert.strictEqual(r.inputPerMillion, 0.27);
  });

  test('unknown model falls back to DEFAULT_RATE', () => {
    const r = getRate('completely-unknown-model');
    assert.strictEqual(r.inputPerMillion, DEFAULT_RATE.inputPerMillion);
    assert.strictEqual(r.outputPerMillion, DEFAULT_RATE.outputPerMillion);
  });

  test('claude-opus-4-7 has correct rate', () => {
    const r = getRate('claude-opus-4-7');
    assert.strictEqual(r.inputPerMillion, 15);
    assert.strictEqual(r.outputPerMillion, 75);
  });

  test('gpt-4o has correct rate', () => {
    const r = getRate('gpt-4o');
    assert.strictEqual(r.inputPerMillion, 2.5);
    assert.strictEqual(r.outputPerMillion, 10);
  });

  test('computeCost returns 0 for zero tokens', () => {
    assert.strictEqual(computeCost('deepseek-chat', 0, 0), 0);
  });

  test('computeCost computes input + output correctly', () => {
    // deepseek-chat: 0.27 in / 1.10 out per 1M
    const cost = computeCost('deepseek-chat', 1_000_000, 1_000_000);
    assert.ok(Math.abs(cost - (0.27 + 1.10)) < 1e-9);
  });

  test('computeCost handles fractional tokens', () => {
    const cost = computeCost('deepseek-chat', 162_000, 4_300);
    const expected = (162_000 / 1_000_000) * 0.27 + (4_300 / 1_000_000) * 1.10;
    assert.ok(Math.abs(cost - expected) < 1e-9);
  });

  test('computeCost ignores negative inputs', () => {
    const cost = computeCost('deepseek-chat', -100, 1_000_000);
    assert.ok(Math.abs(cost - 1.10) < 1e-9);
  });

  test('USD_TO_CNY is positive', () => {
    assert.ok(USD_TO_CNY > 0);
  });

  test('all configured rates have positive numbers', () => {
    for (const [name, r] of Object.entries(MODEL_RATES)) {
      assert.ok(r.inputPerMillion >= 0, `${name} input rate`);
      assert.ok(r.outputPerMillion >= 0, `${name} output rate`);
    }
  });
});

describe('dateKey', () => {
  test('returns YYYY-MM-DD format', () => {
    const k = dateKey(Date.UTC(2026, 3, 18, 12));
    assert.strictEqual(k, '2026-04-18');
  });
});

describe('CostTracker — record + summarize', () => {
  let dir: string;
  let tracker: CostTracker;

  beforeEach(() => {
    dir = makeTempDir();
    tracker = new CostTracker({ dataDir: dir });
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('starts empty', () => {
    const today = dateKey(Date.now());
    const summary = tracker.summarize(today, 1);
    assert.strictEqual(summary.calls, 0);
    assert.strictEqual(summary.costUsd, 0);
  });

  test('record() returns the day key + cost delta', () => {
    const result = tracker.record({
      model: 'deepseek-chat',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000
    });
    assert.ok(typeof result.day === 'string');
    assert.ok(Math.abs(result.deltaUsd - (0.27 + 1.10)) < 1e-9);
  });

  test('record() accumulates calls', () => {
    const today = dateKey(Date.now());
    tracker.record({ model: 'deepseek-chat', promptTokens: 100_000, completionTokens: 1000 });
    tracker.record({ model: 'deepseek-chat', promptTokens: 100_000, completionTokens: 1000 });
    const summary = tracker.summarize(today, 1);
    assert.strictEqual(summary.calls, 2);
    assert.strictEqual(summary.inputTokens, 200_000);
    assert.strictEqual(summary.outputTokens, 2000);
  });

  test('record() splits cost by model', () => {
    const today = dateKey(Date.now());
    tracker.record({ model: 'deepseek-chat', promptTokens: 1_000_000, completionTokens: 0 });
    tracker.record({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 0 });
    const s = tracker.summarize(today, 1);
    assert.strictEqual(Object.keys(s.byModel).length, 2);
    assert.ok(s.byModel['deepseek-chat']);
    assert.ok(s.byModel['gpt-4o']);
  });

  test('summarize() with windowDays=7 sums across days', () => {
    const t0 = Date.UTC(2026, 3, 18, 12);
    const t1 = t0 - 86_400_000;
    const t2 = t0 - 2 * 86_400_000;
    tracker.record({ model: 'deepseek-chat', promptTokens: 1_000_000, completionTokens: 0, now: t0 });
    tracker.record({ model: 'deepseek-chat', promptTokens: 1_000_000, completionTokens: 0, now: t1 });
    tracker.record({ model: 'deepseek-chat', promptTokens: 1_000_000, completionTokens: 0, now: t2 });
    const week = tracker.summarize(dateKey(t0), 7);
    assert.strictEqual(week.calls, 3);
    assert.ok(Math.abs(week.costUsd - 3 * 0.27) < 1e-9);
  });

  test('summarize() includes CNY conversion', () => {
    const today = dateKey(Date.now());
    tracker.record({ model: 'deepseek-chat', promptTokens: 1_000_000, completionTokens: 0 });
    const s = tracker.summarize(today, 1);
    assert.ok(s.costCny > s.costUsd);
  });

  test('compareDays() reports delta and percentage', () => {
    const yest = dateKey(Date.now() - 86_400_000);
    const today = dateKey(Date.now());
    tracker.record({
      model: 'deepseek-chat',
      promptTokens: 1_000_000,
      completionTokens: 0,
      now: Date.now() - 86_400_000
    });
    tracker.record({
      model: 'deepseek-chat',
      promptTokens: 2_000_000,
      completionTokens: 0
    });
    const cmp = tracker.compareDays(yest, today);
    assert.ok(Math.abs(cmp.deltaPct - 100) < 0.5);
    assert.ok(cmp.laterUsd > cmp.earlierUsd);
  });
});

describe('CostTracker — persistence', () => {
  let dir: string;

  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('writes cost-history.jsonl on record', () => {
    const t = new CostTracker({ dataDir: dir });
    t.record({ model: 'deepseek-chat', promptTokens: 100, completionTokens: 50 });
    const file = join(dir, 'cost-history.jsonl');
    assert.strictEqual(existsSync(file), true);
    const raw = readFileSync(file, 'utf-8');
    assert.ok(raw.includes('"deepseek-chat"'));
  });

  test('survives restart — record then reload', () => {
    const t1 = new CostTracker({ dataDir: dir });
    t1.record({
      model: 'deepseek-chat',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000
    });

    const t2 = new CostTracker({ dataDir: dir });
    const today = dateKey(Date.now());
    const s = t2.summarize(today, 1);
    assert.strictEqual(s.calls, 1);
    assert.ok(Math.abs(s.costUsd - (0.27 + 1.10)) < 1e-9);
  });

  test('reset() wipes file', () => {
    const t = new CostTracker({ dataDir: dir });
    t.record({ model: 'deepseek-chat', promptTokens: 100, completionTokens: 100 });
    t.reset();
    const t2 = new CostTracker({ dataDir: dir });
    const s = t2.summarize(dateKey(Date.now()), 1);
    assert.strictEqual(s.calls, 0);
  });

  test('listDays() returns sorted history', () => {
    const t = new CostTracker({ dataDir: dir });
    const t0 = Date.UTC(2026, 3, 18, 12);
    t.record({ model: 'a', promptTokens: 1, completionTokens: 1, now: t0 });
    t.record({ model: 'a', promptTokens: 1, completionTokens: 1, now: t0 - 86_400_000 });
    const days = t.listDays();
    assert.strictEqual(days.length, 2);
    assert.ok(days[0].date < days[1].date);
  });
});

describe('CostTracker — formatting', () => {
  let dir: string;
  let tracker: CostTracker;

  beforeEach(() => {
    dir = makeTempDir();
    tracker = new CostTracker({ dataDir: dir });
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('formatSummary() renders empty day cleanly', () => {
    const out = tracker.formatSummary(dateKey(Date.now()), 1, 'Today');
    assert.ok(out.includes('Today'));
    assert.ok(out.includes('$0.00'));
    assert.ok(out.includes('no API calls'));
  });

  test('formatSummary() includes cost + tokens + calls', () => {
    tracker.record({
      model: 'deepseek-chat',
      promptTokens: 100_000,
      completionTokens: 5_000
    });
    const out = tracker.formatSummary(dateKey(Date.now()), 1, 'Today');
    assert.ok(out.includes('deepseek-chat'));
    assert.ok(out.includes('calls'));
    assert.ok(out.includes('$'));
  });

  test('formatRates() renders rate sheet', () => {
    const out = tracker.formatRates(['deepseek-chat', 'gpt-4o']);
    assert.ok(out.includes('deepseek-chat'));
    assert.ok(out.includes('gpt-4o'));
  });
});

describe('global singleton', () => {
  test('setGlobalCostTracker / getGlobalCostTracker', () => {
    const dir = makeTempDir();
    try {
      const t = new CostTracker({ dataDir: dir });
      setGlobalCostTracker(t);
      assert.strictEqual(getGlobalCostTracker(), t);
      setGlobalCostTracker(null);
      assert.strictEqual(getGlobalCostTracker(), null);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('recordGlobalCost is a no-op when no tracker installed', () => {
    setGlobalCostTracker(null);
    // Should not throw
    recordGlobalCost({ model: 'x', promptTokens: 1, completionTokens: 1 });
  });

  test('recordGlobalCost forwards to installed tracker', () => {
    const dir = makeTempDir();
    try {
      const t = new CostTracker({ dataDir: dir });
      setGlobalCostTracker(t);
      recordGlobalCost({ model: 'deepseek-chat', promptTokens: 1000, completionTokens: 100 });
      const today = dateKey(Date.now());
      assert.strictEqual(t.summarize(today, 1).calls, 1);
    } finally {
      setGlobalCostTracker(null);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
