// Discord image → OCR pipeline. Downloads attachments to /tmp, runs Tesseract,
// returns formatted blocks ready to prepend to the user's prompt.

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { processImage, formatOcrForPrompt } from './image-processor';
import { log } from '../utils/logger';

const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * For each image-typed media URL, download to /tmp and OCR it.
 * Returns formatted `[image: ... | OCR: ...]` tokens ready to prepend
 * to the user's message text. Non-image media (video/audio/file) are
 * skipped silently.
 *
 * Bug B4 fix: when more image attachments arrive than MAX_IMAGES_PER_MESSAGE,
 * we used to drop the overflow silently. We now append a marker so the
 * model (and the user looking at the trace) knows some images were skipped.
 */
export async function processDiscordImages(
  urls: string[],
  types: string[]
): Promise<string[]> {
  const results: string[] = [];
  const imageIdx: number[] = [];
  for (let i = 0; i < urls.length; i++) {
    if ((types[i] ?? '').startsWith('image/')) imageIdx.push(i);
  }
  if (imageIdx.length === 0) return results;

  const limited = imageIdx.slice(0, MAX_IMAGES_PER_MESSAGE);
  const skipped = imageIdx.length - limited.length;

  for (let n = 0; n < limited.length; n++) {
    const i = limited[n];
    const url = urls[i];
    try {
      const path = await downloadToTmp(url, n);
      const ocr = await processImage(path);
      results.push(formatOcrForPrompt(ocr, path));
    } catch (err) {
      log.warn('Discord image processing failed', {
        url: url.slice(0, 80),
        error: String(err)
      });
      results.push(`[image: (failed to process — ${truncate(String(err), 80)})]`);
    }
  }

  if (skipped > 0) {
    results.push(
      `[skipped ${skipped} additional image${skipped === 1 ? '' : 's'} — ` +
      `limit ${MAX_IMAGES_PER_MESSAGE} per message]`
    );
  }
  return results;
}

/**
 * Bug B2 fix: stream the response body and abort as soon as we cross the
 * size cap, instead of buffering an entire 25MB Discord-Nitro upload into
 * RAM with `arrayBuffer()` before checking. We use AbortController to cut
 * the underlying connection — undici (Node's built-in fetch) honours it.
 */
async function downloadToTmp(url: string, idx: number): Promise<string> {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  if (!res.ok) {
    ac.abort();
    throw new Error(`HTTP ${res.status}`);
  }

  // Cheap pre-check: if the server volunteers content-length and it's over
  // our cap, abort before reading any bytes.
  const contentLength = Number(res.headers.get('content-length') ?? '0');
  if (contentLength > MAX_IMAGE_SIZE_BYTES) {
    ac.abort();
    throw new Error(`image too large: ${contentLength} bytes`);
  }

  const body = res.body;
  if (!body) {
    throw new Error('response had no body');
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_IMAGE_SIZE_BYTES) {
        // Abort underlying socket so we don't keep paying bandwidth on a
        // download we already rejected.
        try { await reader.cancel(); } catch { /* ignore */ }
        ac.abort();
        throw new Error(
          `image too large: exceeded ${MAX_IMAGE_SIZE_BYTES} bytes (read ${received})`
        );
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), received);

  const clean = url.split('?')[0];
  const ext = clean.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? 'png';
  const path = join(tmpdir(), `sw-img-${Date.now()}-${idx}.${ext}`);
  await writeFile(path, buf);
  return path;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}
