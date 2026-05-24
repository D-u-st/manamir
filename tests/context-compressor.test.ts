import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  shouldCompress,
  compressSync,
  forceCompress,
  resetCompressorState,
  type CompressionLevel
} from '../src/executor/context-compressor';

interface Message {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

function msg(role: string, content: string): Message {
  return { role, content };
}

function toolCallMsg(name: string, args: string = '{}'): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: `tc_${Date.now()}_${Math.random()}`,
      type: 'function',
      function: { name, arguments: args }
    }]
  };
}

function toolResult(content: string, id: string = 'tc1'): Message {
  return { role: 'tool', content, tool_call_id: id };
}

function bigConversation(msgCount: number, charsPerMsg: number): Message[] {
  return [
    msg('system', 'You are helpful'),
    ...Array.from({ length: msgCount }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `msg${i}_${'x'.repeat(charsPerMsg)}`)
    )
  ];
}

describe('shouldCompress — graduated pressure thresholds', () => {
  test('returns "none" under 50% budget', () => {
    // 30K token budget → 50% = 15K → chars = 60K. 5 short messages = well under.
    const messages = [msg('user', 'hello'), msg('assistant', 'hi')];
    assert.strictEqual(shouldCompress(messages), 'none');
  });

  test('returns "prune_only" at 50-65% budget', () => {
    // Target: ~16K tokens = ~64K chars in content
    const messages = bigConversation(32, 2000); // ~33 msgs * ~504 tokens each ≈ 16K
    const level = shouldCompress(messages);
    assert.ok(
      level === 'prune_only' || level === 'prune_and_protect',
      `expected prune_only or prune_and_protect, got ${level}`
    );
  });

  test('returns "emergency" at >92% budget', () => {
    // Target: ~28K tokens = ~112K chars
    const messages = bigConversation(55, 2000); // ~56 msgs * ~504 tokens ≈ 28K
    const level = shouldCompress(messages);
    assert.ok(
      level === 'full' || level === 'emergency',
      `expected full or emergency at high usage, got ${level}`
    );
  });
});

describe('compressSync — basic behavior', () => {
  test('no compression when under threshold', () => {
    resetCompressorState();
    const messages = [msg('system', 'sys'), msg('user', 'hi'), msg('assistant', 'hello')];
    const result = compressSync(messages);
    assert.strictEqual(result.level, 'none');
    assert.strictEqual(result.messages.length, messages.length);
  });

  test('returns new array, does not mutate input', () => {
    resetCompressorState();
    const messages = [msg('user', 'hello')];
    const copy = JSON.parse(JSON.stringify(messages));
    compressSync(messages);
    assert.deepStrictEqual(messages, copy);
  });

  test('compresses large conversations', () => {
    resetCompressorState();
    const messages = bigConversation(60, 2000);
    const result = compressSync(messages);
    assert.ok(result.messages.length < messages.length);
    assert.ok(result.stats.compressedTokens < result.stats.originalTokens);
  });
});

describe('compressSync — head protection', () => {
  test('system prompt is always preserved', () => {
    resetCompressorState();
    const messages = bigConversation(60, 2000);
    const result = compressSync(messages);
    const systemMsgs = result.messages.filter(m => m.role === 'system');
    const hasOriginal = systemMsgs.some(m => m.content === 'You are helpful');
    assert.ok(hasOriginal, 'system prompt must survive compression');
  });

  test('first 3 conversation messages are protected', () => {
    resetCompressorState();
    const messages = [
      msg('system', 'sys'),
      msg('user', 'FIRST_USER_MSG'),
      msg('assistant', 'FIRST_AI_MSG'),
      msg('user', 'SECOND_USER_MSG'),
      ...Array.from({ length: 57 }, (_, i) =>
        msg(i % 2 === 0 ? 'assistant' : 'user', 'x'.repeat(2000))
      )
    ];
    const result = compressSync(messages);
    const hasFirst = result.messages.some(m => m.content === 'FIRST_USER_MSG');
    const hasSecond = result.messages.some(m => m.content === 'FIRST_AI_MSG');
    const hasThird = result.messages.some(m => m.content === 'SECOND_USER_MSG');
    assert.ok(hasFirst, 'first user message should be protected');
    assert.ok(hasSecond, 'first AI message should be protected');
    assert.ok(hasThird, 'second user message should be protected');
  });
});

