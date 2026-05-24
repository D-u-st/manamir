import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  TaskStore,
  truncateResult,
  TASK_RESULT_MAX_BYTES
} from '../src/autonomous/task-store';
import { Scheduler, type AutoTask } from '../src/autonomous/scheduler';
import { GateChain } from '../src/autonomous/gate-chain';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sw-taskstore-'));
}

function makeTask(overrides: Partial<AutoTask> = {}): AutoTask {
  return {
    id: overrides.id || 'task_1',
    description: overrides.description || 'hello world',
    priority: overrides.priority ?? 100,
    status: overrides.status || 'pending',
    createdAt: overrides.createdAt ?? 1000,
    scheduledAt: overrides.scheduledAt ?? null,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    result: overrides.result ?? null,
    error: overrides.error ?? null,
    parentId: overrides.parentId ?? null,
    metadata: overrides.metadata
  };
}

describe('truncateResult', () => {
  test('returns null for null input', () => {
    assert.strictEqual(truncateResult(null, 100), null);
  });

  test('returns the original string when within budget', () => {
    assert.strictEqual(truncateResult('hi', 100), 'hi');
  });

  test('truncates oversized input with marker', () => {
    const big = 'a'.repeat(10_000);
    const out = truncateResult(big, 1000);
    assert.ok(out !== null && out.length < big.length);
    assert.ok(out!.includes('[truncated'));
  });

  test('default budget is 5KB', () => {
    assert.strictEqual(TASK_RESULT_MAX_BYTES, 5 * 1024);
  });
});

describe('TaskStore — core persistence', () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = makeTempDir();
    store = new TaskStore({ dataDir: dir });
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('creates dataDir if it does not exist', () => {
    const nested = join(dir, 'nested', 'deeper');
    const s = new TaskStore({ dataDir: nested });
    s.recordAdd(makeTask());
    assert.strictEqual(existsSync(nested), true);
  });

  test('load returns zero restored tasks when file missing', () => {
    const result = store.load();
    assert.strictEqual(result.restored, 0);
    assert.strictEqual(result.markedFailed, 0);
  });

  test('recordAdd persists to disk', () => {
    store.recordAdd(makeTask({ id: 'a', description: 'first' }));
    const file = join(dir, 'tasks.jsonl');
    assert.strictEqual(existsSync(file), true);
    const raw = readFileSync(file, 'utf-8').trim();
    assert.ok(raw.includes('"kind":"add"'));
    assert.ok(raw.includes('"id":"a"'));
  });

  test('recordUpdate mutates in-memory task', () => {
    store.recordAdd(makeTask({ id: 'u', status: 'pending' }));
    store.recordUpdate('u', { status: 'running', startedAt: 5000 });
    const t = store.get('u');
    assert.strictEqual(t?.status, 'running');
    assert.strictEqual(t?.startedAt, 5000);
  });

  test('recordDelete removes from in-memory map', () => {
    store.recordAdd(makeTask({ id: 'd' }));
    store.recordDelete('d');
    assert.strictEqual(store.get('d'), undefined);
  });

  test('byStatus filters by status', () => {
    store.recordAdd(makeTask({ id: 'p1', status: 'pending' }));
    store.recordAdd(makeTask({ id: 'p2', status: 'pending' }));
    store.recordAdd(makeTask({ id: 'c1', status: 'completed' }));
    assert.strictEqual(store.byStatus('pending').length, 2);
    assert.strictEqual(store.byStatus('completed').length, 1);
  });

  test('result truncation is applied on add', () => {
    const big = 'x'.repeat(20_000);
    store.recordAdd(makeTask({ id: 'big', result: big }));
    const t = store.get('big');
    assert.ok(t?.result !== null);
    assert.ok((t!.result as string).length < big.length);
    assert.ok((t!.result as string).includes('[truncated'));
  });

  test('result truncation is applied on update', () => {
    store.recordAdd(makeTask({ id: 'up' }));
    const big = 'y'.repeat(20_000);
    store.recordUpdate('up', { status: 'completed', result: big });
    const t = store.get('up');
    assert.ok((t!.result as string).includes('[truncated'));
  });
});

