// Tests for src/executor/plan-mode-detector.ts.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';

import {
  shouldEnterPlanMode,
  formatPlanModePrompt,
  setPlanModeOverride,
  consumePlanModeOverride,
  getPlanModeOverride,
} from '../src/executor/plan-mode-detector';

beforeEach(() => {
  // Always start with no override
  setPlanModeOverride(null);
});

afterEach(() => {
  setPlanModeOverride(null);
});

describe('shouldEnterPlanMode — chinese refactor keyword', () => {
  test('"重构 src 目录" triggers plan mode', () => {
    const d = shouldEnterPlanMode('重构 src 目录');
    assert.strictEqual(d.shouldPlan, true);
    assert.match(d.reason ?? '', /complex-task keyword/);
    assert.ok(d.triggerKeywords?.includes('重构'));
  });
});

describe('shouldEnterPlanMode — simple greeting', () => {
  test('"你好" does not trigger', () => {
    const d = shouldEnterPlanMode('你好');
    assert.strictEqual(d.shouldPlan, false);
  });
});

describe('shouldEnterPlanMode — english deploy', () => {
  test('"deploy to production" triggers', () => {
    const d = shouldEnterPlanMode('deploy to production');
    assert.strictEqual(d.shouldPlan, true);
    assert.ok(d.triggerKeywords?.includes('deploy'));
  });
});

describe('shouldEnterPlanMode — long prompt', () => {
  test('250-char prompt triggers on length', () => {
    // Build a 250-char prompt that does NOT contain any trigger keyword,
    // multi-file pattern, or 3+ action verb. Use harmless filler.
    const filler = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm '.repeat(5);
    const prompt = filler.slice(0, 250);
    assert.strictEqual(prompt.length, 250);
    const d = shouldEnterPlanMode(prompt);
    assert.strictEqual(d.shouldPlan, true);
    assert.match(d.reason ?? '', /length/);
  });

  test('199-char prompt does NOT trigger on length alone', () => {
    const filler = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm '.repeat(5);
    const prompt = filler.slice(0, 199);
    const d = shouldEnterPlanMode(prompt);
    assert.strictEqual(d.shouldPlan, false);
  });
});

describe('shouldEnterPlanMode — multiple action verbs', () => {
  test('install + configure + test triggers', () => {
    const d = shouldEnterPlanMode(
      'please install the package, configure it, then test the result'
    );
    assert.strictEqual(d.shouldPlan, true);
    assert.match(d.reason ?? '', /action verbs/);
  });

  test('two action verbs without other triggers does NOT fire on action-verb rule', () => {
    // We pick verbs that are NOT trigger words themselves and avoid
    // multi-file patterns. "build" and "compile" are both action verbs but
    // neither is a complex-task keyword, so two of them alone should not
    // pass the threshold of three.
    const d = shouldEnterPlanMode('please build and compile the file');
    assert.strictEqual(d.shouldPlan, false);
  });
});

describe('shouldEnterPlanMode — single simple change', () => {
  test('renaming one variable does not trigger', () => {
    const d = shouldEnterPlanMode('rename the foo variable to bar');
    assert.strictEqual(d.shouldPlan, false);
  });
});

describe('shouldEnterPlanMode — chinese variants', () => {
  test('"重写" triggers', () => {
    const d = shouldEnterPlanMode('重写一下这个模块');
    assert.strictEqual(d.shouldPlan, true);
  });

  test('"批量" triggers', () => {
    const d = shouldEnterPlanMode('批量处理日志');
    assert.strictEqual(d.shouldPlan, true);
  });

  test('"部署" triggers', () => {
    const d = shouldEnterPlanMode('部署到生产环境');
    assert.strictEqual(d.shouldPlan, true);
  });
});

describe('shouldEnterPlanMode — edge cases', () => {
  test('empty prompt → false', () => {
    assert.strictEqual(shouldEnterPlanMode('').shouldPlan, false);
  });

  test('whitespace-only prompt → false', () => {
    assert.strictEqual(shouldEnterPlanMode('   \n\t  ').shouldPlan, false);
  });
});

describe('shouldEnterPlanMode — multi-file scope', () => {
  test('mention of src/ triggers', () => {
    const d = shouldEnterPlanMode('please look at src/foo.ts and update');
    assert.strictEqual(d.shouldPlan, true);
    assert.match(d.reason ?? '', /multi-file scope/);
  });

  test('"all .ts files" triggers', () => {
    const d = shouldEnterPlanMode('rename a function across all .ts files in the repo');
    assert.strictEqual(d.shouldPlan, true);
  });
});

describe('formatPlanModePrompt', () => {
  test('renders xml-ish wrapper with trigger attribute', () => {
    const out = formatPlanModePrompt({
      shouldPlan: true,
      reason: 'complex-task keyword: refactor',
      triggerKeywords: ['refactor'],
    });
    assert.match(out, /<plan-mode triggered_by="refactor">/);
    assert.match(out, /## Plan/);
    assert.match(out, /## Affected files/);
    assert.match(out, /## Confirmation/);
    assert.match(out, /<\/plan-mode>/);
  });

  test('escapes quotes in trigger keyword', () => {
    const out = formatPlanModePrompt({
      shouldPlan: true,
      triggerKeywords: ['evil"trigger'],
    });
    assert.ok(!/triggered_by="evil"trigger"/.test(out), 'must escape double quotes');
    assert.match(out, /triggered_by="evil&quot;trigger"/);
  });
});

describe('manual override (/plan)', () => {
  test('setPlanModeOverride(true) → consume returns shouldPlan true', () => {
    setPlanModeOverride(true);
    assert.strictEqual(getPlanModeOverride(), true);
    const d = consumePlanModeOverride();
    assert.ok(d);
    assert.strictEqual(d!.shouldPlan, true);
    // One-shot: after consume, override is cleared.
    assert.strictEqual(getPlanModeOverride(), null);
    assert.strictEqual(consumePlanModeOverride(), null);
  });

  test('setPlanModeOverride(false) → consume returns shouldPlan false', () => {
    setPlanModeOverride(false);
    const d = consumePlanModeOverride();
    assert.ok(d);
    assert.strictEqual(d!.shouldPlan, false);
    assert.strictEqual(getPlanModeOverride(), null);
  });

  test('null override → consume returns null (use heuristic)', () => {
    setPlanModeOverride(null);
    assert.strictEqual(consumePlanModeOverride(), null);
  });
});