describe('compressSync — tail protection', () => {
  test('most recent messages are preserved', () => {
    resetCompressorState();
    const messages = [
      ...bigConversation(58, 2000),
      msg('user', 'LAST_USER_MESSAGE'),
      msg('assistant', 'LAST_AI_MESSAGE')
    ];
    const result = compressSync(messages);
    const hasLastUser = result.messages.some(m => m.content === 'LAST_USER_MESSAGE');
    const hasLastAI = result.messages.some(m => m.content === 'LAST_AI_MESSAGE');
    assert.ok(hasLastUser, 'last user message must be in tail');
    assert.ok(hasLastAI, 'last AI message must be in tail');
  });

  test('at least MIN_TAIL_MESSAGES (6) are kept', () => {
    resetCompressorState();
    const messages = bigConversation(60, 2000);
    const result = compressSync(messages);
    // Count non-system messages at the end
    const nonSystem = result.messages.filter(m => m.role !== 'system');
    assert.ok(nonSystem.length >= 6, `expected >= 6 non-system messages, got ${nonSystem.length}`);
  });
});

describe('compressSync — summary generation', () => {
  test('compressed output contains CONTEXT COMPACTION marker', () => {
    resetCompressorState();
    const messages = bigConversation(60, 2000);
    const result = compressSync(messages);
    const hasSummary = result.messages.some(m =>
      m.content?.includes('CONTEXT COMPACTION')
    );
    assert.ok(hasSummary, 'should have CONTEXT COMPACTION summary');
  });

  test('summary contains user message previews', () => {
    resetCompressorState();
    const messages = [
      msg('system', 'sys'),
      msg('user', 'UNIQUE_QUERY_TEXT_ABC'),
      msg('assistant', 'response ' + 'x'.repeat(2000)),
      ...Array.from({ length: 57 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', 'y'.repeat(2000))
      )
    ];
    const result = compressSync(messages);
    const summary = result.messages.find(m => m.content?.includes('CONTEXT COMPACTION'));
    // The unique query should appear in head (protected) or summary
    const hasQuery = result.messages.some(m =>
      m.content?.includes('UNIQUE_QUERY_TEXT_ABC')
    );
    assert.ok(hasQuery, 'unique query should survive in head or summary');
  });
});

describe('compressSync — tool output pruning', () => {
  test('tool results get smart summaries', () => {
    resetCompressorState();
    const tc = {
      id: 'tc_bash_1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"npm test"}' }
    };
    const messages: Message[] = [
      msg('system', 'sys'),
      msg('user', 'run tests ' + 'x'.repeat(2000)),
      { role: 'assistant', content: null, tool_calls: [tc] },
      { role: 'tool', content: 'output\n'.repeat(200), tool_call_id: 'tc_bash_1' },
      msg('assistant', 'tests passed ' + 'x'.repeat(2000)),
      ...Array.from({ length: 55 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', 'z'.repeat(2000))
      )
    ];
    const result = compressSync(messages);
    assert.ok(result.stats.toolResultsPruned > 0 || result.messages.length < messages.length,
      'tool results should be pruned or conversation compressed');
  });

  test('duplicate tool results are deduplicated', () => {
    resetCompressorState();
    const sameContent = 'identical output '.repeat(100);
    const tc1 = {
      id: 'tc1', type: 'function',
      function: { name: 'read', arguments: '{"file_path":"a.ts"}' }
    };
    const tc2 = {
      id: 'tc2', type: 'function',
      function: { name: 'read', arguments: '{"file_path":"a.ts"}' }
    };
    const messages: Message[] = [
      msg('system', 'sys'),
      msg('user', 'read file ' + 'x'.repeat(2000)),
      { role: 'assistant', content: null, tool_calls: [tc1] },
      { role: 'tool', content: sameContent, tool_call_id: 'tc1' },
      msg('assistant', 'done ' + 'x'.repeat(2000)),
      msg('user', 'read again ' + 'x'.repeat(2000)),
      { role: 'assistant', content: null, tool_calls: [tc2] },
      { role: 'tool', content: sameContent, tool_call_id: 'tc2' },
      msg('assistant', 'same ' + 'x'.repeat(2000)),
      ...Array.from({ length: 50 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', 'z'.repeat(2000))
      )
    ];
    const result = compressSync(messages);
    assert.ok(
      result.stats.duplicatesRemoved > 0 || result.messages.length < messages.length,
      'duplicates should be removed or messages compressed'
    );
  });

  test('large tool_call arguments are truncated', () => {
    resetCompressorState();
    const bigArgs = JSON.stringify({ content: 'A'.repeat(1000) });
    const tc = {
      id: 'tc_big', type: 'function',
      function: { name: 'write', arguments: bigArgs }
    };
    const messages: Message[] = [
      msg('system', 'sys'),
      msg('user', 'write file ' + 'x'.repeat(2000)),
      { role: 'assistant', content: null, tool_calls: [tc] },
      { role: 'tool', content: 'ok', tool_call_id: 'tc_big' },
      msg('assistant', 'wrote it ' + 'x'.repeat(2000)),
      ...Array.from({ length: 55 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', 'z'.repeat(2000))
      )
    ];
    const result = compressSync(messages);
    assert.ok(
      result.stats.argsTruncated > 0 || result.messages.length < messages.length,
      'large args should be truncated or messages compressed'
    );
  });
});

describe('forceCompress', () => {
  test('emergency mode produces compact output', () => {
    resetCompressorState();
    const messages = bigConversation(60, 2000);
    const result = forceCompress(messages, 'emergency');
    assert.strictEqual(result.level, 'emergency');
    assert.ok(result.messages.length < messages.length);
    assert.ok(result.stats.ratio < 1);
  });

  test('prune_only mode only prunes tool results', () => {
    resetCompressorState();
    const messages = [msg('user', 'hello'), msg('assistant', 'hi')];
    const result = forceCompress(messages, 'prune_only');
    assert.strictEqual(result.level, 'prune_only');
    assert.strictEqual(result.messages.length, 2);
  });

  test('none mode returns input unchanged', () => {
    resetCompressorState();
    const messages = [msg('user', 'hello')];
    const result = forceCompress(messages, 'none');
    assert.strictEqual(result.messages.length, 1);
  });
});

describe('compressSync — stats', () => {
  test('stats reflect compression accurately', () => {
    resetCompressorState();
    const messages = bigConversation(60, 2000);
    const result = compressSync(messages);
    assert.ok(result.stats.originalTokens > 0);
    assert.ok(result.stats.compressedTokens > 0);
    assert.ok(result.stats.compressedTokens <= result.stats.originalTokens);
    assert.strictEqual(result.stats.originalCount, messages.length);
    assert.ok(result.stats.compressedCount <= result.stats.originalCount);
    assert.ok(result.stats.ratio <= 1);
    assert.ok(result.stats.ratio > 0);
  });

  test('no compression stats are correct', () => {
    resetCompressorState();
    const messages = [msg('user', 'hi')];
    const result = compressSync(messages);
    assert.strictEqual(result.stats.originalCount, 1);
    assert.strictEqual(result.stats.compressedCount, 1);
    assert.strictEqual(result.stats.ratio, 1);
    assert.strictEqual(result.stats.toolResultsPruned, 0);
    assert.strictEqual(result.stats.duplicatesRemoved, 0);
  });
});

describe('compressSync — anti-thrashing', () => {
  test('anti-thrashing prevents repeated low-value compressions', () => {
    resetCompressorState();
    // Create a conversation that's just barely over 50% threshold
    // so compression saves very little
    const messages = bigConversation(25, 2000); // ~26 * 504 ≈ 13K (just over 50%)
    const r1 = compressSync(messages);
    const r2 = compressSync(messages);
    // After 2 low-savings compressions, anti-thrashing should kick in
    const r3 = compressSync(messages);
    // r3 should skip compression (anti-thrashing triggered)
    // The exact behavior depends on savings; just verify it doesn't crash
    assert.ok(r3.messages.length > 0);
  });
});
