// Image OCR via tesseract.js (WASM, no system dependency) + sharp preprocessing
// + optional DeepSeek post-correction. Designed for cross-platform deployment
// where installing the system `tesseract` binary is awkward (Windows dev,
// containers, etc.).
//
// Key design points:
//   1. Tesseract.js workers cost a few MB to spin up (lang model load). We hold
//      a per-language singleton worker for the process lifetime; first call
//      pays the cost, subsequent calls reuse.
//   2. Sharp preprocesses (upsample-if-tiny → grayscale → normalize → threshold
//      → auto-rotate from EXIF) before OCR. Preprocessing typically lifts
//      accuracy on screenshots & low-contrast scans by 10-30%.
//   3. After OCR, optionally call DeepSeek to correct character mis-reads
//      (O→0, l→1, similar CJK glyphs) and recover structure (tables, code
//      indentation). Disabled via MANAMIR_OCR_POSTPROCESS=false.
//   4. Successful OCR is auto-saved to MemoryStore as type='ocr-history' so
//      "find that screenshot I sent about X" works later. Wiring is opt-in
//      via setOcrMemoryStore() — discord-image-handler / cli `/image` call it.
//
// VPS prerequisite: none beyond `npm install`. First run will download the
// language model (~10-15MB for chi_sim+eng) into node_modules cache.

import { stat, access, unlink, readFile } from 'fs/promises';
import { basename, extname, join } from 'path';
import { tmpdir } from 'os';
import { createWorker, OEM, PSM } from 'tesseract.js';
import type { Worker as TesseractWorker } from 'tesseract.js';
import sharp from 'sharp';
import { log } from '../utils/logger';
import { hooks } from '../hooks';
import type { MemoryStore } from '../memory/store';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OcrResult {
  text: string;
  confidence: number;
  durationMs: number;
  fallbackMeta?: {
    filename: string;
    sizeBytes: number;
    extension: string;
    /** EXIF-derived (best-effort, photos only) */
    exif?: {
      capturedAt?: string;
      cameraMake?: string;
      cameraModel?: string;
      gps?: { lat?: number; lon?: number };
      orientation?: number;
    };
  };
  /** Present when DeepSeek post-correction succeeded. */
  postprocessed?: {
    type: string;
    corrected: string;
    confidence: number;
  };
}

export interface ImageProcessorOptions {
  langs?: string;
  timeoutMs?: number;
  minTextLength?: number;
  /** Enable sharp preprocessing pipeline. Default true. */
  preprocess?: boolean;
  /** Force-skip DeepSeek postprocess regardless of env. Default: env-driven. */
  postprocess?: boolean;
}

// ---------------------------------------------------------------------------
// Constants & module state
// ---------------------------------------------------------------------------

const DEFAULT_LANGS = 'chi_sim+eng';
const DEFAULT_TIMEOUT_MS = 60_000; // tesseract.js is slower than CLI; bump.
const DEFAULT_MIN_TEXT_LENGTH = 5;
const PROMPT_OCR_CAP = 2000;
const POSTPROCESS_OCR_CAP = 4000; // hard cap on what we send to DeepSeek
const WORKER_CREATE_TIMEOUT_MS = 60_000; // First-run model download can hang on blocked CDN.
const FALLBACK_THRESHOLD = 140; // legacy fixed threshold, also used when auto fails
const OTSU_HISTOGRAM_SAMPLE_MAX = 4_000_000; // cap pixels we read for histogram (safety)

/** Worker singleton per language string. Reused across calls. */
const workerPool = new Map<string, Promise<TesseractWorker>>();

/**
 * In-flight createWorker() promises that we kicked off but may have
 * timed-out on. We still need to terminate the underlying tesseract
 * worker if/when it eventually resolves, otherwise the spawned thread
 * keeps the Node event loop alive (visible as `node --test` hanging
 * forever after the test logically finished).
 */
const orphanedCreates = new Set<Promise<TesseractWorker>>();

/** Optional MemoryStore for B5 (auto-save OCR results). Wire via setOcrMemoryStore. */
let memoryStoreRef: MemoryStore | null = null;

/** DeepSeek connection info for B3, captured via setOcrPostprocessConfig. */
interface PostprocessConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}
let postprocessConfig: PostprocessConfig | null = null;

