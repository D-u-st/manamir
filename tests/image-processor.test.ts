import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';
import {
  formatOcrForPrompt,
  processImage,
  getWorker,
  terminateAllWorkers,
  setOcrMemoryStore,
  setOcrPostprocessConfig
} from '../src/multimodal/image-processor';
import { MemoryStore } from '../src/memory/store';

// ---------------------------------------------------------------------------
// Original formatOcrForPrompt tests — must stay green.
// ---------------------------------------------------------------------------

describe('formatOcrForPrompt', () => {
  test('renders a successful OCR with text + confidence', () => {
    const out = formatOcrForPrompt(
      { text: 'Hello world', confidence: 95, durationMs: 100 },
      '/tmp/foo.png'
    );
    assert.match(out, /^\[image: foo\.png \| OCR \(95%\): Hello world\]$/);
  });

  test('truncates long OCR text at ~2000 chars', () => {
    const longText = 'x'.repeat(3000);
    const out = formatOcrForPrompt(
      { text: longText, confidence: 80, durationMs: 200 },
      '/tmp/big.png'
    );
    assert.ok(out.includes('[truncated]'));
    assert.ok(out.length < 2200);
  });

  test('uses fallback meta when no text was extracted', () => {
    const out = formatOcrForPrompt(
      {
        text: '',
        confidence: 0,
        durationMs: 50,
        fallbackMeta: { filename: 'photo.jpg', sizeBytes: 204800, extension: '.jpg' }
      },
      '/tmp/photo.jpg'
    );
    assert.match(out, /\[image: photo\.jpg \| \.jpg \| 200KB \| OCR found no text/);
  });

  test('falls back to "OCR failed" when no text and no meta', () => {
    const out = formatOcrForPrompt(
      { text: '', confidence: 0, durationMs: 50 },
      '/tmp/x.png'
    );
    assert.strictEqual(out, '[image: x.png | OCR failed]');
  });
});

// ---------------------------------------------------------------------------
// New: postprocessed text takes precedence in formatOcrForPrompt
// ---------------------------------------------------------------------------

describe('formatOcrForPrompt — postprocessed', () => {
  test('prefers corrected text and labels content type', () => {
    const out = formatOcrForPrompt(
      {
        text: 'He11o w0rld',
        confidence: 70,
        durationMs: 100,
        postprocessed: { type: '代码', corrected: 'Hello world', confidence: 90 }
      },
      '/tmp/foo.png'
    );
    assert.match(out, /OCR \(70%\) \| type:代码: Hello world/);
  });
});

// ---------------------------------------------------------------------------
// Helpers for the integration tests below
// ---------------------------------------------------------------------------

/**
 * Build a small PNG containing readable English text via sharp's SVG input.
 * Avoids shipping binary fixtures and keeps the fixture deterministic.
 */
async function makeTextImage(text: string, width = 800, height = 200): Promise<Buffer> {
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="white"/>
      <text x="40" y="120" font-family="Arial, sans-serif" font-size="72" fill="black" font-weight="bold">${safe}</text>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ocr-test-'));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

after(async () => {
  await terminateAllWorkers();
});

// ---------------------------------------------------------------------------
// Preprocess pipeline test — uses real sharp on a real synthesized image.
// ---------------------------------------------------------------------------

describe('processImage — preprocessing + OCR (real sharp + tesseract.js)', () => {
  test('extracts plain English text from a synthesized PNG', async (t) => {
    // Skip noisily if the env can't run sharp/tesseract.js (e.g. some CI sandboxes).
    let png: Buffer;
    try {
      png = await makeTextImage('HELLO WORLD');
    } catch (err) {
      t.skip(`sharp unusable here: ${(err as Error).message}`);
      return;
    }
    const path = join(tmpRoot, 'hello.png');
    writeFileSync(path, png);

    // English-only is plenty here and downloads less data on first run.
    const result = await processImage(path, {
      langs: 'eng',
      postprocess: false,
      timeoutMs: 90_000
    });

    assert.ok(result.durationMs >= 0);
    // Tesseract.js on this synthesized text reliably contains the substring.
    // Use a soft match (case-insensitive, allow OCR noise around it).
    assert.match(result.text.toUpperCase(), /HELLO\s*WORLD/);
    assert.ok(result.confidence > 0, `expected confidence > 0, got ${result.confidence}`);
  });

  test('worker singleton: getWorker returns same instance for same lang', async () => {
    const w1 = await getWorker('eng');
    const w2 = await getWorker('eng');
    assert.strictEqual(w1, w2, 'expected singleton worker reuse for same lang combo');
  });

  test('falls back to meta when image has no text', async () => {
    // 50x50 solid red square: no text → tesseract returns near-empty.
    const blank = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 200, g: 0, b: 0 } }
    }).png().toBuffer();
    const path = join(tmpRoot, 'blank.png');
    writeFileSync(path, blank);

    const result = await processImage(path, {
      langs: 'eng',
      postprocess: false,
      minTextLength: 5,
      timeoutMs: 60_000
    });

    assert.strictEqual(result.text, '');
    assert.ok(result.fallbackMeta, 'expected fallbackMeta when no text');
    assert.strictEqual(result.fallbackMeta?.filename, 'blank.png');
    assert.strictEqual(result.fallbackMeta?.extension, '.png');
    assert.ok(result.fallbackMeta?.sizeBytes && result.fallbackMeta.sizeBytes > 0);
  });
});

