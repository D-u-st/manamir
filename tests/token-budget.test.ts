import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  estimateStringTokens,
  estimateTokens,
  isOverBudget,
  MAX_CONTEXT_TOKENS
} from '../src/executor/token-budget';

describe('estimateStringTokens', () => {
  test('returns 0 for empty string', () => {
    assert.strictEqual(estimateStringTokens(''), 0);
  });

  test('returns 0 for null/undefined-ish input', () => {
    assert.strictEqual(estimateStringTokens(null as any), 0);
    assert.strictEqual(estimateStringTokens(undefined as any), 0);
  });

  test('estimates roughly chars/4', () => {
    const text = 'Hello, world!'; // 13 chars -> ceil(13/4) = 4
    assert.strictEqual(estimateStringTokens(text), Math.ceil(13 / 4));
  });

  test('handles single character', () => {
    assert.strictEqual(estimateStringTokens('a'), 1);
  });

  test('handles exactly divisible length', () => {
    assert.strictEqual(estimateStringTokens('abcd'), 1); // 4/4 = 1
  });

  test('handles long string', () => {
    const text = 'x'.repeat(1000);
    assert.strictEqual(estimateStringTokens(text), 250);
  });
});

describe('estimateTokens', () => {
  test('returns 0 for empty array', () => {
    assert.strictEqual(estimateTokens([]), 0);
  });

  test('adds 4 tokens overhead per message', () => {
    const messages = [
      { role: 'user', content: '' }
    ];
    // 4 overhead + 0 content = 4
    assert.strictEqual(estimateTokens(messages), 4);
  });

  test('estimates content tokens plus overhead', () => {
    const messages = [
      { role: 'user', content: 'Hello, world!' } // 4 overhead + ceil(13/4) = 4 + 4 = 8
    ];
    assert.strictEqual(estimateTokens(messages), 8);
  });

  test('handles null content', () => {
    const messages = [
      { role: 'assistant', content: null }
    ];
    assert.strictEqual(estimateTokens(messages), 4);
  });

  test('includes tool_calls token estimate', () => {
    const toolCalls = [{ id: 'tc1', function: { name: 'test', arguments: '{}' } }];
    const messages = [
      { role: 'assistant', content: null, tool_calls: toolCalls }
    ];
    const tokens = estimateTokens(messages);
    const expectedToolTokens = Math.ceil(JSON.stringify(toolCalls).length / 4);
    assert.strictEqual(tokens, 4 + expectedToolTokens);
  });

  test('sums multiple messages', () => {
    const messages = [
      { role: 'user', content: 'Hi' },      // 4 + 1 = 5
      { role: 'assistant', content: 'Hello' } // 4 + 2 = 6
    ];
    assert.strictEqual(estimateTokens(messages), 11);
  });
});

describe('isOverBudget', () => {
  test('returns false for empty messages', () => {
    assert.strictEqual(isOverBudget([]), false);
  });

  test('returns false when under budget', () => {
    const messages = [{ role: 'user', content: 'short' }];
    assert.strictEqual(isOverBudget(messages), false);
  });

  test('returns true when over budget', () => {
    const bigContent = 'x'.repeat(MAX_CONTEXT_TOKENS * 4 + 100);
    const messages = [{ role: 'user', content: bigContent }];
    assert.strictEqual(isOverBudget(messages), true);
  });

  test('respects custom maxTokens', () => {
    const messages = [{ role: 'user', content: 'x'.repeat(40) }]; // 4 + 10 = 14 tokens
    assert.strictEqual(isOverBudget(messages, 20), false);
    assert.strictEqual(isOverBudget(messages, 10), true);
  });

  test('MAX_CONTEXT_TOKENS is 30000', () => {
    assert.strictEqual(MAX_CONTEXT_TOKENS, 30_000);
  });
});