// ---------------------------------------------------------------------------
// Wiring (called from index.ts / wherever the harness boots)
// ---------------------------------------------------------------------------

/** Wire the MemoryStore so successful OCR results are persisted (B5). */
export function setOcrMemoryStore(store: MemoryStore | null): void {
  memoryStoreRef = store;
}

/** Wire DeepSeek so post-correction (B3) can run. Pass null to disable. */
export function setOcrPostprocessConfig(cfg: PostprocessConfig | null): void {
  postprocessConfig = cfg;
}

/**
 * A13 fix: reset module-level mutable state. Tests run in a single Node
 * process and the OCR module holds three pieces of process-wide state:
 *   - memoryStoreRef      (set by setOcrMemoryStore)
 *   - postprocessConfig   (set by setOcrPostprocessConfig)
 *   - workerPool          (lazy singletons keyed by lang combo)
 * Each test that wires its own MemoryStore / fetch stub leaks state into
 * the next test if it forgets afterEach cleanup. This helper centralises
 * cleanup so test files can call one function instead of remembering each
 * setter.
 *
 * IMPORTANT: this does NOT terminate cached workers — terminating tesseract
 * workers is expensive (re-downloading lang model on the next call) and we
 * never want production code paths to drop them mid-flight by accident. To
 * also tear down workers, call `terminateAllWorkers()` separately. This
 * function only clears the *reference map*, so production keeps reusing
 * the live workers.
 *
 * Not auto-called by anything — purely a test helper exposed publicly.
 */
export function resetOcrModule(options: { clearWorkerPoolRef?: boolean } = {}): void {
  memoryStoreRef = null;
  postprocessConfig = null;
  if (options.clearWorkerPoolRef) {
    // Only the *map entries* are cleared — the live worker promises are not
    // awaited or terminated. Callers who want true teardown should follow
    // up with terminateAllWorkers().
    workerPool.clear();
  }
}

/**
 * Get (or lazily create) the worker for a given language combo.
 * Singleton: first call pays load cost (~few MB lang data); subsequent
 * callers receive the same worker.
 *
 * Bug A14 fix: tesseract.js downloads ~10-15MB of language data from a CDN
 * on first run. On offline / GFW-blocked machines that previously hung
 * forever. We race createWorker() against a hard timeout (default 60s);
 * on timeout we evict the cached promise so the next call retries cleanly
 * instead of returning the same dead promise to every subsequent caller.
 */
export async function getWorker(
  langs: string = DEFAULT_LANGS,
  createTimeoutMs: number = WORKER_CREATE_TIMEOUT_MS
): Promise<TesseractWorker> {
  let pending = workerPool.get(langs);
  if (pending) return pending;

  pending = (async () => {
    log.info('ImageProcessor: spawning tesseract.js worker', { langs });

    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(
          `tesseract.js worker create timeout after ${createTimeoutMs}ms ` +
          `(likely model CDN unreachable for langs=${langs})`
        ));
      }, createTimeoutMs);
      // Don't keep the event loop alive just for this timer.
      timer.unref?.();
    });

    // Keep a handle on the in-flight createWorker so we can terminate it
    // if our timeout fires before it resolves. Otherwise the underlying
    // worker thread/process keeps the event loop alive forever (and
    // breaks `node --test` exit, which we hit immediately in CI).
    const createPromise = createWorker(langs, OEM.LSTM_ONLY);
    orphanedCreates.add(createPromise);
    // Once the create resolves (or rejects), if nobody else terminated it
    // (i.e. we timed out) terminate it now.
    void createPromise.then(
      () => undefined,
      () => undefined
    ).finally(() => {
      // Track resolution; actual terminate decision happens in catch below.
    });

    let worker: TesseractWorker;
    try {
      worker = await Promise.race([createPromise, timeoutPromise]);
      // Successful path: this createPromise is now adopted by the cache,
      // not orphaned.
      orphanedCreates.delete(createPromise);
    } catch (err) {
      // On timeout (or any creation error), if the worker eventually
      // materialises we still need to terminate it so it doesn't leak.
      void createPromise
        .then((w) => w.terminate().catch(() => undefined))
        .catch(() => undefined)
        .finally(() => orphanedCreates.delete(createPromise));
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }

    // SINGLE_BLOCK works well for screenshots, documents, and most uploads.
    // AUTO is too slow on small images and AUTO_OSD bloats deps.
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      preserve_interword_spaces: '1'
    });
    return worker;
  })();
  workerPool.set(langs, pending);

  // If creation fails (incl. our timeout), drop the cached promise so the
  // next call retries instead of inheriting a permanently-rejected promise.
  pending.catch(() => {
    if (workerPool.get(langs) === pending) {
      workerPool.delete(langs);
    }
  });
  return pending;
}