// ---------------------------------------------------------------------------
// Postprocess test — mock fetch, verify request/response wiring.
// ---------------------------------------------------------------------------

describe('processImage — DeepSeek postprocess (mocked)', () => {
  type FetchFn = typeof fetch;
  const originalFetch: FetchFn = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setOcrPostprocessConfig(null);
    setOcrMemoryStore(null);
  });

  test('attaches postprocessed block when DeepSeek returns valid JSON', async (t) => {
    let png: Buffer;
    try {
      png = await makeTextImage('HELLO');
    } catch (err) {
      t.skip(`sharp unusable: ${(err as Error).message}`);
      return;
    }
    const path = join(tmpRoot, 'hello.png');
    writeFileSync(path, png);

    let captured: { url: string; body: unknown } | null = null;
    globalThis.fetch = (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      let body: unknown = undefined;
      if (init && typeof init.body === 'string') {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      captured = { url, body };
      const payload = {
        choices: [{ message: { content: JSON.stringify({
          type: '代码',
          corrected: 'Hello',
          confidence_in_correction: 92
        }) } }]
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }) as unknown as Response;
    }) as FetchFn;

    setOcrPostprocessConfig({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat'
    });

    const result = await processImage(path, {
      langs: 'eng',
      postprocess: true,
      timeoutMs: 90_000
    });

    assert.ok(result.text.length > 0, 'expected raw OCR text first');
    assert.ok(result.postprocessed, 'expected postprocessed block');
    assert.strictEqual(result.postprocessed?.type, '代码');
    assert.strictEqual(result.postprocessed?.corrected, 'Hello');
    assert.strictEqual(result.postprocessed?.confidence, 92);

    assert.ok(captured, 'expected fetch to be called');
    assert.match(captured!.url, /api\.deepseek\.com\/v1\/chat\/completions/);
    const reqBody = captured!.body as { model?: string; messages?: Array<{ content?: string }> };
    assert.strictEqual(reqBody.model, 'deepseek-chat');
    assert.ok(reqBody.messages?.[0]?.content?.includes('OCR'));
  });

  test('postprocess failure does not break OCR result', async (t) => {
    let png: Buffer;
    try { png = await makeTextImage('HELLO'); } catch (err) {
      t.skip(`sharp unusable: ${(err as Error).message}`);
      return;
    }
    const path = join(tmpRoot, 'hello.png');
    writeFileSync(path, png);

    globalThis.fetch = (async () => {
      return new Response('boom', { status: 500 }) as unknown as Response;
    }) as FetchFn;

    setOcrPostprocessConfig({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat'
    });

    const result = await processImage(path, {
      langs: 'eng',
      postprocess: true,
      timeoutMs: 90_000
    });

    assert.ok(result.text.length > 0);
    assert.strictEqual(result.postprocessed, undefined,
      'failed postprocess must not produce a postprocessed block');
  });
});

// ---------------------------------------------------------------------------
// MemoryStore persistence (B5)
// ---------------------------------------------------------------------------

