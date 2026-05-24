import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { UserCron, validateCronEntry } from '../src/autonomous/user-cron';
import { Scheduler } from '../src/autonomous/scheduler';
import { GateChain } from '../src/autonomous/gate-chain';
import { nextCronMatch } from '../src/autonomous/cron';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sw-usercron-'));
}

describe('validateCronEntry', () => {
  test('returns null for non-object input', () => {
    assert.strictEqual(validateCronEntry(null), null);
    assert.strictEqual(validateCronEntry('hello'), null);
    assert.strictEqual(validateCronEntry(42), null);
  });

  test('returns null when name/schedule/prompt missing', () => {
    assert.strictEqual(validateCronEntry({ schedule: '* * * * *', prompt: 'x' }), null);
    assert.strictEqual(validateCronEntry({ name: 'a', prompt: 'x' }), null);
    assert.strictEqual(validateCronEntry({ name: 'a', schedule: '* * * * *' }), null);
  });

  test('returns null for invalid cron expression', () => {
    assert.strictEqual(
      validateCronEntry({ name: 'bad', schedule: 'not-a-cron', prompt: 'x' }),
      null
    );
  });

  test('accepts valid 5-field cron expression', () => {
    const e = validateCronEntry({ name: 'a', schedule: '0 8 * * *', prompt: 'check' });
    assert.ok(e !== null);
    assert.strictEqual(e!.name, 'a');
    assert.strictEqual(e!.schedule, '0 8 * * *');
    assert.strictEqual(e!.enabled, true);
  });

  test('honors enabled=false', () => {
    const e = validateCronEntry({ name: 'a', schedule: '* * * * *', prompt: 'x', enabled: false });
    assert.strictEqual(e?.enabled, false);
  });

  test('trims whitespace from string fields', () => {
    const e = validateCronEntry({ name: '  a  ', schedule: '  * * * * *  ', prompt: '  hi  ' });
    assert.strictEqual(e?.name, 'a');
    assert.strictEqual(e?.schedule, '* * * * *');
    assert.strictEqual(e?.prompt, 'hi');
  });
});

describe('UserCron — file persistence', () => {
  let dir: string;
  let scheduler: Scheduler;

  beforeEach(() => {
    dir = makeTempDir();
    scheduler = new Scheduler(new GateChain());
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('add() persists to cron.json', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    const ok = uc.add('daily-check', '0 8 * * *', 'morning health check');
    assert.strictEqual(ok, true);

    const filePath = join(dir, 'cron.json');
    assert.strictEqual(existsSync(filePath), true);
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].name, 'daily-check');
  });

  test('add() rejects invalid cron expressions', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    const ok = uc.add('bad', 'foo bar baz', 'x');
    assert.strictEqual(ok, false);
    assert.strictEqual(uc.list().length, 0);
  });

  test('remove() persists deletion', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    uc.add('a', '* * * * *', 'x');
    uc.add('b', '* * * * *', 'y');
    assert.strictEqual(uc.remove('a'), true);
    assert.strictEqual(uc.list().length, 1);

    const uc2 = new UserCron({ dataDir: dir, scheduler });
    assert.strictEqual(uc2.list().length, 1);
    assert.strictEqual(uc2.get('b')?.prompt, 'y');
  });

  test('remove returns false for missing entry', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    assert.strictEqual(uc.remove('nope'), false);
  });

  test('setEnabled() toggles enabled flag', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    uc.add('a', '* * * * *', 'x');
    uc.setEnabled('a', false);
    assert.strictEqual(uc.get('a')?.enabled, false);

    const uc2 = new UserCron({ dataDir: dir, scheduler });
    assert.strictEqual(uc2.get('a')?.enabled, false);
  });

  test('load() rejects invalid entries from cron.json', () => {
    writeFileSync(
      join(dir, 'cron.json'),
      JSON.stringify([
        { name: 'good', schedule: '* * * * *', prompt: 'x' },
        { name: 'bad', schedule: 'invalid', prompt: 'y' },
        { schedule: '* * * * *', prompt: 'z' } // no name
      ]),
      'utf-8'
    );
    const uc = new UserCron({ dataDir: dir, scheduler });
    assert.strictEqual(uc.list().length, 1);
    assert.strictEqual(uc.get('good')?.name, 'good');
  });

  test('tolerates corrupt cron.json', () => {
    writeFileSync(join(dir, 'cron.json'), '{not-json', 'utf-8');
    const uc = new UserCron({ dataDir: dir, scheduler });
    assert.strictEqual(uc.list().length, 0);
  });

  test('tolerates non-array JSON', () => {
    writeFileSync(join(dir, 'cron.json'), '{"foo":1}', 'utf-8');
    const uc = new UserCron({ dataDir: dir, scheduler });
    assert.strictEqual(uc.list().length, 0);
  });
});

