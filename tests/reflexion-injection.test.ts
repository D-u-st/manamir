// Tests for the upgraded injectSelfReviewsForTask scorer + the api-executor
// integration that prepends past lessons before the user message.
//
// Scoring properties exercised:
//   - empty memory → ''
//   - one matching lesson → block present
//   - top K by score (K=2 in test 3)
//   - recency decay: identical-content older lesson scores lower
//   - keyword overlap: more overlap → higher score
//   - WHY field present in formatted output
//   - api-executor injects BEFORE the user message

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { hooks } from '../src/hooks';
import { MemoryStore } from '../src/memory/store';
import type { Memory } from '../src/memory/types';
import {
  wireSelfReview,
  resetSelfReviewHealth,
  injectSelfReviewsForTask,
} from '../src/autonomous/self-review';

let tmpDir: string;
let store: MemoryStore;

function buildLesson(opts: {
  name: string;
  lesson: string;
  why?: string;
  triggers: string[];
  ageDays?: number;
}): Memory {
  const ts = Date.now() - (opts.ageDays ?? 0) * 24 * 60 * 60 * 1000;
  const content = [
    `**Lesson:** ${opts.lesson}`,
    '',
    `**Why:** ${opts.why ?? '(not provided)'}`,
    '',
    `**Trigger keywords:** ${opts.triggers.join(', ')}`,
  ].join('\n');
  return {
    name: opts.name,
    description: `SelfReview lesson: ${opts.lesson.slice(0, 80)}`,
    type: 'feedback',
    content,
    createdAt: ts,
    updatedAt: ts,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'selfReview-injection-'));
  store = new MemoryStore({ dataDir: tmpDir, maxMemoriesInPrompt: 10 });
  hooks.clear();
  resetSelfReviewHealth();
  delete process.env.SELFREVIEW_INJECT_TOP_K;
});

afterEach(() => {
  hooks.clear();
  resetSelfReviewHealth();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  delete process.env.SELFREVIEW_INJECT_TOP_K;
});

describe('injectSelfReviewsForTask — empty memory', () => {
  test('returns empty string when no memories saved', () => {
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store,
    });
    assert.strictEqual(injectSelfReviewsForTask('please update the database'), '');
  });
});

describe('injectSelfReviewsForTask — one matching lesson', () => {
  test('injection block present and well-formed', () => {
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store,
    });
    store.save(
      buildLesson({
        name: 'selfReview-database-1',
        lesson: 'Always use parameterized queries when touching the database.',
        why: 'String concatenation invites SQL injection.',
        triggers: ['database', 'sql', 'query'],
      })
    );

    const block = injectSelfReviewsForTask('Please update the database schema for users');
    assert.ok(block.length > 0, 'expected non-empty block');
    assert.match(block, /<past-lessons count="1">/);
    assert.match(block, /<past-selfReviews count="1">/); // legacy alias preserved
    assert.match(block, /Always use parameterized queries/);
    assert.match(block, /Why: String concatenation invites SQL injection/);
    assert.match(block, /triggered by: database, sql, query/);
    assert.match(block, /<\/past-selfReviews>/);
    assert.match(block, /<\/past-lessons>/);
  });
});

describe('injectSelfReviewsForTask — top-K by score', () => {
  test('top 2 by score when K=2', () => {
    process.env.SELFREVIEW_INJECT_TOP_K = '2';
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store,
    });

    // Three lessons sharing keyword "database":
    // - A: 3 trigger overlaps (database, sql, query)
    // - B: 1 trigger overlap (database)
    // - C: 0 trigger overlaps but contains 'database' in lesson text
    store.save(
      buildLesson({
        name: 'selfReview-a',
        lesson: 'Lesson A about database and sql query.',
        triggers: ['database', 'sql', 'query'],
      })
    );
    store.save(
      buildLesson({
        name: 'selfReview-b',
        lesson: 'Lesson B about database.',
        triggers: ['database'],
      })
    );
    store.save(
      buildLesson({
        name: 'selfReview-c',
        lesson: 'Lesson C generic database tip.',
        triggers: ['unrelated'],
      })
    );

    const block = injectSelfReviewsForTask('database sql query problem here');
    assert.match(block, /count="2"/);
    // The two highest-scoring lessons are A and B.
    assert.match(block, /Lesson A about database/);
    assert.match(block, /Lesson B about database/);
    assert.ok(!/Lesson C generic/.test(block), 'C should not be in top-2');
  });
});

