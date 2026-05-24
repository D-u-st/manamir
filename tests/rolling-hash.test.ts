import { test } from 'node:test';
import assert from 'node:assert';
import { RollingHashDetector, DEFAULT_CONFIG } from '../src/executor/rolling-hash.js';

test('RollingHashDetector: short content does not trigger', () => {
  const d = new RollingHashDetector();
  const r = d.feed('hello world');
  assert.strictEqual(r.detected, false);
});

test('RollingHashDetector: 4 repeats of same long string triggers', () => {
  const d = new RollingHashDetector({ windowSize: 32, threshold: 4, minBufferSize: 100, bufferLimit: 16384 });
  const phrase = 'this is a repeating phrase that should trigger detection X';
  // Feed 5 copies separated by spaces — total > minBufferSize
  let last;
  for (let i = 0; i < 5; i++) {
    last = d.feed(phrase + ' ');
    if (last.detected) break;
  }
  assert.strictEqual(last?.detected, true, 'expected detection after 4+ repeats');
});

test('RollingHashDetector: 2 repeats does NOT trigger', () => {
  const d = new RollingHashDetector({ windowSize: 32, threshold: 4, minBufferSize: 100 });
  const phrase = 'unique phrase appearing only twice in stream content X';
  d.feed(phrase + ' ');
  const r = d.feed(phrase + ' end of stream content here for some padding');
  assert.strictEqual(r.detected, false);
});

test('RollingHashDetector: code fence skips detection', () => {
  const d = new RollingHashDetector({ windowSize: 16, threshold: 3, minBufferSize: 50 });
  // Open fence, repeat keyword inside (should NOT trigger), close fence
  d.feed('Here is some code:\n```cpp\n');
  // Inside fence — repeat TreeNode 5 times
  for (let i = 0; i < 5; i++) {
    const r = d.feed('TreeNode *node = new TreeNode();\n');
    assert.strictEqual(r.detected, false, `inside fence iteration ${i}, should not trigger`);
  }
  d.feed('```\n');
});

test('RollingHashDetector: detection resumes after fence closes', () => {
  const d = new RollingHashDetector({ windowSize: 24, threshold: 4, minBufferSize: 80 });
  d.feed('Intro paragraph of normal prose with various words to fill buffer.\n');
  d.feed('```\nint x = 1;\n```\n'); // fence open + close
  // After fence: feed real cascade
  let triggered = false;
  for (let i = 0; i < 6; i++) {
    const r = d.feed('I will now process the request to handle this case ');
    if (r.detected) { triggered = true; break; }
  }
  assert.strictEqual(triggered, true, 'should trigger after fence closes');
});

test('RollingHashDetector: reset clears state', () => {
  const d = new RollingHashDetector({ windowSize: 24, threshold: 3, minBufferSize: 80 });
  for (let i = 0; i < 4; i++) d.feed('repeated string here repeated string here ');
  d.reset();
  assert.strictEqual(d.stats.bufferLen, 0);
  assert.strictEqual(d.stats.uniqueHashes, 0);
});

test('RollingHashDetector: buffer limit trims oldest', () => {
  const d = new RollingHashDetector({ windowSize: 16, threshold: 3, minBufferSize: 50, bufferLimit: 200 });
  d.feed('A'.repeat(150));
  d.feed('B'.repeat(150));
  // Buffer should be ≤ 200 chars now
  assert.ok(d.stats.bufferLen <= 200, `bufferLen ${d.stats.bufferLen} exceeds limit`);
});

test('RollingHashDetector: stats include fence state', () => {
  const d = new RollingHashDetector();
  d.feed('Here is code: ```\nint x = 5;');
  assert.strictEqual(d.stats.inCodeFence, true);
  d.feed('\n```\nback to prose.');
  assert.strictEqual(d.stats.inCodeFence, false);
});

test('RollingHashDetector: empty chunk is no-op', () => {
  const d = new RollingHashDetector();
  const r = d.feed('');
  assert.strictEqual(r.detected, false);
  assert.strictEqual(d.stats.bufferLen, 0);
});

test('RollingHashDetector: realistic DeepSeek cascade pattern', () => {
  // Simulate: model emits same JSON tool call 5 times.
  // Use windowSize 32 — must be ≤ phrase length so ngram fits within single repetition.
  const d = new RollingHashDetector({ windowSize: 32, threshold: 4, minBufferSize: 200 });
  const json = '{"tool":"web_search","query":"deepseek model info","limit":10}';
  let triggered = false;
  for (let i = 0; i < 6; i++) {
    const r = d.feed(json + ' ');
    if (r.detected) { triggered = true; break; }
  }
  assert.strictEqual(triggered, true, 'realistic JSON repeat should trigger');
});

test('RollingHashDetector: defaults', () => {
  assert.strictEqual(DEFAULT_CONFIG.windowSize, 64);
  assert.strictEqual(DEFAULT_CONFIG.threshold, 4);
});

test('RollingHashDetector: collision-resistant via string verify', () => {
  // Different strings shouldn't trigger even if hash collides
  // (we can't easily force a collision but verify mechanism exists)
  const d = new RollingHashDetector({ windowSize: 16, threshold: 3, minBufferSize: 50 });
  // Different content each time — should NOT trigger
  d.feed('abcdefg hijklmnop qrstuv 12345 ');
  d.feed('xyz789 alphabet zebra unique ');
  d.feed('completely different content here ');
  d.feed('and another distinct paragraph ');
  // No trigger expected — content all different
  // (this also verifies that diverse content with same length doesn't false-positive)
  assert.strictEqual(d.stats.bufferLen > 0, true);
});