describe('TaskStore — restore across "restart"', () => {
  let dir: string;

  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('tasks added before restart are visible after restart', () => {
    const s1 = new TaskStore({ dataDir: dir });
    s1.recordAdd(makeTask({ id: 't1', description: 'alpha' }));
    s1.recordAdd(makeTask({ id: 't2', description: 'beta' }));

    const s2 = new TaskStore({ dataDir: dir });
    const restored = s2.load();
    assert.strictEqual(restored.restored, 2);
    assert.strictEqual(restored.markedFailed, 0);
    assert.strictEqual(s2.get('t1')?.description, 'alpha');
    assert.strictEqual(s2.get('t2')?.description, 'beta');
  });

  test('updates applied before restart are visible after restart', () => {
    const s1 = new TaskStore({ dataDir: dir });
    s1.recordAdd(makeTask({ id: 'u1' }));
    s1.recordUpdate('u1', { status: 'completed', result: 'done' });

    const s2 = new TaskStore({ dataDir: dir });
    s2.load();
    assert.strictEqual(s2.get('u1')?.status, 'completed');
    assert.strictEqual(s2.get('u1')?.result, 'done');
  });

  test('deletes applied before restart are visible after restart', () => {
    const s1 = new TaskStore({ dataDir: dir });
    s1.recordAdd(makeTask({ id: 'd1' }));
    s1.recordDelete('d1');

    const s2 = new TaskStore({ dataDir: dir });
    s2.load();
    assert.strictEqual(s2.get('d1'), undefined);
  });

  test('crash recovery: running tasks are rewritten to failed on load', () => {
    const s1 = new TaskStore({ dataDir: dir });
    s1.recordAdd(makeTask({ id: 'crashed', status: 'pending' }));
    s1.recordUpdate('crashed', { status: 'running', startedAt: 100 });

    const s2 = new TaskStore({ dataDir: dir });
    const restored = s2.load();
    assert.strictEqual(restored.markedFailed, 1);
    const t = s2.get('crashed');
    assert.strictEqual(t?.status, 'failed');
    assert.ok(t?.error?.includes('process died'));
  });

  test('restore is idempotent — loading twice is safe', () => {
    const s1 = new TaskStore({ dataDir: dir });
    s1.recordAdd(makeTask({ id: 'x1' }));
    s1.recordAdd(makeTask({ id: 'x2' }));

    const s2 = new TaskStore({ dataDir: dir });
    s2.load();
    const countAfterFirst = s2.getAll().length;
    s2.load();
    assert.strictEqual(s2.getAll().length, countAfterFirst);
  });

  test('corrupted JSONL lines are tolerated', () => {
    const s1 = new TaskStore({ dataDir: dir });
    s1.recordAdd(makeTask({ id: 'ok' }));
    // Append a garbage line manually
    appendFileSync(join(dir, 'tasks.jsonl'), 'not-json{\n', 'utf-8');

    const s2 = new TaskStore({ dataDir: dir });
    const restored = s2.load();
    assert.strictEqual(restored.restored, 1);
  });

  test('compact rewrites file to one add per surviving task', () => {
    const s1 = new TaskStore({ dataDir: dir, compactThresholdLines: 3 });
    s1.recordAdd(makeTask({ id: 'c1' }));
    s1.recordUpdate('c1', { status: 'running' });
    s1.recordUpdate('c1', { status: 'completed' });
    s1.recordAdd(makeTask({ id: 'c2' })); // should trigger compact
    // After compaction, the file should have two 'add' lines, no updates
    const body = readFileSync(join(dir, 'tasks.jsonl'), 'utf-8');
    const addLines = body.split('\n').filter(l => l.includes('"kind":"add"'));
    const updLines = body.split('\n').filter(l => l.includes('"kind":"update"'));
    assert.strictEqual(addLines.length, 2);
    assert.strictEqual(updLines.length, 0);
  });
});