describe('injectSelfReviewsForTask — recency decay', () => {
  test('older lesson with identical content scores lower', () => {
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store,
    });

    store.save(
      buildLesson({
        name: 'selfReview-recent',
        lesson: 'Use Glob first when path is uncertain.',
        triggers: ['glob', 'path', 'file'],
        ageDays: 0,
      })
    );
    store.save(
      buildLesson({
        name: 'selfReview-old',
        lesson: 'Use Glob first when path is uncertain.',
        triggers: ['glob', 'path', 'file'],
        ageDays: 28, // 4 weeks → ~6.25% boost vs 100%
      })
    );

    process.env.SELFREVIEW_INJECT_TOP_K = '1';
    const block = injectSelfReviewsForTask('I need to find a file by glob path pattern');
    assert.match(block, /count="1"/);
    // The recent one has a much higher score, so it should be the survivor.
    // We can't see scores from the outside but we can confirm the recent
    // lesson is the one chosen — both have same lesson text but different
    // names, so we check the formatted date matches "today".
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(block.includes(`[${today}]`), `expected today's date in block: ${block}`);
  });
});

describe('injectSelfReviewsForTask — keyword overlap scoring', () => {
  test('lesson with more overlap ranks above one with less', () => {
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store,
    });

    // Both lessons match at least one keyword in the prompt, but A overlaps
    // on three trigger keywords vs B on one.
    store.save(
      buildLesson({
        name: 'selfReview-high-overlap',
        lesson: 'Database schema migration safety steps.',
        triggers: ['database', 'schema', 'migration'],
      })
    );
    store.save(
      buildLesson({
        name: 'selfReview-low-overlap',
        lesson: 'A loosely related lesson about database.',
        triggers: ['database'],
      })
    );

    process.env.SELFREVIEW_INJECT_TOP_K = '1';
    const block = injectSelfReviewsForTask(
      'plan a database schema migration for the users table'
    );
    assert.match(block, /count="1"/);
    assert.match(block, /Database schema migration safety steps/);
    assert.ok(
      !/A loosely related lesson/.test(block),
      'low-overlap lesson should not win'
    );
  });
});

describe('injectSelfReviewsForTask — WHY in output', () => {
  test('formatted block includes Why when present', () => {
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store,
    });
    store.save(
      buildLesson({
        name: 'selfReview-w',
        lesson: 'Always preview before destructive ops.',
        why: 'Last time this overwrote user data.',
        triggers: ['delete', 'overwrite', 'destructive'],
      })
    );
    const block = injectSelfReviewsForTask('please delete the destructive entries');
    assert.match(block, /Always preview before destructive ops/);
    assert.match(block, /Why: Last time this overwrote user data/);
  });

  test('does not emit Why when memory provided "(not provided)"', () => {
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store,
    });
    store.save(
      buildLesson({
        name: 'selfReview-nowhy',
        lesson: 'A lesson without explanation.',
        triggers: ['simple', 'lesson', 'sample'],
      })
    );
    const block = injectSelfReviewsForTask('a simple sample lesson search');
    assert.match(block, /A lesson without explanation/);
    assert.ok(!/Why:/.test(block), `expected no Why in block, got: ${block}`);
  });
});

// --- Integration: api-executor stale aux pruning (C-3 fix) --------

