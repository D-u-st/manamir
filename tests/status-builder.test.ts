import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  buildStatus,
  formatUptime,
  formatRelativeTime
} from '../src/utils/status-builder';
import { Scheduler } from '../src/autonomous/scheduler';
import { GateChain } from '../src/autonomous/gate-chain';
import { CostTracker, dateKey } from '../src/utils/cost-tracker';
import { MemoryStore } from '../src/memory/store';
import { RateLimitTracker } from '../src/executor/rate-limit-tracker';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sw-status-'));
}

describe('formatUptime', () => {
  test('formats seconds', () => {
    assert.strictEqual(formatUptime(45_000), '45s');
  });
  test('formats minutes', () => {
    assert.strictEqual(formatUptime(5 * 60_000), '5m');
  });
  test('formats hours with minutes', () => {
    assert.strictEqual(formatUptime(2 * 3_600_000 + 15 * 60_000), '2h 15m');
  });
  test('formats days with hours', () => {
    assert.strictEqual(formatUptime(2 * 86_400_000 + 3 * 3_600_000), '2d 3h');
  });
  test('clamps zero', () => {
    assert.strictEqual(formatUptime(0), '0s');
  });
});

describe('formatRelativeTime', () => {
  test('seconds-ago', () => {
    assert.strictEqual(formatRelativeTime(1000, 5000), '4s ago');
  });
  test('minutes-ago', () => {
    assert.strictEqual(formatRelativeTime(0, 5 * 60_000), '5m ago');
  });
  test('hours-ago', () => {
    assert.strictEqual(formatRelativeTime(0, 2 * 3_600_000), '2h ago');
  });
  test('days-ago', () => {
    assert.strictEqual(formatRelativeTime(0, 3 * 86_400_000), '3d ago');
  });
});

describe('buildStatus — minimal inputs', () => {
  test('produces all sections with empty dependencies', () => {
    const r = buildStatus({
      startedAt: 1000,
      now: 1000 + 5 * 60_000,
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'deepseek-chat',
      botOnline: true
    });
    assert.ok(r.text.includes('Manamir Status'));
    assert.ok(r.text.includes('Bot:'));
    assert.ok(r.text.includes('Online'));
    assert.ok(r.text.includes('5m'));
    assert.ok(r.text.includes('Sessions:'));
    assert.ok(r.text.includes('Memory:'));
    assert.ok(r.text.includes('Skills:'));
    assert.ok(r.text.includes('Worker:'));
    assert.ok(r.text.includes('Queue:'));
    assert.ok(r.text.includes('Model:'));
    assert.ok(r.text.includes('Cost today:'));
    assert.ok(r.text.includes('Rate limit:'));
  });

  test('marks bot offline correctly', () => {
    const r = buildStatus({
      startedAt: 1000,
      now: 2000,
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'x',
      botOnline: false
    });
    assert.ok(r.text.includes('Offline'));
  });

  test('formats sessions counts', () => {
    const r = buildStatus({
      startedAt: 0,
      now: 1000,
      activeSessions: 3,
      storedSessions: 27,
      primaryModel: 'x',
      botOnline: true
    });
    assert.ok(r.text.includes('3 active, 27 stored'));
  });

  test('markdown variant strips header line and bolds title', () => {
    const r = buildStatus({
      startedAt: 0,
      now: 1000,
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'x',
      botOnline: true
    });
    assert.ok(r.markdown.includes('**Manamir Status**'));
    assert.ok(!r.markdown.includes('================'));
  });
});

describe('buildStatus — with scheduler', () => {
  test('worker line: "Stopped" when worker is null', () => {
    const r = buildStatus({
      startedAt: 0,
      now: 1000,
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'x',
      botOnline: true
    });
    assert.ok(r.text.includes('Worker:'));
    assert.ok(r.text.includes('Not initialized'));
  });

  test('queue line counts pending/running/failed correctly', () => {
    const sched = new Scheduler(new GateChain(), { maxTasksPerHour: 30 });
    const a = sched.addTask('a');
    const b = sched.addTask('b');
    sched.addTask('c');
    sched.markRunning(a.id);
    sched.markRunning(b.id);
    sched.markFailed(b.id, 'boom');

    const r = buildStatus({
      startedAt: 0,
      now: 1000,
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'x',
      botOnline: true,
      scheduler: sched
    });
    assert.ok(r.text.includes('1 running, 1 pending, 1 failed'));
  });

  test('tasks-per-hour cap is rendered on worker line when worker provided', () => {
    const sched = new Scheduler(new GateChain(), { maxTasksPerHour: 30 });
    // Build a stub worker that satisfies the type — we only need .isRunning.
    const stubWorker = { isRunning: true } as unknown as import('../src/autonomous/worker').AutonomousWorker;
    const r = buildStatus({
      startedAt: 0,
      now: 1000,
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'x',
      botOnline: true,
      scheduler: sched,
      worker: stubWorker
    });
    assert.ok(r.text.includes('/30'));
    assert.ok(r.text.includes('Running'));
  });
});

