import { describe, test } from 'node:test';
import assert from 'node:assert';
import { LoopDetector } from '../src/autonomous/loop-detector';

describe('LoopDetector — basic detection', () => {
  test('single output returns ok', () => {
    const ld = new LoopDetector();
    assert.strictEqual(ld.record('output1'), 'ok');
  });

  test('two identical outputs returns ok (below warning threshold)', () => {
    const ld = new LoopDetector();
    ld.record('same');
    assert.strictEqual(ld.record('same'), 'ok');
  });

  test('3 identical outputs triggers warning', () => {
    const ld = new LoopDetector();
    ld.record('same');
    ld.record('same');
    assert.strictEqual(ld.record('same'), 'warning');
  });

  test('5 identical outputs triggers critical', () => {
    const ld = new LoopDetector();
    for (let i = 0; i < 4; i++) ld.record('same');
    assert.strictEqual(ld.record('same'), 'critical');
  });

  test('different outputs stay ok', () => {
    const ld = new LoopDetector();
    // Use truly distinct strings so character-overlap similarity stays below 0.8
    assert.strictEqual(ld.record('the quick brown fox jumps'), 'ok');
    assert.strictEqual(ld.record('xyz 12345 @@@ !!!'), 'ok');
    assert.strictEqual(ld.record('QQQQWWWWEEEE'), 'ok');
    assert.strictEqual(ld.record('mnbvcxz lkjhgfdsa'), 'ok');
    assert.strictEqual(ld.record('99 bottles of milk'), 'ok');
  });

  test('breaking the streak resets to ok', () => {
    const ld = new LoopDetector();
    ld.record('same');
    ld.record('same');
    ld.record('same'); // warning
    assert.strictEqual(ld.record('different'), 'ok');
  });
});

describe('LoopDetector — getLevel', () => {
  test('returns current level', () => {
    const ld = new LoopDetector();
    assert.strictEqual(ld.getLevel(), 'ok');
    ld.record('x');
    ld.record('x');
    ld.record('x');
    assert.strictEqual(ld.getLevel(), 'warning');
  });
});

describe('LoopDetector — reset', () => {
  test('clears state and returns to ok', () => {
    const ld = new LoopDetector();
    ld.record('x');
    ld.record('x');
    ld.record('x');
    assert.strictEqual(ld.getLevel(), 'warning');
    ld.reset();
    assert.strictEqual(ld.getLevel(), 'ok');
  });

  test('after reset, fresh outputs start clean', () => {
    const ld = new LoopDetector();
    for (let i = 0; i < 5; i++) ld.record('x');
    assert.strictEqual(ld.getLevel(), 'critical');
    ld.reset();
    assert.strictEqual(ld.record('x'), 'ok');
    assert.strictEqual(ld.record('x'), 'ok');
  });
});

describe('LoopDetector — similarity matching', () => {
  test('similar outputs (whitespace differences) count as same', () => {
    const ld = new LoopDetector();
    ld.record('hello   world');
    ld.record('hello world');
    assert.strictEqual(ld.record('hello  world'), 'warning');
  });

  test('sufficiently different outputs break the streak', () => {
    const ld = new LoopDetector();
    ld.record('completely different text one');
    ld.record('another totally unique message');
    ld.record('yet another unrelated output text');
    assert.strictEqual(ld.getLevel(), 'ok');
  });
});

describe('LoopDetector — custom thresholds', () => {
  test('custom warningThreshold', () => {
    const ld = new LoopDetector({ warningThreshold: 2 });
    ld.record('x');
    assert.strictEqual(ld.record('x'), 'warning');
  });

  test('custom criticalThreshold', () => {
    const ld = new LoopDetector({ criticalThreshold: 3 });
    ld.record('x');
    ld.record('x');
    assert.strictEqual(ld.record('x'), 'critical');
  });
});

describe('LoopDetector — events', () => {
  test('emits warning event', () => {
    const ld = new LoopDetector();
    let emitted = false;
    ld.on('warning', () => { emitted = true; });
    ld.record('x');
    ld.record('x');
    ld.record('x');
    assert.strictEqual(emitted, true);
  });

  test('emits critical event', () => {
    const ld = new LoopDetector();
    let emitted = false;
    ld.on('critical', () => { emitted = true; });
    for (let i = 0; i < 5; i++) ld.record('x');
    assert.strictEqual(emitted, true);
  });

  test('warning event emitted only once on transition', () => {
    const ld = new LoopDetector();
    let count = 0;
    ld.on('warning', () => { count++; });
    ld.record('x');
    ld.record('x');
    ld.record('x'); // triggers warning
    ld.record('x'); // stays warning, no re-emit
    assert.strictEqual(count, 1);
  });
});

describe('LoopDetector — window size', () => {
  test('old entries fall out of window', () => {
    const ld = new LoopDetector({ windowSize: 3, warningThreshold: 3 });
    ld.record('x');
    ld.record('x');
    ld.record('different'); // breaks streak
    ld.record('x'); // window is now [x, different, x] — streak = 1
    assert.strictEqual(ld.getLevel(), 'ok');
  });
});