describe('TaskStore + Scheduler integration', () => {
  let dir: string;

  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('scheduler persists addTask to disk', () => {
    const store = new TaskStore({ dataDir: dir });
    const sched = new Scheduler(new GateChain(), { store });
    sched.addTask('hello from test', { priority: 5 });

    const store2 = new TaskStore({ dataDir: dir });
    store2.load();
    const all = store2.getAll();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].description, 'hello from test');
    assert.strictEqual(all[0].priority, 5);
  });

  test('scheduler persists state transitions', () => {
    const store = new TaskStore({ dataDir: dir });
    const sched = new Scheduler(new GateChain(), { store });
    const t = sched.addTask('transition');
    sched.markRunning(t.id);
    sched.markCompleted(t.id, 'final result');

    const store2 = new TaskStore({ dataDir: dir });
    store2.load();
    const restored = store2.get(t.id);
    assert.strictEqual(restored?.status, 'completed');
    assert.strictEqual(restored?.result, 'final result');
  });

  test('scheduler crash mid-run → on restart task becomes failed', () => {
    const store1 = new TaskStore({ dataDir: dir });
    const sched1 = new Scheduler(new GateChain(), { store: store1 });
    const t = sched1.addTask('will crash');
    sched1.markRunning(t.id);
    // simulate crash — don't call markCompleted

    const store2 = new TaskStore({ dataDir: dir });
    const restored = store2.load();
    assert.strictEqual(restored.markedFailed, 1);
    const recovered = store2.get(t.id);
    assert.strictEqual(recovered?.status, 'failed');
  });

  test('prune through scheduler persists deletion', () => {
    const store = new TaskStore({ dataDir: dir });
    const sched = new Scheduler(new GateChain(), { store });
    const t = sched.addTask('prunable');
    sched.markRunning(t.id);
    sched.markCompleted(t.id, 'ok');
    // The scheduler holds its own task object — mutate that directly so the
    // prune cutoff catches it.
    const live = sched.getTask(t.id);
    if (live) live.completedAt = Date.now() - 10_000_000;
    const pruned = sched.prune(1000);
    assert.strictEqual(pruned, 1);

    const store2 = new TaskStore({ dataDir: dir });
    store2.load();
    assert.strictEqual(store2.get(t.id), undefined);
  });

  test('scheduler restores pending tasks from disk on construct', () => {
    const store1 = new TaskStore({ dataDir: dir });
    const s1 = new Scheduler(new GateChain(), { store: store1 });
    s1.addTask('restore-me-1', { priority: 10 });
    s1.addTask('restore-me-2', { priority: 5 });

    const store2 = new TaskStore({ dataDir: dir });
    store2.load();
    const s2 = new Scheduler(new GateChain(), { store: store2 });
    const tasks = s2.listTasks();
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(s2.pendingCount, 2);
    // Next task picks the lower priority (=5) first
    const next = s2.getNextTask();
    assert.strictEqual(next?.description, 'restore-me-2');
  });

  test('maxTasksPerHour gates canExecute', () => {
    const sched = new Scheduler(new GateChain(), { maxTasksPerHour: 2 });
    const a = sched.addTask('a');
    const b = sched.addTask('b');
    const c = sched.addTask('c');
    sched.markRunning(a.id);
    sched.markCompleted(a.id, '');
    sched.markRunning(b.id);
    sched.markCompleted(b.id, '');
    assert.strictEqual(sched.tasksStartedLastHour, 2);
    assert.strictEqual(sched.canExecute, false);
    // Even though there's room for b, the per-hour cap blocks
    sched.markRunning(c.id);
    // c should still be 'pending' because markRunning is a state machine
    // check; the cap only affects canExecute polling. Sanity: mark it anyway
    // and confirm stats increment.
    assert.strictEqual(sched.tasksStartedLastHour, 3);
  });

  test('requireGate:false bypasses gate failures', async () => {
    const chain = new GateChain();
    chain.add('always-fail', async () => false);
    const sched = new Scheduler(chain, { requireGate: false });
    const ok = await sched.checkGates();
    assert.strictEqual(ok, true);
  });

  test('requireGate:true honors gate failures', async () => {
    const chain = new GateChain();
    chain.add('always-fail', async () => false);
    const sched = new Scheduler(chain, { requireGate: true });
    const ok = await sched.checkGates();
    assert.strictEqual(ok, false);
  });
});
