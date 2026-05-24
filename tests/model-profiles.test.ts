import { describe, test } from 'node:test';
import assert from 'node:assert';
import { getModelProfile } from '../src/executor/model-profiles';

describe('getModelProfile — exact matches', () => {
  test('deepseek-chat returns correct profile', () => {
    const profile = getModelProfile('deepseek-chat');
    assert.strictEqual(profile.maxTurns, 8);
    assert.strictEqual(profile.aggressiveToolUse, true);
    assert.deepStrictEqual(profile.firstTurnToolsOnly, ['bash', 'read']);
    assert.ok(profile.systemPromptHints.includes('concise'));
  });

  test('deepseek-reasoner returns correct profile', () => {
    const profile = getModelProfile('deepseek-reasoner');
    assert.strictEqual(profile.maxTurns, 6);
    assert.strictEqual(profile.aggressiveToolUse, true);
  });

  test('claude-sonnet returns correct profile', () => {
    const profile = getModelProfile('claude-sonnet');
    assert.strictEqual(profile.maxTurns, 15);
    assert.strictEqual(profile.aggressiveToolUse, false);
    assert.strictEqual(profile.firstTurnToolsOnly, null);
  });

  test('claude-opus returns correct profile', () => {
    const profile = getModelProfile('claude-opus');
    assert.strictEqual(profile.maxTurns, 15);
    assert.strictEqual(profile.aggressiveToolUse, false);
  });

  test('gpt-4o returns correct profile', () => {
    const profile = getModelProfile('gpt-4o');
    assert.strictEqual(profile.maxTurns, 12);
    assert.strictEqual(profile.firstTurnToolsOnly, null);
  });
});

describe('getModelProfile — prefix matching', () => {
  test('deepseek-chat-v3 matches deepseek-chat', () => {
    const profile = getModelProfile('deepseek-chat-v3');
    assert.strictEqual(profile.maxTurns, 8);
    assert.strictEqual(profile.aggressiveToolUse, true);
  });

  test('claude-sonnet-4-20250514 matches claude-sonnet', () => {
    const profile = getModelProfile('claude-sonnet-4-20250514');
    assert.strictEqual(profile.maxTurns, 15);
  });

  test('claude-opus-4 matches claude-opus', () => {
    const profile = getModelProfile('claude-opus-4');
    assert.strictEqual(profile.maxTurns, 15);
  });

  test('gpt-4o-mini matches gpt-4o', () => {
    const profile = getModelProfile('gpt-4o-mini');
    assert.strictEqual(profile.maxTurns, 12);
  });

  test('longest prefix wins when multiple match', () => {
    // "deepseek-chat" is longer than "deepseek-" (if it existed)
    // Just verifying deepseek-chat-xxx matches deepseek-chat specifically
    const profile = getModelProfile('deepseek-chat-something');
    assert.strictEqual(profile.maxTurns, 8);
  });
});

describe('getModelProfile — unknown models', () => {
  test('unknown model returns default profile', () => {
    const profile = getModelProfile('totally-unknown-model');
    assert.strictEqual(profile.maxTurns, 10);
    assert.strictEqual(profile.systemPromptHints, '');
    assert.strictEqual(profile.firstTurnToolsOnly, null);
    assert.strictEqual(profile.aggressiveToolUse, false);
  });

  test('empty string returns default profile', () => {
    const profile = getModelProfile('');
    assert.strictEqual(profile.maxTurns, 10);
  });

  test('partial non-matching prefix returns default', () => {
    // "deep" doesn't match "deepseek-chat" as a prefix (it's the other way around)
    const profile = getModelProfile('deep');
    assert.strictEqual(profile.maxTurns, 10);
  });
});
