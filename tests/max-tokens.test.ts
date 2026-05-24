import { test } from 'node:test';
import assert from 'node:assert';
import { TokenBudget, getModelTokenLimits, BUMP_AFTER_HITS } from '../src/executor/max-tokens.js';

test('getModelTokenLimits: known model', () => {
  const lim = getModelTokenLimits('deepseek-chat');
  assert.strictEqual(lim.apiMax, 8192);
  assert.strictEqual(lim.baseline, 4096);
});

test('getModelTokenLimits: reasoner has higher ceiling', () => {
  const lim = getModelTokenLimits('deepseek-reasoner');
  assert.strictEqual(lim.sessionCeiling, 32768);
});

test('getModelTokenLimits: prefix match', () => {
  const lim = getModelTokenLimits('deepseek-chat-v3');
  assert.strictEqual(lim.baseline, 4096);
});

test('getModelTokenLimits: unknown falls to default', () => {
  const lim = getModelTokenLimits('exotic-model');
  assert.strictEqual(lim.baseline, 4096);
});

test('TokenBudget: defaults to baseline', () => {
  const tb = new TokenBudget('deepseek-chat');
  assert.strictEqual(tb.cap, 4096);
});

test('TokenBudget: user override respected (within apiMax)', () => {
  const tb = new TokenBudget('deepseek-chat', 6000);
  assert.strictEqual(tb.cap, 6000);
});

test('TokenBudget: user override capped at apiMax', () => {
  const tb = new TokenBudget('deepseek-chat', 99999);
  assert.strictEqual(tb.cap, 8192);
});

test('TokenBudget: single length hit does not bump', () => {
  const tb = new TokenBudget('deepseek-chat');
  tb.observeStopReason('length');
  assert.strictEqual(tb.cap, 4096, 'single hit should not bump (need 2)');
});

test('TokenBudget: BUMP_AFTER_HITS consecutive length hits → bump', () => {
  const tb = new TokenBudget('deepseek-chat');
  for (let i = 0; i < BUMP_AFTER_HITS; i++) tb.observeStopReason('length');
  assert.strictEqual(tb.cap, 4096 + 2048);
  assert.strictEqual(tb.stats.bumpsApplied, 1);
});

test('TokenBudget: clean stop resets counter', () => {
  const tb = new TokenBudget('deepseek-chat');
  tb.observeStopReason('length');
  tb.observeStopReason('stop');
  tb.observeStopReason('length');
  assert.strictEqual(tb.cap, 4096, 'clean stop should reset, no bump');
});

test('TokenBudget: bumps cap at sessionCeiling', () => {
  const tb = new TokenBudget('deepseek-chat');
  // Hit length many times — should plateau at sessionCeiling 8192
  for (let i = 0; i < 20; i++) tb.observeStopReason('length');
  assert.strictEqual(tb.cap, 8192, 'cap should not exceed sessionCeiling');
});

test('TokenBudget: max_tokens treated like length', () => {
  const tb = new TokenBudget('deepseek-chat');
  for (let i = 0; i < BUMP_AFTER_HITS; i++) tb.observeStopReason('max_tokens');
  assert.strictEqual(tb.cap, 4096 + 2048);
});

test('TokenBudget: undefined reason does not modify state', () => {
  const tb = new TokenBudget('deepseek-chat');
  tb.observeStopReason('length');
  tb.observeStopReason(undefined);
  tb.observeStopReason('length');
  // Two length hits separated by undefined → still bump
  assert.strictEqual(tb.cap, 4096 + 2048);
});

test('TokenBudget: wasTruncated static helper', () => {
  assert.strictEqual(TokenBudget.wasTruncated('length'), true);
  assert.strictEqual(TokenBudget.wasTruncated('max_tokens'), true);
  assert.strictEqual(TokenBudget.wasTruncated('stop'), false);
  assert.strictEqual(TokenBudget.wasTruncated('tool_calls'), false);
  assert.strictEqual(TokenBudget.wasTruncated(undefined), false);
});

test('TokenBudget: stats include all fields', () => {
  const tb = new TokenBudget('deepseek-reasoner');
  for (let i = 0; i < BUMP_AFTER_HITS; i++) tb.observeStopReason('length');
  const s = tb.stats;
  assert.strictEqual(s.cap, 8192 + 4096);
  assert.strictEqual(s.bumpsApplied, 1);
  assert.strictEqual(s.ceiling, 32768);
  assert.strictEqual(s.lengthHits, 0); // reset after bump
});