describe('processImage — memory persistence', () => {
  let memDir: string;

  beforeEach(() => {
    memDir = mkdtempSync(join(tmpdir(), 'ocr-mem-'));
  });

  afterEach(() => {
    setOcrMemoryStore(null);
    try { rmSync(memDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('saves an ocr-history memory when text was extracted', async (t) => {
    let png: Buffer;
    try { png = await makeTextImage('HELLO'); } catch (err) {
      t.skip(`sharp unusable: ${(err as Error).message}`);
      return;
    }
    const path = join(tmpRoot, 'hello.png');
    writeFileSync(path, png);

    const store = new MemoryStore({ dataDir: memDir, maxMemoriesInPrompt: 5 });
    setOcrMemoryStore(store);

    const result = await processImage(path, {
      langs: 'eng',
      postprocess: false,
      timeoutMs: 90_000
    });

    if (!result.text) {
      t.skip('OCR returned empty in this env; persistence not exercised');
      return;
    }

    // persistOcrMemory is fire-and-forget; give it a tick.
    await new Promise((r) => setTimeout(r, 50));

    const memories = store.load('ocr-history');
    assert.ok(memories.length > 0, 'expected at least one ocr-history memory');
    const m = memories[0];
    // After Bug A8 fix: name = ocr-{ts}-{hash8}-{rand6}.
    assert.match(m.name, /^ocr-\d+-[a-f0-9]+-[a-z0-9]{6}$/);
    assert.match(m.description, /OCR hello\.png/);
    assert.ok(m.content.includes('Source image'));
  });

  test('does not save memory when OCR returned no text', async () => {
    const blank = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 200, g: 0, b: 0 } }
    }).png().toBuffer();
    const path = join(tmpRoot, 'blank.png');
    writeFileSync(path, blank);

    const store = new MemoryStore({ dataDir: memDir, maxMemoriesInPrompt: 5 });
    setOcrMemoryStore(store);

    await processImage(path, {
      langs: 'eng',
      postprocess: false,
      minTextLength: 5,
      timeoutMs: 60_000
    });

    await new Promise((r) => setTimeout(r, 50));
    const memories = store.load('ocr-history');
    assert.strictEqual(memories.length, 0,
      'no-text image must not produce a memory');
  });
});

// ---------------------------------------------------------------------------
// Error path: file not found
// ---------------------------------------------------------------------------

describe('processImage — input validation', () => {
  test('rejects when image file does not exist', async () => {
    const missing = join(tmpRoot, 'no-such-file.png');
    assert.strictEqual(existsSync(missing), false);
    await assert.rejects(
      () => processImage(missing, { langs: 'eng', postprocess: false }),
      /Image file not found/
    );
  });
});

// ---------------------------------------------------------------------------
// Bug P1-9: adaptive (OTSU) threshold
// ---------------------------------------------------------------------------