describe('api-executor C-3 — past-lessons does not accumulate across turns', () => {
  test('after two execute() calls, only ONE past-lessons block is in history', async () => {
    const selfReviewStore = new MemoryStore({
      dataDir: tmpDir,
      maxMemoriesInPrompt: 10,
    });
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: selfReviewStore,
    });
    selfReviewStore.save(
      buildLesson({
        name: 'selfReview-net',
        lesson: 'Always close the network resource after use.',
        triggers: ['network', 'fetch', 'connection'],
      })
    );

    const captured: Array<Array<{ role: string; content: string }>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
      if (init && typeof init.body === 'string') {
        try {
          const parsed = JSON.parse(init.body) as {
            messages?: Array<{ role: string; content: string }>;
          };
          if (parsed.messages) captured.push(parsed.messages);
        } catch {
          /* ignore */
        }
      }
      const sseBody =
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
        'data: [DONE]\n\n';
      return new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    try {
      const { ApiExecutor } = await import('../src/executor/api-executor');
      const exec = new ApiExecutor({
        apiKey: 'k',
        baseUrl: 'http://localhost',
        model: 'deepseek-chat',
        maxTurns: 1,
      });

      // Two consecutive executes — both prompts hit the same lesson.
      await exec.execute('please open a network fetch connection to remote');
      await exec.execute('again open another network fetch connection');

      // The SECOND call's outgoing messages should still contain exactly ONE
      // past-lessons block (not two). C-3 bug would leave two stacked.
      assert.ok(captured.length >= 2, 'expected at least 2 fetch calls captured');
      const second = captured[captured.length - 1];
      const lessonBlocks = second.filter(
        (m) => m.role === 'system' && m.content.startsWith('<past-lessons')
      );
      assert.strictEqual(
        lessonBlocks.length,
        1,
        `expected exactly 1 past-lessons block on second call, got ${lessonBlocks.length}`
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// --- Integration: api-executor pre-injects BEFORE the user message --------

describe('api-executor integration — SelfReview injection precedes user msg', () => {
  test('conversationHistory has system lesson msg before user msg after pre-injection', async () => {
    // We don't actually run the network — just call the private
    // injectAuxiliaryContext via execute(). To avoid a real fetch, we stub
    // it to return immediately with no tool calls and bail.
    const selfReviewStore = new MemoryStore({
      dataDir: tmpDir,
      maxMemoriesInPrompt: 10,
    });
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: selfReviewStore,
    });
    selfReviewStore.save(
      buildLesson({
        name: 'selfReview-net',
        lesson: 'Always close the network resource after use.',
        triggers: ['network', 'fetch', 'connection'],
      })
    );

    // Lazy import so the stubbed fetch is in place before the executor
    // builds its first request.
    const originalFetch = globalThis.fetch;
    let requestedMessages: Array<{ role: string; content: string }> = [];
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
      if (init && typeof init.body === 'string') {
        try {
          const parsed = JSON.parse(init.body) as { messages?: typeof requestedMessages };
          if (parsed.messages) requestedMessages = parsed.messages;
        } catch {
          /* ignore */
        }
      }
      // Return an SSE-style empty stream that finalizes immediately.
      const sseBody =
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
        'data: [DONE]\n\n';
      return new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    try {
      const { ApiExecutor } = await import('../src/executor/api-executor');
      const exec = new ApiExecutor({
        apiKey: 'k',
        baseUrl: 'http://localhost',
        model: 'deepseek-chat',
        maxTurns: 1,
      });
      await exec.execute('please open a network fetch connection to remote');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The first system message that's NOT the live system prompt should be
    // the selfReview lesson block. Find it and confirm its index < the user
    // message index.
    const lessonIdx = requestedMessages.findIndex(
      (m) => m.role === 'system' && m.content.startsWith('<past-lessons')
    );
    const userIdx = requestedMessages.findIndex((m) => m.role === 'user');
    assert.ok(lessonIdx >= 0, `expected past-lessons system message; got ${JSON.stringify(requestedMessages.map(m => ({r: m.role, c: m.content.slice(0, 30)})))}`);
    assert.ok(userIdx >= 0, 'expected user message');
    assert.ok(lessonIdx < userIdx, 'lesson must appear before user message');
  });
});
