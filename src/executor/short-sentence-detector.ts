// Short-sentence repetition detector (v2.7.0 V0)
//
// Why this exists: rolling-hash.ts (v2.6.0) catches LONG-window repeats
// (windowSize=64, threshold=4, minBufferSize=256). It's blind to:
//   - Short preamble repeats: "我来帮你...。我来帮你...。" (~22 chars × 2)
//   - DeepSeek-chat occasionally emits the same tool-use opener 2× in a row
//     before the actual tool_call. Observed 2026-04-22 OI-binary-tree session.
//
// This detector is the second layer specifically for short-sentence repeats:
//   - Splits stream by sentence punctuation (。.!?！？\n)
//   - Tracks recent sentences in a rolling map (last N=8)
//   - When the same normalized sentence (8 ≤ len ≤ 80) appears ≥ THRESHOLD
//     times → trigger
//   - Only active in PREAMBLE phase (totalContentLen < PREAMBLE_LIMIT chars)
//     to avoid false-positives in long answers / lists / refrains
//
// Why preamble-only: legitimate long answers may repeat short refrain phrases
// (e.g., enumerated lists "First, ... First, you must..."). Bug pattern is
// specifically the model "restarting" its opener — this only happens early.
//
// Code-fence guard: identical to RollingHashDetector — skip detection when
// inside ``` fences. Code legitimately repeats short tokens.

import { log } from '../utils/logger';

export interface ShortSentenceConfig {
  minSentenceChars: number;   // ignore sentences shorter than this (noise)
  threshold: number;           // identical sentences seen → trigger
  preambleLimit: number;       // only active while totalContentLen < this
  recentWindow: number;        // how many recent sentences to track
}

export const DEFAULT_CONFIG: ShortSentenceConfig = {
  minSentenceChars: 8,
  threshold: 2,
  preambleLimit: 200,
  recentWindow: 8,
};

const SENTENCE_END_RE = /[。．.!?！？\n]/;

export interface ShortRepeatDetection {
  detected: boolean;
  reason?: string;
  sentence?: string;
  hits?: number;
}

export class ShortSentenceDetector {
  private config: ShortSentenceConfig;
  private buffer = '';                  // unflushed chunk tail (until next sentence-end)
  private inCodeFence = false;
  private recent: string[] = [];        // sliding window of recent normalized sentences
  // Counts of normalized sentence → occurrences within the window
  private counts = new Map<string, number>();

  constructor(configOverride?: Partial<ShortSentenceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...(configOverride ?? {}) };
  }

  /**
   * Feed new content + check for short-sentence repeats.
   * @param chunk raw new content
   * @param totalContentLen total accumulated content length (for preamble gate)
   */
  feed(chunk: string, totalContentLen: number): ShortRepeatDetection {
    if (!chunk) return { detected: false };

    // Past preamble — stop detecting (avoid false-positives on long output)
    if (totalContentLen >= this.config.preambleLimit) {
      // Reset state so a long-running session doesn't carry stale preamble
      // counts forward (next short turn would inherit + false-positive).
      if (this.recent.length > 0 || this.counts.size > 0) {
        this.recent = [];
        this.counts.clear();
        this.buffer = '';
      }
      return { detected: false };
    }

    // Update fence state (any ``` toggles)
    this.updateFenceState(chunk);
    if (this.inCodeFence) {
      // Don't process while in code fence; also drop any partial buffer
      this.buffer = '';
      return { detected: false };
    }

    this.buffer += chunk;

    // Drain completed sentences
    let m: RegExpMatchArray | null;
    while ((m = this.buffer.match(SENTENCE_END_RE)) !== null) {
      const idx = m.index!;
      const raw = this.buffer.slice(0, idx); // sentence body without terminator
      this.buffer = this.buffer.slice(idx + 1);

      const normalized = this.normalize(raw);
      if (normalized.length < this.config.minSentenceChars) continue;

      // Increment count + push to recent window
      const newCount = (this.counts.get(normalized) ?? 0) + 1;
      this.counts.set(normalized, newCount);
      this.recent.push(normalized);

      // Evict oldest if window exceeded
      if (this.recent.length > this.config.recentWindow) {
        const evicted = this.recent.shift()!;
        const c = this.counts.get(evicted);
        if (c !== undefined) {
          if (c <= 1) this.counts.delete(evicted);
          else this.counts.set(evicted, c - 1);
        }
      }

      if (newCount >= this.config.threshold) {
        log.warn('ShortSentenceDetector: repeat detected', {
          sentence: normalized.slice(0, 40) + (normalized.length > 40 ? '…' : ''),
          hits: newCount,
          totalContentLen,
        });
        return {
          detected: true,
          reason: 'short-sentence-repeat',
          sentence: normalized,
          hits: newCount,
        };
      }
    }

    return { detected: false };
  }

  /** Reset state — call between sessions / turns. */
  reset(): void {
    this.buffer = '';
    this.inCodeFence = false;
    this.recent = [];
    this.counts.clear();
  }

  /** Stats for /status diagnostics. */
  get stats(): {
    bufferLen: number;
    trackedSentences: number;
    inCodeFence: boolean;
  } {
    return {
      bufferLen: this.buffer.length,
      trackedSentences: this.recent.length,
      inCodeFence: this.inCodeFence,
    };
  }

  /**
   * Normalize a sentence for comparison: collapse whitespace + trim.
   * "我来    帮你..." and "我来帮你..." compare equal under this.
   */
  private normalize(s: string): string {
    return s.replace(/\s+/g, '').trim();
  }

  /** Toggle inCodeFence on every ``` marker. Mirrors RollingHashDetector. */
  private updateFenceState(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const idx = chunk.indexOf('```', i);
      if (idx < 0) break;
      this.inCodeFence = !this.inCodeFence;
      i = idx + 3;
    }
  }
}