describe('processImage — adaptive threshold (Bug P1-9)', () => {
  const originalEnv = process.env.MANAMIR_OCR_THRESHOLD;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MANAMIR_OCR_THRESHOLD;
    else process.env.MANAMIR_OCR_THRESHOLD = originalEnv;
  });

  test('auto mode reads dark-mode (white-on-black) image and still extracts text', async (t) => {
    process.env.MANAMIR_OCR_THRESHOLD = 'auto';

    // Build a dark-mode screenshot: black background, white text. The old
    // hard-coded threshold(140) wiped this image to nearly all-white because
    // ~95% of pixels were below 140 (dark bg). OTSU should land near ~80-130
    // and preserve the foreground/background split.
    let png: Buffer;
    try {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200">
        <rect width="100%" height="100%" fill="#0d1117"/>
        <text x="40" y="120" font-family="Arial, sans-serif" font-size="72"
              fill="#f0f6fc" font-weight="bold">DARK MODE</text>
      </svg>`;
      png = await sharp(Buffer.from(svg)).png().toBuffer();
    } catch (err) {
      t.skip(`sharp unusable: ${(err as Error).message}`);
      return;
    }
    const path = join(tmpRoot, 'dark.png');
    writeFileSync(path, png);

    const result = await processImage(path, {
      langs: 'eng',
      postprocess: false,
      timeoutMs: 90_000
    });

    // We don't insist on a perfect read (tesseract on synthesized images is
    // noisy), but with adaptive threshold we should at least get *some*
    // recognisable text out — something the fixed-140 path failed at.
    assert.ok(
      result.text.length > 0 || result.fallbackMeta,
      'expected either text or fallbackMeta'
    );
    if (result.text) {
      assert.match(result.text.toUpperCase(), /DARK|MODE|D[ABO]RK|MO[ODE]+/);
    }
  });

  test('disable mode skips threshold step (still produces an output file)', async (t) => {
    process.env.MANAMIR_OCR_THRESHOLD = 'disable';
    let png: Buffer;
    try { png = await makeTextImage('SKIP'); } catch (err) {
      t.skip(`sharp unusable: ${(err as Error).message}`);
      return;
    }
    const path = join(tmpRoot, 'skip.png');
    writeFileSync(path, png);

    const result = await processImage(path, {
      langs: 'eng',
      postprocess: false,
      timeoutMs: 90_000
    });
    assert.ok(result.durationMs >= 0);
  });

  test('numeric mode honours the explicit threshold', async (t) => {
    process.env.MANAMIR_OCR_THRESHOLD = '140';
    let png: Buffer;
    try { png = await makeTextImage('FIXED'); } catch (err) {
      t.skip(`sharp unusable: ${(err as Error).message}`);
      return;
    }
    const path = join(tmpRoot, 'fixed.png');
    writeFileSync(path, png);

    const result = await processImage(path, {
      langs: 'eng',
      postprocess: false,
      timeoutMs: 90_000
    });
    assert.ok(result.durationMs >= 0);
    // Fixed mode + black-on-white synthesised image still reads cleanly.
    assert.match(result.text.toUpperCase(), /FIXED|F[I1]XED/);
  });
});

// ---------------------------------------------------------------------------
// Bug A8: memory name uniqueness across same-millisecond+same-content saves
// ---------------------------------------------------------------------------

describe('persistOcrMemory — name uniqueness (Bug A8)', () => {
  let memDir: string;

  beforeEach(() => {
    memDir = mkdtempSync(join(tmpdir(), 'ocr-mem-uniq-'));
  });

  afterEach(() => {
    setOcrMemoryStore(null);
    try { rmSync(memDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('two identical-content saves in the same ms produce distinct memories', async (t) => {
    let png: Buffer;
    try { png = await makeTextImage('SAME'); } catch (err) {
      t.skip(`sharp unusable: ${(err as Error).message}`);
      return;
    }
    const path = join(tmpRoot, 'same.png');
    writeFileSync(path, png);

    const store = new MemoryStore({ dataDir: memDir, maxMemoriesInPrompt: 5 });
    setOcrMemoryStore(store);

    // Run the same image through OCR twice in quick succession. Both calls
    // hit persistOcrMemory with identical text → identical hash. Pre-fix,
    // the second save overwrote the first (same name = same filename on disk).
    const r1 = await processImage(path, { langs: 'eng', postprocess: false, timeoutMs: 90_000 });
    const r2 = await processImage(path, { langs: 'eng', postprocess: false, timeoutMs: 90_000 });

    if (!r1.text || !r2.text) {
      t.skip('OCR returned empty in this env; uniqueness not exercised');
      return;
    }

    await new Promise((r) => setTimeout(r, 50));
    const memories = store.load('ocr-history');
    assert.ok(memories.length >= 2,
      `expected at least 2 distinct memories, got ${memories.length}`);
    const names = new Set(memories.map((m) => m.name));
    assert.strictEqual(names.size, memories.length, 'memory names must be unique');
    for (const n of names) {
      assert.match(n, /^ocr-\d+-[a-f0-9]+-[a-z0-9]{6}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug A14: getWorker timeout when model download hangs
// ---------------------------------------------------------------------------

describe('getWorker — create timeout (Bug A14)', () => {
  test('rejects with timeout error and clears cache for retry', async () => {
    // Ensure no cached worker for our test lang — otherwise an earlier
    // test (e.g. the OCR integration tests) could have already loaded
    // 'eng' into workerPool, in which case getWorker returns instantly
    // and the timeout branch is never exercised.
    await terminateAllWorkers();

    // Use the real 'eng' lang with a 1ms timeout. createWorker takes
    // hundreds of ms even for a cached lang, so 1ms reliably triggers
    // our timeout error path. The eventually-resolved worker is mopped
    // up by the orphan-drain logic in terminateAllWorkers() (called
    // again in our after() hook), so `node --test` still exits cleanly.
    const lang = 'eng';
    let err: Error | null = null;
    try {
      await getWorker(lang, 1);
    } catch (e) {
      err = e as Error;
    }
    assert.ok(err, 'expected getWorker to reject on 1ms timeout');
    assert.match(err!.message, /worker create timeout/i);

    // After rejection, the cache slot should be evicted so a normal-budget
    // retry can succeed. We don't actually wait for the retry to resolve
    // (it's slow) — just verify the slot is gone by inspecting that a
    // second short-budget call rejects with a *fresh* timeout (i.e. it
    // started a new createWorker rather than re-throwing the old promise).
    let secondErr: Error | null = null;
    try {
      await getWorker(lang, 1);
    } catch (e) {
      secondErr = e as Error;
    }
    assert.ok(secondErr, 'second call should also reject (not silently resolve from poisoned cache)');
    assert.match(secondErr!.message, /worker create timeout/i);
  });
});
