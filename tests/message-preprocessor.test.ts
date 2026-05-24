import { describe, test } from 'node:test';
import assert from 'node:assert';
import { preprocessMessages } from '../src/executor/message-preprocessor';
import { resetCompressorState } from '../src/executor/context-compressor';
import { estimateTokens } from '../src/executor/token-budget';

interface Message {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

function msg(role: string, content: string | null): Message {
  return { role, content };
}

function toolResult(content: string, toolCallId: string = 'tc1'): Message {
  return { role: 'tool', content, tool_call_id: toolCallId };
}

describe('preprocessMessages — small conversations (under threshold)', () => {
  test('short conversations pass through unchanged', () => {
    resetCompressorState();
    const messages = [
      msg('system', 'You are helpful'),
      msg('user', 'hello'),
      msg('assistant', 'Hi!')
    ];
    const result = preprocessMessages(messages);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].content, 'You are helpful');
  });

  test('does not compress when under 50% context budget', () => {
    resetCompressorState();
    const messages: Message[] = [
      msg('system', 'sys'),
      ...Array.from({ length: 6 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', `msg${i}`)
      )
    ];
    const result = preprocessMessages(messages);
    assert.strictEqual(result.length, messages.length);
  });

  test('does not mutate input', () => {
    resetCompressorState();
    const messages: Message[] = [
      msg('user', 'hello'),
      msg('assistant', 'hi')
    ];
    const copy = JSON.parse(JSON.stringify(messages));
    preprocessMessages(messages);
    assert.deepStrictEqual(messages, copy);
  });

  test('returns a new array', () => {
    resetCompressorState();
    const messages: Message[] = [msg('user', 'hello'), msg('assistant', 'hi')];
    const result = preprocessMessages(messages);
    assert.notStrictEqual(result, messages);
  });
});

describe('preprocessMessages — large conversations (over threshold)', () => {
  test('compresses when over 50% context budget', () => {
    resetCompressorState();
    // Each message ~500 tokens → 60 messages = ~30K tokens = 100% of budget
    const messages: Message[] = [
      msg('system', 'system prompt'),
      ...Array.from({ length: 60 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(2000))
      )
    ];
    const result = preprocessMessages(messages);
    assert.ok(result.length < messages.length, 'should compress large conversations');
  });

  test('preserves system messages', () => {
    resetCompressorState();
    const messages: Message[] = [
      msg('system', 'system prompt'),
      ...Array.from({ length: 60 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(2000))
      )
    ];
    const result = preprocessMessages(messages);
    const systemMsgs = result.filter(m => m.role === 'system');
    const hasOriginalPrompt = systemMsgs.some(m => m.content === 'system prompt');
    assert.ok(hasOriginalPrompt, 'original system prompt must be preserved');
  });

  test('preserves most recent messages', () => {
    resetCompressorState();
    const messages: Message[] = [
      ...Array.from({ length: 60 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', `msg_${i}_${'x'.repeat(1500)}`)
      )
    ];
    const result = preprocessMessages(messages);
    // The last few messages should be present
    const lastOriginal = messages[messages.length - 1].content!.slice(0, 20);
    const hasLastMsg = result.some(m => m.content?.startsWith(lastOriginal));
    assert.ok(hasLastMsg, 'most recent messages should be preserved');
  });

  test('summary message has CONTEXT COMPACTION marker', () => {
    resetCompressorState();
    const messages: Message[] = [
      msg('system', 'sys'),
      ...Array.from({ length: 60 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', 'y'.repeat(2000))
      )
    ];
    const result = preprocessMessages(messages);
    const summary = result.find(m => m.content?.includes('CONTEXT COMPACTION'));
    assert.ok(summary, 'should have a CONTEXT COMPACTION summary');
  });
});

describe('preprocessMessages — tool output pruning', () => {
  test('prunes tool results with smart summaries in large conversations', () => {
    resetCompressorState();
    const toolCall = {
      id: 'tc1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"npm test"}' }
    };
    const bigResult = 'line\n'.repeat(500);
    // Need enough content to exceed 50% of 30K token budget (>15K tokens ≈ >60K chars)
    const messages: Message[] = [
      msg('system', 'sys'),
      ...Array.from({ length: 60 }, (_, i) => {
        if (i % 4 === 0) return msg('user', 'do thing ' + 'x'.repeat(2000));
        if (i % 4 === 1) return { role: 'assistant', content: null, tool_calls: [toolCall] };
        if (i % 4 === 2) return toolResult(bigResult);
        return msg('assistant', 'Done ' + 'x'.repeat(2000));
      })
    ];
    const result = preprocessMessages(messages);
    // Compression may reduce message count OR token count (tool results get smart summaries)
    const originalTokens = estimateTokens(messages);
    const compressedTokens = estimateTokens(result);
    assert.ok(
      result.length < messages.length || compressedTokens < originalTokens,
      `should compress: msgs ${messages.length}→${result.length}, tokens ${originalTokens}→${compressedTokens}`
    );
  });
});