describe('buildStatus — with cost tracker', () => {
  let dir: string;

  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('cost line uses today USD value', () => {
    const tracker = new CostTracker({ dataDir: dir });
    tracker.record({
      model: 'deepseek-chat',
      promptTokens: 162_000,
      completionTokens: 4300
    });
    const r = buildStatus({
      startedAt: 0,
      now: Date.now(),
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'deepseek-chat',
      botOnline: true,
      costTracker: tracker
    });
    assert.ok(r.text.includes('162.0K input'));
    assert.ok(r.text.includes('4.3K output'));
  });

  test('cost line falls back when tracker has no data', () => {
    const tracker = new CostTracker({ dataDir: dir });
    const r = buildStatus({
      startedAt: 0,
      now: Date.now(),
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'x',
      botOnline: true,
      costTracker: tracker
    });
    assert.ok(r.text.includes('$0.00'));
  });
});

describe('buildStatus — with memory store', () => {
  let dir: string;

  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('memory line counts entries by type', () => {
    const store = new MemoryStore({ dataDir: dir, maxMemoriesInPrompt: 5 });
    store.save({
      name: 'u1', description: 'd', type: 'user',
      content: 'x', createdAt: 1, updatedAt: 1
    });
    store.save({
      name: 'p1', description: 'd', type: 'project',
      content: 'x', createdAt: 1, updatedAt: 1
    });
    store.save({
      name: 'p2', description: 'd', type: 'project',
      content: 'x', createdAt: 1, updatedAt: 1
    });

    const r = buildStatus({
      startedAt: 0,
      now: 1000,
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'x',
      botOnline: true,
      memoryStore: store
    });
    assert.ok(r.text.includes('3 entries'));
    assert.ok(r.text.includes('2 project'));
    assert.ok(r.text.includes('1 user'));
  });
});

describe('buildStatus — with skills', () => {
  test('counts user vs system skills', () => {
    const skills = [
      { name: 's1', description: 'a', path: 'user/s1' },
      { name: 's2', description: 'b', path: 'user/s2' },
      { name: 's3', description: 'c', path: 'system/s3' },
      { name: 's4', description: 'd', path: 'system/s4' },
      { name: 's5', description: 'e', path: 'system/s5' }
    ];
    const r = buildStatus({
      startedAt: 0,
      now: 1000,
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'x',
      botOnline: true,
      skills
    });
    assert.ok(r.text.includes('5 installed'));
    assert.ok(r.text.includes('2 user'));
    assert.ok(r.text.includes('3 system'));
  });

  test('zero skills', () => {
    const r = buildStatus({
      startedAt: 0,
      now: 1000,
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'x',
      botOnline: true,
      skills: []
    });
    assert.ok(r.text.includes('0 installed'));
  });
});

describe('buildStatus — with rate limits', () => {
  test('shows remaining + reset window when tracker has data', () => {
    const rl = new RateLimitTracker();
    rl.update({
      'x-ratelimit-remaining-requests': '850',
      'x-ratelimit-reset-requests': '1320' // 22m in seconds
    });
    const r = buildStatus({
      startedAt: 0,
      now: Date.now(),
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'x',
      botOnline: true,
      rateLimits: rl
    });
    assert.ok(r.text.includes('850 req remaining'));
    assert.ok(r.text.includes('22m'));
  });

  test('shows "no data yet" when tracker empty', () => {
    const rl = new RateLimitTracker();
    const r = buildStatus({
      startedAt: 0,
      now: 1000,
      activeSessions: 0,
      storedSessions: 0,
      primaryModel: 'x',
      botOnline: true,
      rateLimits: rl
    });
    assert.ok(r.text.includes('no data yet'));
  });
});

describe('buildStatus — model line', () => {
  test('primary only', () => {
    const r = buildStatus({
      startedAt: 0, now: 1000,
      activeSessions: 0, storedSessions: 0,
      primaryModel: 'deepseek-chat',
      botOnline: true
    });
    assert.ok(r.text.includes('deepseek-chat (primary)'));
    assert.ok(!r.text.includes('(cheap)'));
  });

  test('primary + cheap renders both', () => {
    const r = buildStatus({
      startedAt: 0, now: 1000,
      activeSessions: 0, storedSessions: 0,
      primaryModel: 'claude-opus-4-7',
      cheapModel: 'deepseek-chat',
      botOnline: true
    });
    assert.ok(r.text.includes('claude-opus-4-7 (primary)'));
    assert.ok(r.text.includes('deepseek-chat (cheap)'));
  });

  test('omits cheap when same as primary', () => {
    const r = buildStatus({
      startedAt: 0, now: 1000,
      activeSessions: 0, storedSessions: 0,
      primaryModel: 'deepseek-chat',
      cheapModel: 'deepseek-chat',
      botOnline: true
    });
    assert.ok(!r.text.includes('(cheap)'));
  });
});

describe('buildStatus — last error line', () => {
  test('includes last error block when provided', () => {
    const r = buildStatus({
      startedAt: 0,
      now: 5_000_000, // 5000s
      activeSessions: 0, storedSessions: 0,
      primaryModel: 'x',
      botOnline: true,
      lastError: { message: 'Discord WebSocket reconnect', ts: 5_000_000 - 7_200_000 }
    });
    assert.ok(r.text.includes('Last error:'));
    assert.ok(r.text.includes('Discord WebSocket reconnect'));
    assert.ok(r.text.includes('2h ago'));
  });

  test('omits last error when not provided', () => {
    const r = buildStatus({
      startedAt: 0, now: 1000,
      activeSessions: 0, storedSessions: 0,
      primaryModel: 'x',
      botOnline: true
    });
    assert.ok(!r.text.includes('Last error:'));
  });
});
