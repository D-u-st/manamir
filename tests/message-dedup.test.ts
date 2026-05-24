import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

import { MessageDedup } from '../src/channel/message-dedup';

function sha1(s: string): string {
  return createHash('sha1').update(s, 'utf-8').digest('hex');
}

let testDir: string;
let persistPath: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'manamir-dedup-'));
  persistPath = join(testDir, 'dedup.jsonl');
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('MessageDedup', () => {
  test('new message is not duplicate, then recorded', () => {
    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0 });
    const msg = { id: '1', channelId: 'c', userId: 'u', content: 'hello' };
    assert.strictEqual(dedup.isDuplicate(msg), false);
    // Second call with same id → duplicate
    assert.strictEqual(dedup.isDuplicate(msg), true);
  });

  test('same id within window → duplicate', () => {
    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0, windowMs: 60_000 });
    const msg = { id: '42', channelId: 'c', userId: 'u', content: 'hi' };
    dedup.isDuplicate(msg);
    assert.strictEqual(dedup.isDuplicate(msg), true);
    assert.strictEqual(dedup.isDuplicate(msg), true);
  });

  test('different id, same content → not duplicate', () => {
    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0 });
    assert.strictEqual(
      dedup.isDuplicate({ id: 'a', channelId: 'c', userId: 'u', content: 'same' }),
      false
    );
    assert.strictEqual(
      dedup.isDuplicate({ id: 'b', channelId: 'c', userId: 'u', content: 'same' }),
      false
    );
    assert.strictEqual(
      dedup.isDuplicate({ id: 'c', channelId: 'c', userId: 'u', content: 'same' }),
      false
    );
  });

  test('old entries beyond window are pruned on reload', async () => {
    // Manually write an old entry + a fresh one; load should keep only fresh.
    const nowOld = Date.now() - 3_600_000 * 2; // 2 hours ago
    const nowFresh = Date.now();
    const oldEntry = {
      messageId: 'old',
      channelId: 'c',
      userId: 'u',
      receivedAt: nowOld,
      contentHash: sha1('old-content')
    };
    const freshEntry = {
      messageId: 'fresh',
      channelId: 'c',
      userId: 'u',
      receivedAt: nowFresh,
      contentHash: sha1('fresh-content')
    };
    writeFileSync(
      persistPath,
      JSON.stringify(oldEntry) + '\n' + JSON.stringify(freshEntry) + '\n'
    );

    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0, windowMs: 3_600_000 });
    await dedup.load();

    // Fresh entry should still be recognized as duplicate
    assert.strictEqual(
      dedup.isDuplicate({ id: 'fresh', channelId: 'c', userId: 'u', content: 'fresh-content' }),
      true
    );
    // Old entry was pruned → a new send counts as first
    assert.strictEqual(
      dedup.isDuplicate({ id: 'old', channelId: 'c', userId: 'u', content: 'old-content' }),
      false
    );
  });

  test('maxEntries eviction removes oldest', () => {
    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0, maxEntries: 3 });
    dedup.isDuplicate({ id: '1', channelId: 'c', userId: 'u', content: 'a' });
    dedup.isDuplicate({ id: '2', channelId: 'c', userId: 'u', content: 'b' });
    dedup.isDuplicate({ id: '3', channelId: 'c', userId: 'u', content: 'c' });
    dedup.isDuplicate({ id: '4', channelId: 'c', userId: 'u', content: 'd' });

    assert.strictEqual(dedup.stats().windowSize, 3);
    // Oldest ('1') should have been evicted → not a duplicate now
    assert.strictEqual(
      dedup.isDuplicate({ id: '1', channelId: 'c', userId: 'u', content: 'a' }),
      false
    );
    // '4' should still be present
    assert.strictEqual(
      dedup.isDuplicate({ id: '4', channelId: 'c', userId: 'u', content: 'd' }),
      true
    );
  });

  test('flush + reload preserves state', async () => {
    const dedup1 = new MessageDedup({ persistPath, flushIntervalMs: 0 });
    dedup1.isDuplicate({ id: 'p1', channelId: 'c', userId: 'u', content: 'persist-me' });
    dedup1.isDuplicate({ id: 'p2', channelId: 'c', userId: 'u', content: 'persist-me-2' });
    await dedup1.flush();

    assert.ok(existsSync(persistPath), 'persist file should exist');

    const dedup2 = new MessageDedup({ persistPath, flushIntervalMs: 0 });
    await dedup2.load();
    assert.strictEqual(
      dedup2.isDuplicate({ id: 'p1', channelId: 'c', userId: 'u', content: 'persist-me' }),
      true
    );
    assert.strictEqual(
      dedup2.isDuplicate({ id: 'p2', channelId: 'c', userId: 'u', content: 'persist-me-2' }),
      true
    );
  });

  test('hash mismatch on same id is still duplicate and logs warning', (t) => {
    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0 });
    const warnings: string[] = [];

    // Intercept console.warn (logger.ts writes warnings there)
    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(String(msg));
    };
    t.after(() => {
      console.warn = originalWarn;
    });

    dedup.isDuplicate({ id: 'x', channelId: 'c', userId: 'u', content: 'original' });
    const result = dedup.isDuplicate({
      id: 'x',
      channelId: 'c',
      userId: 'u',
      content: 'TAMPERED'
    });

    assert.strictEqual(result, true, 'still duplicate');
    const mismatchLogs = warnings.filter((w) =>
      w.includes('content mismatch on duplicate id')
    );
    assert.ok(mismatchLogs.length >= 1, 'expected mismatch warning');
  });

  test('partial / corrupt JSONL line is skipped gracefully', async () => {
    const goodEntry = {
      messageId: 'good',
      channelId: 'c',
      userId: 'u',
      receivedAt: Date.now(),
      contentHash: sha1('good')
    };
    // Three lines: valid, garbage JSON, partial object (truncated).
    const content =
      JSON.stringify(goodEntry) +
      '\n' +
      '{"broken":' +
      '\n' +
      '{"messageId":"partial","channelId":"c",' +
      '\n';
    writeFileSync(persistPath, content);

    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0 });
    await dedup.load();

    // The good entry should be recognized.
    assert.strictEqual(
      dedup.isDuplicate({ id: 'good', channelId: 'c', userId: 'u', content: 'good' }),
      true
    );
    // Partial should NOT be loaded.
    assert.strictEqual(
      dedup.isDuplicate({ id: 'partial', channelId: 'c', userId: 'u', content: 'whatever' }),
      false
    );
  });

  test('empty content is handled deterministically', () => {
    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0 });
    const first = dedup.isDuplicate({ id: 'e1', channelId: 'c', userId: 'u', content: '' });
    const second = dedup.isDuplicate({ id: 'e1', channelId: 'c', userId: 'u', content: '' });
    assert.strictEqual(first, false);
    assert.strictEqual(second, true);

    // A different id with empty content is still new.
    assert.strictEqual(
      dedup.isDuplicate({ id: 'e2', channelId: 'c', userId: 'u', content: '' }),
      false
    );
  });

  test('unicode / emoji content hashed via UTF-8 bytes', async () => {
    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0 });
    const unicode = 'こんにちは 🌸 emoji';
    const expectedHash = sha1(unicode);

    dedup.isDuplicate({ id: 'u1', channelId: 'c', userId: 'u', content: unicode });
    await dedup.flush();

    const raw = readFileSync(persistPath, 'utf-8').trim();
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.contentHash, expectedHash);
  });

  test('stats reflect counts', () => {
    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0 });
    assert.deepStrictEqual(dedup.stats(), {
      totalSeen: 0,
      duplicatesRejected: 0,
      windowSize: 0
    });

    dedup.isDuplicate({ id: 'a', channelId: 'c', userId: 'u', content: 'x' });
    dedup.isDuplicate({ id: 'a', channelId: 'c', userId: 'u', content: 'x' });
    dedup.isDuplicate({ id: 'b', channelId: 'c', userId: 'u', content: 'y' });

    const s = dedup.stats();
    assert.strictEqual(s.totalSeen, 3);
    assert.strictEqual(s.duplicatesRejected, 1);
    assert.strictEqual(s.windowSize, 2);
  });

  test('record() adds entry without checking and does not increment totalSeen', () => {
    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0 });
    dedup.record({ id: 'r1', channelId: 'c', userId: 'u', content: 'only-record' });
    const s = dedup.stats();
    assert.strictEqual(s.totalSeen, 0);
    assert.strictEqual(s.windowSize, 1);

    // Next isDuplicate on same id → true, counted as duplicate.
    assert.strictEqual(
      dedup.isDuplicate({ id: 'r1', channelId: 'c', userId: 'u', content: 'only-record' }),
      true
    );
    assert.strictEqual(dedup.stats().duplicatesRejected, 1);
  });

  test('reload prunes stale entries (older than windowMs)', async () => {
    // Write a mix: very old, borderline old, fresh.
    const windowMs = 10_000; // 10s window for the test
    const now = Date.now();
    const entries = [
      { messageId: 'stale-1', channelId: 'c', userId: 'u', receivedAt: now - 60_000, contentHash: sha1('1') },
      { messageId: 'stale-2', channelId: 'c', userId: 'u', receivedAt: now - 20_000, contentHash: sha1('2') },
      { messageId: 'fresh-1', channelId: 'c', userId: 'u', receivedAt: now - 1_000, contentHash: sha1('3') }
    ];
    writeFileSync(persistPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0, windowMs });
    await dedup.load();

    assert.strictEqual(dedup.stats().windowSize, 1);
    assert.strictEqual(
      dedup.isDuplicate({ id: 'fresh-1', channelId: 'c', userId: 'u', content: '3' }),
      true
    );
    assert.strictEqual(
      dedup.isDuplicate({ id: 'stale-1', channelId: 'c', userId: 'u', content: '1' }),
      false
    );
  });

  test('concurrent isDuplicate calls with same id — 1 false, rest true', async () => {
    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0 });
    const msg = { id: 'race', channelId: 'c', userId: 'u', content: 'fight!' };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => Promise.resolve().then(() => dedup.isDuplicate(msg)))
    );
    const falses = results.filter((r) => r === false).length;
    const trues = results.filter((r) => r === true).length;
    assert.strictEqual(falses, 1, 'exactly one should be first-seen');
    assert.strictEqual(trues, 9, 'the other nine should be duplicates');
  });

  test('auto-flush via setInterval persists state', async () => {
    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 25 });
    dedup.startAutoFlush();

    dedup.isDuplicate({ id: 'auto-1', channelId: 'c', userId: 'u', content: 'auto' });

    // Wait for the auto-flush to fire.
    await new Promise((resolve) => setTimeout(resolve, 100));

    dedup.stopAutoFlush();

    assert.ok(existsSync(persistPath), 'auto-flush should have created the file');
    const raw = readFileSync(persistPath, 'utf-8').trim();
    assert.ok(raw.length > 0, 'file should not be empty after auto-flush');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.messageId, 'auto-1');
  });

  test('load on missing file creates directory and is a no-op', async () => {
    const nested = join(testDir, 'sub', 'nested', 'dedup.jsonl');
    const dedup = new MessageDedup({ persistPath: nested, flushIntervalMs: 0 });
    await dedup.load();
    assert.strictEqual(dedup.stats().windowSize, 0);
    // Directory should exist now (ready for flush).
    assert.ok(existsSync(join(testDir, 'sub', 'nested')), 'parent dir created');
  });

  test('flush after many entries writes one JSONL line per entry', async () => {
    const dedup = new MessageDedup({ persistPath, flushIntervalMs: 0 });
    for (let i = 0; i < 25; i++) {
      dedup.isDuplicate({ id: `m${i}`, channelId: 'c', userId: 'u', content: `body-${i}` });
    }
    await dedup.flush();

    const raw = readFileSync(persistPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    assert.strictEqual(lines.length, 25);
    // Every line must parse.
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(typeof parsed.messageId === 'string');
      assert.ok(typeof parsed.contentHash === 'string');
    }
  });
});
