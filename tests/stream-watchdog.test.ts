// Stream watchdog unit tests

import { test } from 'node:test';
import assert from 'node:assert';
import { StreamWatchdog, StreamStalledError, getWatchdogConfig, DEFAULT_PROFILE } from '../src/executor/stream-watchdog.js';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('getWatchdogConfig: known model returns its profile', () => {
  const cfg = getWatchdogConfig('deepseek-chat');
  assert.strictEqual(cfg.warnMs, 30_000);
  assert.strictEqual(cfg.abortMs, 90_000);
  assert.strictEqual(cfg.killMs, 135_000);
});

test('getWatchdogConfig: reasoner gets longer thresholds', () => {
  const cfg = getWatchdogConfig('deepseek-reasoner');
  assert.strictEqual(cfg.warnMs, 60_000);
  assert.strictEqual(cfg.abortMs, 180_000);
});

test('getWatchdogConfig: unknown model falls to default', () => {
  const cfg = getWatchdogConfig('mystery-model-v99');
  assert.deepStrictEqual(cfg, DEFAULT_PROFILE);
});

test('getWatchdogConfig: prefix match (deepseek-chat-v3 → deepseek-chat)', () => {
  const cfg = getWatchdogConfig('deepseek-chat-v3-0801');
  assert.strictEqual(cfg.warnMs, 30_000); // matched deepseek-chat
});

test('getWatchdogConfig: env override beats profile', () => {
  process.env.MANAMIR_STREAM_WARN_MS = '100';
  process.env.MANAMIR_STREAM_ABORT_MS = '200';
  process.env.MANAMIR_STREAM_KILL_MS = '300';
  try {
    const cfg = getWatchdogConfig('deepseek-chat');
    assert.strictEqual(cfg.warnMs, 100);
    assert.strictEqual(cfg.abortMs, 200);
    assert.strictEqual(cfg.killMs, 300);
  } finally {
    delete process.env.MANAMIR_STREAM_WARN_MS;
    delete process.env.MANAMIR_STREAM_ABORT_MS;
    delete process.env.MANAMIR_STREAM_KILL_MS;
  }
});

test('StreamWatchdog: warn fires before abort', async () => {
  const wd = new StreamWatchdog('deepseek-chat', { warnMs: 50, abortMs: 200, killMs: 400 });
  const events: string[] = [];
  wd.on('stall', (r) => events.push(r.event));
  wd.start({ softAbort: () => {} });
  await wait(80);
  assert.deepStrictEqual(events, ['warn']);
  wd.stop();
});

test('StreamWatchdog: tick resets warn', async () => {
  const wd = new StreamWatchdog('deepseek-chat', { warnMs: 50, abortMs: 200, killMs: 400 });
  const events: string[] = [];
  wd.on('stall', (r) => events.push(r.event));
  wd.start({ softAbort: () => {} });
  await wait(30);
  wd.tick(); // reset before warn fires
  await wait(30);
  assert.deepStrictEqual(events, [], 'no events should fire after tick reset');
  wd.stop();
});

test('StreamWatchdog: abort fires after threshold and calls softAbort', async () => {
  const wd = new StreamWatchdog('deepseek-chat', { warnMs: 30, abortMs: 80, killMs: 200 });
  const events: string[] = [];
  let aborted = false;
  wd.on('stall', (r) => events.push(r.event));
  wd.start({ softAbort: () => { aborted = true; } });
  await wait(120);
  assert.ok(events.includes('abort'), `expected abort event, got ${events}`);
  assert.strictEqual(aborted, true);
  assert.strictEqual(wd.isAborted, true);
  wd.stop();
});

test('StreamWatchdog: kill fires if softAbort never resolves', async () => {
  const wd = new StreamWatchdog('deepseek-chat', { warnMs: 20, abortMs: 60, killMs: 120 });
  const events: string[] = [];
  let killed = false;
  wd.on('stall', (r) => events.push(r.event));
  wd.start({
    softAbort: () => new Promise(() => { /* never resolve */ }),
    hardKill: () => { killed = true; },
  });
  await wait(180);
  assert.ok(events.includes('kill'), `expected kill, got ${events.join(',')}`);
  assert.strictEqual(killed, true);
  wd.stop();
});

test('StreamWatchdog: tick after abort is ignored', async () => {
  const wd = new StreamWatchdog('deepseek-chat', { warnMs: 30, abortMs: 60, killMs: 200 });
  wd.start({ softAbort: () => {} });
  await wait(80);
  assert.strictEqual(wd.isAborted, true);
  wd.tick(); // should be no-op
  assert.strictEqual(wd.isAborted, true);
  wd.stop();
});

test('StreamWatchdog: stop prevents kill from firing', async () => {
  const wd = new StreamWatchdog('deepseek-chat', { warnMs: 30, abortMs: 60, killMs: 200 });
  let killed = false;
  wd.start({
    softAbort: () => new Promise(() => {}),
    hardKill: () => { killed = true; },
  });
  await wait(80);
  wd.stop();
  await wait(180);
  assert.strictEqual(killed, false, 'stop() should cancel pending kill');
});

test('StreamWatchdog: double-start throws', () => {
  const wd = new StreamWatchdog('deepseek-chat', { warnMs: 1000, abortMs: 2000, killMs: 3000 });
  wd.start({ softAbort: () => {} });
  assert.throws(() => wd.start({ softAbort: () => {} }), /already started/);
  wd.stop();
});

test('StreamWatchdog: softAbort throw falls through to kill', async () => {
  const wd = new StreamWatchdog('deepseek-chat', { warnMs: 20, abortMs: 50, killMs: 100 });
  let killed = false;
  wd.start({
    softAbort: () => { throw new Error('soft abort failed'); },
    hardKill: () => { killed = true; },
  });
  await wait(160);
  assert.strictEqual(killed, true);
  wd.stop();
});

test('StreamStalledError: carries elapsed + model', () => {
  const err = new StreamStalledError(45_000, 'deepseek-chat');
  assert.strictEqual(err.name, 'StreamStalledError');
  assert.strictEqual(err.elapsedMs, 45_000);
  assert.strictEqual(err.model, 'deepseek-chat');
  assert.match(err.message, /stalled 45000ms on deepseek-chat/);
});
