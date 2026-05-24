import { describe, test, beforeEach, afterEach } from 'node:test';
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
  injectSelfReviewsForTask
} from '../src/autonomous/self-review';

// --- Test scaffolding ----------------------------------------------------

interface FetchCall {
  url: string;
  body: unknown;
}

interface FetchStubOptions {
  /** Response to return for chat completions. */
  response?: {
    ok?: boolean;
    status?: number;
    content?: string;
  };
  /** If true, throw an error instead of returning a response. */
  throwError?: boolean;
}

type FetchFn = typeof fetch;

const originalFetch: FetchFn = globalThis.fetch;
let fetchCalls: FetchCall[] = [];

function installFetchStub(opts: FetchStubOptions = {}): void {
  fetchCalls = [];
  const stub: FetchFn = async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    let body: unknown = undefined;
    if (init && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    fetchCalls.push({ url, body });

    if (opts.throwError) {
      throw new Error('simulated network failure');
    }

    const ok = opts.response?.ok ?? true;
    const status = opts.response?.status ?? 200;
    const content = opts.response?.content ?? JSON.stringify({ reflect: false });

    const payload = {
      choices: [{ message: { content } }]
    };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' }
    }) as unknown as Response;
  };
  globalThis.fetch = stub;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

/** Wait long enough for fire-and-forget setTimeout(fn, 0) to drain. */
async function flushAsync(): Promise<void> {
  // Allow microtasks + the setTimeout(0) callback to run + any inner awaits.
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

// --- Setup / teardown ----------------------------------------------------

let tmpDir: string;
let store: MemoryStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'selfReview-test-'));
  store = new MemoryStore({ dataDir: tmpDir, maxMemoriesInPrompt: 10 });
  hooks.clear();
  resetSelfReviewHealth();
});

afterEach(() => {
  hooks.clear();
  resetSelfReviewHealth();
  restoreFetch();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// --- Tests ---------------------------------------------------------------

describe('SelfReview — failure detection', () => {
  test('reflects when result contains explicit failure phrase', async () => {
    installFetchStub({
      response: {
        content: JSON.stringify({
          reflect: true,
          lesson: 'When the file path is uncertain, use Glob first instead of guessing.',
          trigger_keywords: ['file', 'path', 'glob'],
          why: 'Guessing paths leads to repeated read errors.'
        })
      }
    });

    wireSelfReview({
      apiKey: 'test-key',
      baseUrl: 'http://localhost',
      model: 'test-model',
      memoryStore: store
    });

    await hooks.emit('executor:complete', {
      prompt: 'Read the config file please',
      result: "I failed to find the file after several tries."
    });

    await flushAsync();

    assert.strictEqual(fetchCalls.length, 1, 'expected one chat-completions call');
    assert.ok(fetchCalls[0].url.endsWith('/v1/chat/completions'));

    const saved = store.load('feedback');
    assert.strictEqual(saved.length, 1, 'expected one selfReview memory saved');
    assert.ok(saved[0].name.startsWith('selfReview-'), 'memory name should start with selfReview-');
    assert.match(saved[0].content, /When the file path is uncertain/);
    assert.match(saved[0].content, /Trigger keywords:/);
  });
});

describe('SelfReview — success path', () => {
  test('does not reflect when result is clean', async () => {
    installFetchStub();

    wireSelfReview({
      apiKey: 'test-key',
      baseUrl: 'http://localhost',
      model: 'test-model',
      memoryStore: store
    });

    await hooks.emit('executor:complete', {
      prompt: 'What is 2 + 2?',
      result: 'The answer is 4.'
    });

    await flushAsync();

    assert.strictEqual(fetchCalls.length, 0, 'no API call should be made on clean success');
    assert.strictEqual(store.load().length, 0, 'no memory should be saved');
  });
});

describe('SelfReview — injectSelfReviewsForTask', () => {
  test('returns formatted block for matching keyword', () => {
    // Wire to capture store reference.
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store
    });

    const ts = Date.now();
    const memory: Memory = {
      name: 'selfReview-database-1234567890',
      description: 'SelfReview lesson: Always use parameterized queries',
      type: 'feedback',
      content: [
        '**Lesson:** Always use parameterized queries when touching the database.',
        '',
        '**Why:** Concatenating SQL invites injection bugs.',
        '',
        '**Trigger keywords:** database, sql, query'
      ].join('\n'),
      createdAt: ts,
      updatedAt: ts
    };
    store.save(memory);

    const block = injectSelfReviewsForTask('Please update the database schema for users');
    assert.ok(block.length > 0, 'expected non-empty injection block');
    assert.match(block, /<past-selfReviews count="1">/);
    assert.match(block, /Always use parameterized queries/);
    assert.match(block, /triggered by: database, sql, query/);
    assert.match(block, /<\/past-selfReviews>/);
  });

  test('returns empty string when no matching memories', () => {
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store
    });

    const block = injectSelfReviewsForTask('Tell me a joke about cats');
    assert.strictEqual(block, '');
  });

  test('ignores non-selfReview memories with matching keywords', () => {
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store
    });

    const ts = Date.now();
    store.save({
      name: 'user-pref-database',
      description: 'User likes postgres',
      type: 'user',
      content: 'User prefers postgres database for all projects.',
      createdAt: ts,
      updatedAt: ts
    });

    const block = injectSelfReviewsForTask('configure the database connection');
    assert.strictEqual(block, '', 'non-selfReview memory should not be injected');
  });
});

