// Bug B2 + B4 regression tests for the Discord image attachment pipeline.
//
// We stub global fetch so we can exercise the streaming-abort path without
// hitting the network or relying on a real Discord CDN response.

import { describe, test, afterEach, after } from 'node:test';
import assert from 'node:assert';
import { processDiscordImages } from '../src/multimodal/discord-image-handler';
import { terminateAllWorkers } from '../src/multimodal/image-processor';

after(async () => {
  await terminateAllWorkers();
});

type FetchFn = typeof fetch;

afterEach(() => {
  // Each test installs its own fetch — restore none here, but make sure
  // any leftover override is wiped so one bad test doesn't poison the next.
  // (Tests below restore explicitly in their own afterEach where needed.)
});

// ---------------------------------------------------------------------------
// Helper: build a ReadableStream that emits N chunks of `chunkSize` zero bytes,
// optionally honouring the AbortSignal so the consumer can cut us off.
// ---------------------------------------------------------------------------
function makeChunkedStream(
  chunkSize: number,
  totalChunks: number,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(new Error('aborted'));
        return;
      }
      if (emitted >= totalChunks) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunkSize));
      emitted++;
    }
  });
}

// ---------------------------------------------------------------------------
// Bug B4: more than MAX_IMAGES_PER_MESSAGE attachments → skip notice appended
// ---------------------------------------------------------------------------

describe('processDiscordImages — Bug B4: skip notice on overflow', () => {
  const originalFetch: FetchFn = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test('appends a "[skipped N additional images]" marker when over the limit', async () => {
    // Stub fetch so each "download" returns immediately with a tiny image.
    // We don't need OCR to succeed — processImage will just hand back
    // fallbackMeta, which formatOcrForPrompt renders as a plain string.
    globalThis.fetch = (async () => {
      // 1x1 white PNG, base64 — small enough that we don't bother streaming.
      const tiny = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64'
      );
      return new Response(tiny, {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'content-length': String(tiny.length) }
      }) as unknown as Response;
    }) as FetchFn;

    const urls = Array.from({ length: 8 }, (_, i) => `https://example.com/img${i}.png`);
    const types = urls.map(() => 'image/png');
    const out = await processDiscordImages(urls, types);

    // 5 processed + 1 skip-notice line = 6 entries total.
    assert.strictEqual(out.length, 6, `expected 6 entries, got ${out.length}: ${JSON.stringify(out)}`);
    const last = out[out.length - 1];
    assert.match(last, /^\[skipped 3 additional images — limit 5 per message\]$/);
  });

  test('no skip notice when at-or-below the limit', async () => {
    globalThis.fetch = (async () => {
      const tiny = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64'
      );
      return new Response(tiny, {
        status: 200,
        headers: { 'Content-Type': 'image/png' }
      }) as unknown as Response;
    }) as FetchFn;

    const urls = ['https://example.com/a.png', 'https://example.com/b.png'];
    const types = ['image/png', 'image/png'];
    const out = await processDiscordImages(urls, types);

    assert.strictEqual(out.length, 2);
    for (const line of out) assert.ok(!line.startsWith('[skipped'),
      `unexpected skip notice: ${line}`);
  });

  test('non-image attachments do not count toward the limit', async () => {
    globalThis.fetch = (async () => {
      const tiny = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64'
      );
      return new Response(tiny, {
        status: 200,
        headers: { 'Content-Type': 'image/png' }
      }) as unknown as Response;
    }) as FetchFn;

    // 2 images + 10 videos → only 2 processed, no skip notice.
    const urls: string[] = ['https://x/a.png', 'https://x/b.png'];
    const types: string[] = ['image/png', 'image/png'];
    for (let i = 0; i < 10; i++) {
      urls.push(`https://x/v${i}.mp4`);
      types.push('video/mp4');
    }
    const out = await processDiscordImages(urls, types);
    assert.strictEqual(out.length, 2);
    assert.ok(!out.some((s) => s.startsWith('[skipped')), 'no skip notice expected');
  });
});

// ---------------------------------------------------------------------------
// Bug B2: oversized download is aborted mid-stream, not buffered into RAM
// ---------------------------------------------------------------------------

describe('processDiscordImages — Bug B2: streaming abort on oversize', () => {
  const originalFetch: FetchFn = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test('aborts download once accumulated bytes exceed 10MB cap', async () => {
    // Emit 12 chunks * 1MB = 12MB total. The handler should bail after
    // ~10MB and never enqueue all 12 chunks. We track how many chunks the
    // stream actually produced.
    let pulled = 0;
    let aborted = false;

    globalThis.fetch = (async (_input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal) {
        signal.addEventListener('abort', () => { aborted = true; });
      }

      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(new Error('aborted'));
            return;
          }
          if (pulled >= 12) {
            controller.close();
            return;
          }
          // 1MB chunk
          controller.enqueue(new Uint8Array(1024 * 1024));
          pulled++;
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'image/png' } // no content-length → forces streaming path
      }) as unknown as Response;
    }) as FetchFn;

    const out = await processDiscordImages(
      ['https://example.com/big.png'],
      ['image/png']
    );

    assert.strictEqual(out.length, 1);
    // The single result should be the failure marker, not a successful OCR block.
    assert.match(out[0], /failed to process — .*image too large/);
    // Sanity: we didn't pull the whole 12MB. (Allow ~11 — one extra chunk
    // can be in flight at the moment we cross the limit.)
    assert.ok(pulled <= 11, `expected stream pull <= 11, got ${pulled} (means abort didn't kick in)`);
    assert.ok(aborted, 'expected AbortController to fire on oversize');
  });

  test('respects content-length pre-check for an obviously-huge response', async () => {
    let pulled = 0;
    globalThis.fetch = (async () => {
      const stream = makeChunkedStream(1024, 1);
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'content-length': String(50 * 1024 * 1024) // 50MB advertised
        }
      }) as unknown as Response;
    }) as FetchFn;

    const out = await processDiscordImages(
      ['https://example.com/huge.png'],
      ['image/png']
    );
    assert.match(out[0], /failed to process — .*image too large/);
    assert.strictEqual(pulled, 0, 'must not stream a single chunk when content-length pre-check fires');
  });

  test('non-OK HTTP status surfaces a clean error', async () => {
    globalThis.fetch = (async () => {
      return new Response('nope', { status: 404 }) as unknown as Response;
    }) as FetchFn;

    const out = await processDiscordImages(
      ['https://example.com/missing.png'],
      ['image/png']
    );
    assert.strictEqual(out.length, 1);
    assert.match(out[0], /failed to process — .*HTTP 404/);
  });
});