describe('UserCron — schedule firing', () => {
  let dir: string;
  let scheduler: Scheduler;

  beforeEach(() => {
    dir = makeTempDir();
    scheduler = new Scheduler(new GateChain());
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('tick() does not fire entries whose nextRunAt is in the future', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    uc.add('future', '0 0 1 1 *', 'newyear'); // Jan 1 — unlikely to be now
    const result = uc.tick(Date.now());
    assert.strictEqual(result.fired.length, 0);
    assert.strictEqual(scheduler.listTasks().length, 0);
  });

  test('tick() fires entries whose nextRunAt has passed', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    uc.add('soon', '* * * * *', 'do it');
    const e = uc.get('soon');
    if (e) e.nextRunAt = Date.now() - 1000;
    const result = uc.tick(Date.now());
    assert.deepStrictEqual(result.fired, ['soon']);
    assert.strictEqual(scheduler.listTasks().length, 1);
    assert.strictEqual(scheduler.listTasks()[0].description, 'do it');
  });

  test('tick() advances nextRunAt before firing (no double-fire)', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    uc.add('rep', '* * * * *', 'x');
    const e = uc.get('rep');
    if (e) e.nextRunAt = Date.now() - 1000;
    const t0 = Date.now();
    uc.tick(t0);
    const after = uc.get('rep');
    assert.ok((after?.nextRunAt ?? 0) > t0);
    // A second tick with same `now` should NOT re-fire because nextRunAt advanced.
    const second = uc.tick(t0);
    assert.strictEqual(second.fired.length, 0);
  });

  test('tick() skips disabled entries', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    uc.add('off', '* * * * *', 'x', false);
    const e = uc.get('off');
    if (e) e.nextRunAt = Date.now() - 1000;
    const result = uc.tick(Date.now());
    assert.strictEqual(result.fired.length, 0);
    assert.strictEqual(scheduler.listTasks().length, 0);
  });

  test('tick() increments runCount on fire', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    uc.add('rep2', '* * * * *', 'x');
    const e = uc.get('rep2');
    if (e) e.nextRunAt = Date.now() - 1000;
    uc.tick(Date.now());
    assert.strictEqual(uc.get('rep2')?.runCount, 1);
  });

  test('tick() attaches metadata to scheduled task', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    uc.add('meta', '* * * * *', 'do thing');
    const e = uc.get('meta');
    if (e) e.nextRunAt = Date.now() - 1000;
    uc.tick(Date.now());
    const task = scheduler.listTasks()[0];
    assert.strictEqual(task.metadata?.source, 'user-cron');
    assert.strictEqual(task.metadata?.cronName, 'meta');
  });

  test('multiple due entries all fire in one tick', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    uc.add('a', '* * * * *', 'A');
    uc.add('b', '* * * * *', 'B');
    const ea = uc.get('a');
    const eb = uc.get('b');
    if (ea) ea.nextRunAt = Date.now() - 1000;
    if (eb) eb.nextRunAt = Date.now() - 500;
    const result = uc.tick(Date.now());
    assert.strictEqual(result.fired.length, 2);
    assert.strictEqual(scheduler.listTasks().length, 2);
  });

  test('schedule progression: minute-precise wildcard', () => {
    // Smoke: nextCronMatch returns a future timestamp aligned to minute boundary
    const now = Date.now();
    const next = nextCronMatch('* * * * *', now);
    assert.ok(next > now);
    assert.ok(next - now <= 60_000);
  });

  test('add()/remove() are idempotent — re-add overwrites', () => {
    const uc = new UserCron({ dataDir: dir, scheduler });
    uc.add('dup', '* * * * *', 'first');
    uc.add('dup', '0 12 * * *', 'second');
    assert.strictEqual(uc.list().length, 1);
    assert.strictEqual(uc.get('dup')?.prompt, 'second');
    assert.strictEqual(uc.get('dup')?.schedule, '0 12 * * *');
  });

  test('start/stop are no-ops without crashing', () => {
    const uc = new UserCron({ dataDir: dir, scheduler, tickMs: 100_000 });
    uc.start();
    uc.start(); // second start should be safe
    uc.stop();
    uc.stop(); // second stop should be safe
  });
});
