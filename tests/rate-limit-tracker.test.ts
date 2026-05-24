import { describe, test } from 'node:test';
import assert from 'node:assert';
import { RateLimitTracker } from '../src/executor/rate-limit-tracker';

describe('RateLimitTracker', () => {
  test('update() with remaining=5 records snapshot correctly', () => {
    const t = new RateLimitTracker();
    t.update({
      'x-ratelimit-remaining-requests': '5',
      'x-ratelimit-remaining-tokens': '12345',
      'x-ratelimit-reset-requests': '30s',
      'x-ratelimit-reset-tokens': '60s'
    });
    const snap = t.getSnapshot();
    assert.strictEqual(snap.requestsRemaining, 5);
    assert.strictEqual(snap.tokensRemaining, 12345);
    const now = Date.now();
    // Allow generous timing slack — these are 30s and 60s from now
    assert.ok(snap.requestsResetAt !== undefined);
    assert.ok(snap.tokensResetAt !== undefined);
    assert.ok(Math.abs((snap.requestsResetAt as number) - (now + 30_000)) < 1000);
    assert.ok(Math.abs((snap.tokensResetAt as number) - (now + 60_000)) < 1000);
  });

  test('shouldSleepBeforeNext returns 0 when budget is healthy', () => {
    const t = new RateLimitTracker();
    t.update({
      'x-ratelimit-remaining-requests': '500',
      'x-ratelimit-reset-requests': '60s'
    });
    assert.strictEqual(t.shouldSleepBeforeNext(), 0);
  });

  test('shouldSleepBeforeNext returns ms-until-reset when remaining<=2 AND reset<30s', () => {
    const t = new RateLimitTracker();
    t.update({
      'x-ratelimit-remaining-requests': '1',
      'x-ratelimit-reset-requests': '5s'  // 5_000 ms from now
    });
    const ms = t.shouldSleepBeforeNext();
    assert.ok(ms > 0 && ms <= 5_000, `expected wait between (0, 5000], got ${ms}`);
  });

  test('shouldSleepBeforeNext returns 0 when remaining<=2 BUT reset is far away', () => {
    const t = new RateLimitTracker();
    t.update({
      'x-ratelimit-remaining-requests': '1',
      'x-ratelimit-reset-requests': '120s'  // 2 minutes — outside 30s critical window
    });
    assert.strictEqual(t.shouldSleepBeforeNext(), 0);
  });

  test('retry-after: 5 (seconds) → returns ~5000 ms', () => {
    const t = new RateLimitTracker();
    t.update({ 'retry-after': '5' });
    const ms = t.shouldSleepBeforeNext();
    assert.ok(ms > 4_000 && ms <= 5_000, `expected ~5000ms, got ${ms}`);
  });

  test('case-insensitive header lookup', () => {
    const t = new RateLimitTracker();
    t.update({ 'X-RateLimit-Remaining-Requests': '7' });
    assert.strictEqual(t.getSnapshot().requestsRemaining, 7);
  });

  test('Headers object (fetch-style) is supported', () => {
    const headers = new Headers();
    headers.set('x-ratelimit-remaining-requests', '42');
    headers.set('x-ratelimit-reset-requests', '10s');
    const t = new RateLimitTracker();
    t.update(headers);
    assert.strictEqual(t.getSnapshot().requestsRemaining, 42);
  });

  test('parses bare-seconds reset values (legacy form)', () => {
    const t = new RateLimitTracker();
    t.update({
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-reset-requests': '10' // 10 seconds
    });
    const ms = t.shouldSleepBeforeNext();
    assert.ok(ms > 9_000 && ms <= 10_000, `expected ~10s wait, got ${ms}`);
  });

  test('parses composite duration like "1m30s"', () => {
    const t = new RateLimitTracker();
    t.update({
      'x-ratelimit-remaining-requests': '500',
      'x-ratelimit-reset-requests': '1m30s'
    });
    const snap = t.getSnapshot();
    const expected = Date.now() + 90_000;
    assert.ok(Math.abs((snap.requestsResetAt as number) - expected) < 1000);
  });

  test('partial updates retain previously seen values', () => {
    const t = new RateLimitTracker();
    t.update({ 'x-ratelimit-remaining-requests': '50' });
    t.update({ 'x-ratelimit-remaining-tokens': '999' });
    const snap = t.getSnapshot();
    assert.strictEqual(snap.requestsRemaining, 50);
    assert.strictEqual(snap.tokensRemaining, 999);
  });
});