/**
 * Terminate every cached worker. Call on graceful shutdown to free
 * native handles; safe to skip on hard exit.
 *
 * Also drains any orphaned createWorker() promises from timed-out attempts
 * so the spawned tesseract subprocess can't keep the event loop alive
 * (this matters for `node --test`, which won't exit while a worker thread
 * is parked).
 */
export async function terminateAllWorkers(): Promise<void> {
  const entries = [...workerPool.entries()];
  workerPool.clear();
  const orphans = [...orphanedCreates];
  orphanedCreates.clear();

  await Promise.allSettled([
    ...entries.map(async ([langs, pending]) => {
      try {
        const w = await pending;
        await w.terminate();
        log.info('ImageProcessor: worker terminated', { langs });
      } catch (err) {
        log.warn('ImageProcessor: worker terminate failed', {
          langs,
          error: String(err)
        });
      }
    }),
    // Drain orphaned in-flight creates: race them against a short budget,
    // and terminate any that resolve. We deliberately don't await indefinitely
    // — if createWorker is truly hung (e.g. CDN unreachable), the parent
    // will hard-exit; this is best-effort cleanup.
    ...orphans.map((p) =>
      Promise.race([
        p.then(
          (w) => w.terminate().catch(() => undefined),
          () => undefined
        ),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 2_000);
          t.unref?.();
        })
      ])
    )
  ]);
}