describe('SelfReview — Chinese failure detection (H-4)', () => {
  test('reflects on Chinese explicit failure phrase ("我无法完成")', async () => {
    installFetchStub({
      response: {
        content: JSON.stringify({
          reflect: true,
          lesson: 'When the bot login fails after retries, escalate to a fresh session instead of looping.',
          trigger_keywords: ['bot', 'login', 'auth', 'retry'],
          why: 'Repeated retries after auth failure waste turns and rarely succeed.'
        })
      }
    });

    wireSelfReview({
      apiKey: 'test-key',
      baseUrl: 'http://localhost',
      model: 'test-model',
      memoryStore: store
    });

    await hooks.emit('executor:complete', {
      prompt: '请帮我登录 bot',
      result: '抱歉，我无法完成登录，尝试了几次都不行。'
    });

    await flushAsync();

    assert.strictEqual(fetchCalls.length, 1, 'expected one chat-completions call for Chinese failure');
    const saved = store.load('feedback');
    assert.strictEqual(saved.length, 1, 'expected one selfReview memory saved from Chinese result');
    // Verify the saved lesson is in English (lang rule from SELFREVIEW_PROMPT,
    // delivered via the model's JSON response which we mocked above).
    assert.match(saved[0].content, /When the bot login fails/);
    assert.match(saved[0].content, /Trigger keywords:.*bot.*login/);
  });

  test('reflects on "出错了" / "由于...限制" patterns', async () => {
    installFetchStub({
      response: {
        content: JSON.stringify({
          reflect: true,
          lesson: 'When a sandbox blocks an action, surface the limitation up-front instead of looping.',
          trigger_keywords: ['sandbox', 'limit', 'restriction'],
          why: 'Looping under a hard sandbox limit cannot succeed.'
        })
      }
    });

    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store
    });

    await hooks.emit('executor:complete', {
      prompt: '运行那个脚本',
      result: '由于沙盒环境限制，我无法继续，出错了。'
    });

    await flushAsync();
    assert.strictEqual(fetchCalls.length, 1, 'expected reflection on Chinese limit phrase');
  });

  test('does NOT reflect on clean Chinese success', async () => {
    installFetchStub();

    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store
    });

    await hooks.emit('executor:complete', {
      prompt: '2 加 2 等于多少？',
      result: '答案是 4。'
    });

    await flushAsync();
    assert.strictEqual(fetchCalls.length, 0, 'no reflection on clean Chinese success');
  });
});

describe('SelfReview — Chinese keyword extraction (M-2)', () => {
  test('injectSelfReviewsForTask matches a Chinese-only prompt against a lesson with CN trigger', () => {
    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store
    });

    const ts = Date.now();
    // Lesson body lists both Chinese and English triggers — exercises CJK
    // tokenization on both prompt and content sides of the matcher.
    const memory: Memory = {
      name: 'selfReview-login-cn-001',
      description: 'SelfReview lesson: bot login retries',
      type: 'feedback',
      content: [
        '**Lesson:** When bot 登录 fails after retries, request a fresh session.',
        '',
        '**Why:** Looping after auth failure rarely succeeds.',
        '',
        '**Trigger keywords:** 登录, bot, auth'
      ].join('\n'),
      createdAt: ts,
      updatedAt: ts
    };
    store.save(memory);

    // Pure-Chinese prompt — old [a-z0-9]+ tokenizer would have produced ZERO
    // tokens and never matched. The new \p{L}\p{N} tokenizer keeps "登录".
    const block = injectSelfReviewsForTask('请检查一下 bot 登录是否成功');
    assert.ok(block.length > 0, 'expected non-empty injection block from CN prompt');
    assert.match(block, /When bot 登录 fails/);
  });
});

describe('SelfReview — health tracking', () => {
  test('disables after 3 consecutive API failures', async () => {
    installFetchStub({ response: { ok: false, status: 500 } });

    let unhealthyEmitted = 0;
    hooks.on('selfReview_unhealthy' as Parameters<typeof hooks.on>[0], () => {
      unhealthyEmitted++;
    });

    wireSelfReview({
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      memoryStore: store
    });

    // Fire three failure-triggering events sequentially (await each so the
    // reentrancy guard releases between calls).
    for (let i = 0; i < 3; i++) {
      await hooks.emit('executor:complete', {
        prompt: `attempt ${i}`,
        result: 'I failed to do the thing.'
      });
      await flushAsync();
    }

    assert.strictEqual(fetchCalls.length, 3, 'expected 3 API attempts');
    assert.strictEqual(unhealthyEmitted, 1, 'should emit selfReview_unhealthy exactly once');

    // After disable, further events should NOT trigger fetch.
    await hooks.emit('executor:complete', {
      prompt: 'attempt 4',
      result: 'I failed to do the thing again.'
    });
    await flushAsync();

    assert.strictEqual(fetchCalls.length, 3, 'no further API calls after disable');
  });
});