// Best-effort cleanup on process exit so test runners don't leak workers.
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('beforeExit', () => {
    void terminateAllWorkers();
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function processImage(
  imagePath: string,
  options: ImageProcessorOptions = {}
): Promise<OcrResult> {
  const langs = options.langs ?? DEFAULT_LANGS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minTextLength = options.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH;
  const preprocessEnabled = options.preprocess ?? true;
  const postprocessEnabled = options.postprocess ?? readPostprocessEnvDefault();
  const startTime = Date.now();

  installExitHook();

  try {
    await access(imagePath);
  } catch {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  // ---- Preprocess (B2) ---------------------------------------------------
  let workingPath = imagePath;
  let cleanupPath: string | null = null;
  if (preprocessEnabled) {
    try {
      const preprocessed = await preprocessImage(imagePath);
      if (preprocessed) {
        workingPath = preprocessed;
        cleanupPath = preprocessed;
      }
    } catch (err) {
      log.warn('ImageProcessor: preprocess failed, falling back to raw image', {
        path: imagePath,
        error: String(err)
      });
    }
  }

  // ---- OCR (B1) ----------------------------------------------------------
  let text = '';
  let tessConfidence = 0;
  try {
    const recognized = await recognizeWithTimeout(workingPath, langs, timeoutMs);
    text = (recognized.text ?? '').trim();
    tessConfidence = Math.round(recognized.confidence ?? 0);
  } catch (err) {
    log.error('ImageProcessor: tesseract.js recognize failed', {
      path: imagePath,
      error: String(err)
    });
    // Fall through to fallback meta.
  } finally {
    if (cleanupPath) {
      void unlink(cleanupPath).catch(() => undefined);
    }
  }

  const durationMs = Date.now() - startTime;

  // ---- Fallback (B4) -----------------------------------------------------
  if (text.length < minTextLength) {
    const meta = await getFallbackMeta(imagePath);
    log.info('ImageProcessor: OCR returned little/no text, using fallback meta', {
      path: imagePath,
      textLen: text.length,
      durationMs
    });
    const result: OcrResult = {
      text: '',
      confidence: 0,
      durationMs,
      fallbackMeta: meta
    };
    void emitOcrToolEvent(imagePath, result);
    return result;
  }

  // tesseract.js gives us mean per-word confidence. Blend it with the
  // char-validity heuristic from the old impl so weird OCR garbage still
  // scores low even when tesseract is misleadingly "confident".
  const heuristic = estimateConfidence(text);
  const confidence = Math.round((tessConfidence + heuristic) / 2);

  const result: OcrResult = {
    text,
    confidence,
    durationMs
  };

  // ---- Postprocess (B3) --------------------------------------------------
  if (postprocessEnabled && postprocessConfig) {
    try {
      const corrected = await postprocessWithDeepseek(text, postprocessConfig);
      if (corrected) {
        result.postprocessed = corrected;
      }
    } catch (err) {
      log.warn('ImageProcessor: DeepSeek postprocess failed (non-fatal)', {
        error: String(err)
      });
    }
  }

  log.info('ImageProcessor: OCR succeeded', {
    path: imagePath,
    textLen: text.length,
    confidence,
    durationMs,
    postprocessed: !!result.postprocessed
  });

  // ---- Persist to memory (B5) -------------------------------------------
  void persistOcrMemory(imagePath, result).catch((err) => {
    log.warn('ImageProcessor: memory persist failed (non-fatal)', {
      error: String(err)
    });
  });

  // ---- B6: emit hook so downstream (skillSynth skill extraction etc.) sees it
  void emitOcrToolEvent(imagePath, result);

  return result;
}

// ---------------------------------------------------------------------------
// Sharp preprocessing pipeline (B2)
// ---------------------------------------------------------------------------

const PREPROCESS_MIN_DIMENSION = 600;
const PREPROCESS_TARGET_DIMENSION = 1200;

async function preprocessImage(imagePath: string): Promise<string | null> {
  const buf = await readFile(imagePath);

  // Use a fresh sharp pipeline. autoOrient() honors EXIF orientation so
  // sideways photos come out upright (B2 rotate step).
  const img = sharp(buf, { failOn: 'none' }).autoOrient();
  const meta = await img.metadata();

  // Decide if we need to upscale tiny images. Tesseract is much happier
  // with > ~200dpi-equivalent input.
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const needsUpscale = w > 0 && h > 0 && (w < PREPROCESS_MIN_DIMENSION || h < PREPROCESS_MIN_DIMENSION);

  let pipe = img.grayscale().normalize();

  if (needsUpscale) {
    const longest = Math.max(w, h);
    const scale = PREPROCESS_TARGET_DIMENSION / longest;
    pipe = pipe.resize({
      width: Math.round(w * scale),
      height: Math.round(h * scale),
      kernel: 'lanczos3'
    });
  }

  // Bug P1-9 fix: pick the binarisation threshold adaptively (OTSU) instead
  // of the old hard-coded 140 which broke dark-mode screenshots (white text
  // on dark background ended up almost entirely white after thresholding,
  // killing OCR). Mode is controlled by MANAMIR_OCR_THRESHOLD:
  //   auto    (default) — compute OTSU per-image, fall back to 140 on error
  //   <int>            — use that fixed value (legacy behaviour)
  //   disable          — skip threshold step entirely (let normalize() carry)
  const mode = readThresholdMode();
  if (mode === 'disable') {
    // skip
  } else if (mode === 'auto') {
    let level = FALLBACK_THRESHOLD;
    try {
      const otsu = await computeOtsuThreshold(pipe);
      if (otsu !== null) level = otsu;
      log.info('ImageProcessor: OTSU threshold chosen', { level, fallback: otsu === null });
    } catch (err) {
      log.warn('ImageProcessor: OTSU threshold failed, using fixed fallback', {
        error: String(err),
        level: FALLBACK_THRESHOLD
      });
    }
    pipe = pipe.threshold(level);
  } else {
    pipe = pipe.threshold(mode);
  }

  // Single file in tmpdir() — no subdirectory. Earlier version used mkdtemp
  // and only deleted the inner file, leaking thousands of empty `sw-ocr-pre-*`
  // directories on a long-running daemon.
  const outPath = join(
    tmpdir(),
    `sw-ocr-pre-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  );
  await pipe.png().toFile(outPath);
  return outPath;
}

/**
 * Parse MANAMIR_OCR_THRESHOLD env var.
 *   unset / 'auto' → 'auto'
 *   'disable' / 'off' / 'none' → 'disable'
 *   numeric in [0,255] → that number
 *   anything else → 'auto' (with warning)
 */
function readThresholdMode(): 'auto' | 'disable' | number {
  const raw = (process.env.MANAMIR_OCR_THRESHOLD ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'auto') return 'auto';
  if (raw === 'disable' || raw === 'off' || raw === 'none') return 'disable';
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= 255) return Math.round(n);
  log.warn('ImageProcessor: unrecognised MANAMIR_OCR_THRESHOLD, defaulting to auto', { raw });
  return 'auto';
}

/**
 * Compute OTSU optimal threshold from the (already grayscale) sharp pipeline.
 *
 * Algorithm: standard between-class variance maximisation over a 256-bin
 * intensity histogram. Sharp does not expose a histogram via .stats(), so
 * we materialise the pixel buffer in raw 8-bit form and bin it ourselves.
 *
 * To keep memory bounded for very large inputs (~25MP phone photos), we
 * resize a copy down so total pixels <= OTSU_HISTOGRAM_SAMPLE_MAX before
 * histogramming. Subsampling for histogram estimation is standard practice
 * and doesn't materially affect OTSU's choice (cf. Otsu 1979 §3).
 *
 * Returns the chosen threshold (0-255), or null if the image is too
 * uniform for OTSU to be meaningful (e.g. blank canvas).
 */
async function computeOtsuThreshold(pipe: sharp.Sharp): Promise<number | null> {
  // clone() so we don't consume the main pipe — sharp pipelines are
  // single-shot once you call toBuffer/toFile on them.
  let probe = pipe.clone();
  const probeMeta = await probe.metadata();
  const pw = probeMeta.width ?? 0;
  const ph = probeMeta.height ?? 0;
  if (pw === 0 || ph === 0) return null;

  const totalPixels = pw * ph;
  if (totalPixels > OTSU_HISTOGRAM_SAMPLE_MAX) {
    const scale = Math.sqrt(OTSU_HISTOGRAM_SAMPLE_MAX / totalPixels);
    probe = probe.resize({
      width: Math.max(1, Math.round(pw * scale)),
      height: Math.max(1, Math.round(ph * scale)),
      kernel: 'nearest'
    });
  }

  const { data, info } = await probe
    .toColorspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Defensive: if grayscale didn't collapse to 1 channel (some inputs slip
  // through with 3 identical channels), step by info.channels and use the
  // first channel only.
  const step = info.channels || 1;
  const hist = new Array<number>(256).fill(0);
  let total = 0;
  for (let i = 0; i < data.length; i += step) {
    hist[data[i]]++;
    total++;
  }
  if (total === 0) return null;

  // OTSU between-class variance maximisation.
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let bestThreshold = FALLBACK_THRESHOLD;
  let foundAny = false;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      bestThreshold = t;
      foundAny = true;
    }
  }

  if (!foundAny || maxVar <= 0) {
    // Image is essentially single-tone — OTSU is meaningless here.
    return null;
  }
  return bestThreshold;
}

// ---------------------------------------------------------------------------
// Tesseract.js wrapper with timeout
// ---------------------------------------------------------------------------

interface RecognizedSummary {
  text: string;
  confidence: number;
}

async function recognizeWithTimeout(
  imagePath: string,
  langs: string,
  timeoutMs: number
): Promise<RecognizedSummary> {
  const worker = await getWorker(langs);

  const buf = await readFile(imagePath);

  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`tesseract.js timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      worker.recognize(buf),
      timeoutPromise
    ]);
    return {
      text: result.data.text ?? '',
      confidence: result.data.confidence ?? 0
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fallback metadata (B4) — file stats + best-effort EXIF
// ---------------------------------------------------------------------------

async function getFallbackMeta(imagePath: string): Promise<OcrResult['fallbackMeta']> {
  try {
    const s = await stat(imagePath);
    const meta: NonNullable<OcrResult['fallbackMeta']> = {
      filename: basename(imagePath),
      sizeBytes: s.size,
      extension: extname(imagePath).toLowerCase()
    };

    // Best-effort EXIF read. Sharp returns a Buffer of raw EXIF tags; we
    // do a lightweight parse on the common ones. Failure is silent — many
    // images (PNGs, screenshots) have no EXIF at all.
    try {
      const buf = await readFile(imagePath);
      const m = await sharp(buf, { failOn: 'none' }).metadata();
      const exif: NonNullable<NonNullable<OcrResult['fallbackMeta']>['exif']> = {};
      if (m.orientation) exif.orientation = m.orientation;
      // Sharp surfaces high-level EXIF parse via metadata().exif as a Buffer.
      // We don't bring in another lib; just expose orientation + raw presence.
      // If a real photo workflow needs full EXIF later, swap in `exifr`.
      if (Object.keys(exif).length > 0) meta.exif = exif;
    } catch {
      // EXIF read is purely informational; ignore failures.
    }

    return meta;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Confidence heuristic (carried over from system-tesseract impl)
// ---------------------------------------------------------------------------

function estimateConfidence(text: string): number {
  if (text.length === 0) return 0;
  const validRe = /[\p{L}\p{N}\p{P}\s]/gu;
  const valid = (text.match(validRe) ?? []).length;
  return Math.round((valid / text.length) * 100);
}

// ---------------------------------------------------------------------------
// Prompt formatter (signature kept for backward compat)
// ---------------------------------------------------------------------------

/**
 * Render an OCR result as a single bracketed token for prompt injection.
 * Caps text at PROMPT_OCR_CAP chars to prevent a single image from blowing
 * the prompt budget. If postprocessing is present, prefer the corrected text.
 */
export function formatOcrForPrompt(result: OcrResult, imagePath: string): string {
  const filename = basename(imagePath);
  if (result.text) {
    const display = result.postprocessed?.corrected || result.text;
    const capped = display.length > PROMPT_OCR_CAP
      ? display.slice(0, PROMPT_OCR_CAP) + '...[truncated]'
      : display;
    if (result.postprocessed) {
      return `[image: ${filename} | OCR (${result.confidence}%) | type:${result.postprocessed.type}: ${capped}]`;
    }
    return `[image: ${filename} | OCR (${result.confidence}%): ${capped}]`;
  }
  if (result.fallbackMeta) {
    const m = result.fallbackMeta;
    const sizeKb = Math.round(m.sizeBytes / 1024);
    return `[image: ${m.filename} | ${m.extension} | ${sizeKb}KB | OCR found no text — likely a non-text image]`;
  }
  return `[image: ${filename} | OCR failed]`;
}

// ---------------------------------------------------------------------------
// B3: DeepSeek post-correction
// ---------------------------------------------------------------------------

function readPostprocessEnvDefault(): boolean {
  const raw = process.env.MANAMIR_OCR_POSTPROCESS;
  if (raw === undefined || raw === '') return true;
  return raw.toLowerCase() !== 'false' && raw !== '0';
}

const POSTPROCESS_PROMPT = `以下是 OCR 从图片提取的文字，可能有错认（O→0、l→1、中文相似字混淆）和结构丢失。
请：
1. 修正明显的字符错认
2. 如果是表格，重组为 markdown 表格
3. 如果是代码，恢复缩进
4. 识别内容类型（代码/账单/邮件/合同/对话/其他）

只返回严格的 JSON（不要包 markdown fence、不要解释）：
{"type": "类型", "corrected": "修正后的文字", "confidence_in_correction": 0-100}`;

interface PostprocessRaw {
  type?: string;
  corrected?: string;
  confidence_in_correction?: number;
}

async function postprocessWithDeepseek(
  ocrText: string,
  cfg: PostprocessConfig
): Promise<OcrResult['postprocessed']> {
  const trimmed = ocrText.length > POSTPROCESS_OCR_CAP
    ? ocrText.slice(0, POSTPROCESS_OCR_CAP)
    : ocrText;

  const userMessage = `${POSTPROCESS_PROMPT}\n\n原始 OCR：\n\`\`\`\n${trimmed}\n\`\`\``;

  const body = {
    model: cfg.model,
    messages: [
      { role: 'user', content: userMessage }
    ],
    max_tokens: 1500,
    temperature: 0.1,
    stream: false
  };

  // 10s timeout — postprocess is best-effort. If DeepSeek hangs, we'd rather
  // skip correction than block the whole OCR pipeline behind it.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body),
      signal: ac.signal
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new Error('DeepSeek postprocess timeout (10s)');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`DeepSeek HTTP ${response.status}`);
  }
  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek returned empty content');

  // DeepSeek occasionally wraps JSON in ```json ... ``` despite the prompt;
  // strip fences before parse.
  const cleaned = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let parsed: PostprocessRaw;
  try {
    parsed = JSON.parse(cleaned) as PostprocessRaw;
  } catch (err) {
    throw new Error(`DeepSeek JSON parse failed: ${(err as Error).message}`);
  }

  const corrected = typeof parsed.corrected === 'string' ? parsed.corrected.trim() : '';
  if (!corrected) throw new Error('DeepSeek returned empty corrected text');

  return {
    type: typeof parsed.type === 'string' && parsed.type.length > 0 ? parsed.type : '其他',
    corrected,
    confidence: typeof parsed.confidence_in_correction === 'number'
      ? Math.max(0, Math.min(100, Math.round(parsed.confidence_in_correction)))
      : 0
  };
}

// ---------------------------------------------------------------------------
// B5: persist successful OCR results to MemoryStore so they're searchable
// ---------------------------------------------------------------------------

async function persistOcrMemory(imagePath: string, result: OcrResult): Promise<void> {
  if (!memoryStoreRef) return;
  if (!result.text) return; // only persist when OCR actually got text

  const ts = Date.now();
  const filename = basename(imagePath);
  // Cheap content hash so two screenshots of the same dialog don't both
  // hit memory under colliding names. Not crypto-strength; just disambiguating.
  const hash = simpleHash(result.text).toString(16).slice(0, 8);
  // Bug A8 fix: previously `name = ocr-{ts}-{hash}` collided when two
  // identical-content images landed in the same millisecond (e.g. a Discord
  // burst of the same screenshot at slightly different sizes), silently
  // overwriting the earlier memory file. Append a 6-char random suffix so
  // identical content is preserved as distinct memory entries. Not
  // crypto-strength — collision odds 1-in-~2.2B per ms+hash bucket.
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  const name = `ocr-${ts}-${hash}-${rand}`;

  const headSnippet = result.text.slice(0, 50).replace(/\s+/g, ' ').trim();
  const description = `OCR ${filename} — ${headSnippet}${result.text.length > 50 ? '…' : ''}`;

  const lines: string[] = [
    `**Source image:** ${filename}`,
    `**Captured at:** ${new Date(ts).toISOString()}`,
    `**OCR confidence:** ${result.confidence}%`,
    `**Duration:** ${result.durationMs}ms`,
    ''
  ];
  if (result.postprocessed) {
    lines.push(`**Detected type:** ${result.postprocessed.type}`);
    lines.push(`**Correction confidence:** ${result.postprocessed.confidence}%`);
    lines.push('', '## Corrected text', '```', result.postprocessed.corrected, '```', '');
    lines.push('## Raw OCR', '```', result.text, '```');
  } else {
    lines.push('## OCR text', '```', result.text, '```');
  }

  memoryStoreRef.save({
    name,
    description,
    type: 'ocr-history',
    content: lines.join('\n'),
    createdAt: ts,
    updatedAt: ts
  });
}

function simpleHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ---------------------------------------------------------------------------
// B6: emit a hook event so skillSynth / selfReview can observe OCR as a tool call
// ---------------------------------------------------------------------------

async function emitOcrToolEvent(imagePath: string, result: OcrResult): Promise<void> {
  try {
    // A12 fix: separate "the OCR call itself succeeded" from "the OCR call
    // produced text". Previously we conflated the two via `ok = !!result.text`,
    // so the fallback path (image with no extractable text) emitted ok=false
    // and downstream skillSynth/selfReview logic would treat it as a failure even
    // though processImage() ran cleanly. Now:
    //   ok       = always true here (we got past tesseract without throwing,
    //              even if the result is the fallback-meta object)
    //   hasText  = whether OCR actually extracted >= minTextLength chars
    // Downstream observers that previously read `ok` should switch to
    // `hasText` when their question is "did we get any text?".
    await hooks.emit('tool:after', {
      tool: 'ocr.processImage',
      ok: true,
      hasText: !!result.text,
      input: { path: imagePath },
      output: {
        textLen: result.text.length,
        confidence: result.confidence,
        postprocessedType: result.postprocessed?.type ?? null
      },
      durationMs: result.durationMs
    });
  } catch (err) {
    // Hooks are observability — never let them break OCR.
    log.warn('ImageProcessor: hooks.emit failed (non-fatal)', { error: String(err) });
  }
  // TODO(skillSynth): once the skillSynth extractor explicitly indexes
  // 'ocr.processImage' as a skill candidate, this event will let it
  // chain "OCR → derived action" sequences. Currently observed only.
}
