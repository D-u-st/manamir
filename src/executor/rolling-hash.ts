// N-gram streaming repetition detection via rolling hash (v2.6.0)
//
// Why this exists: v6 pattern-based cascade detection (api-executor.ts:912)
// catches verbal cascades ("让我搜索..."). It does NOT catch:
//   - Model emits same JSON object 5 times: {"tool":"x","arg":1} {"tool":"x"...
//   - Model emits same code block twice in a row
//   - Model dumps same paragraph repeatedly with minor edits
//
// DeepSeek-chat in
// production has been observed emitting 1.8KB of TreeNode struct definition
// on loop (bot-2026-04-20.log:17:32:50 — old sentence-split caught it but
// false-positively).
//
// Approach: Rabin-Karp rolling hash over the streaming buffer.
//   - Window: 64 chars (long enough to skip variable names like "node->")
//   - Stride: 1 (every char shifts the window)
//   - When same hash hits ≥ THRESHOLD times AND substring actually matches
//     (defends against hash collisions) → trigger
//
// Code-block guard:
//   - Track ``` fence depth; skip detection inside code fences
//   - Reason: model legitimately emits repeated keywords inside code
//     (TreeNode struct definitions are valid output, not loops)
//
// Ngram-collision check:
//   - Two strings can hash-collide. Before triggering, verify the actual
//     substring matches across all hash hits. Adds O(window * threshold)
//     compare per trigger (negligible vs the gain from no false positives).

import { log } from '../utils/logger';

export interface RollingHashConfig {
  windowSize: number;      // chars per ngram (default 64)
  threshold: number;       // identical ngrams seen → trigger (default 4)
  bufferLimit: number;     // max chars in buffer (default 16384)
  minBufferSize: number;   // don't check until buffer has this many chars (default 256)
}

export const DEFAULT_CONFIG: RollingHashConfig = {
  windowSize: 64,
  threshold: 4,
  bufferLimit: 16_384,
  minBufferSize: 256,
};

// Rabin-Karp parameters.
const HASH_BASE = 131;
const HASH_MOD = 2 ** 30 - 35; // ~1B prime-ish; collisions verified by string compare

/** Detection result for diagnostics + selfReview learning. */
export interface RepeatDetection {
  detected: boolean;
  reason?: string;
  ngram?: string;
  hits?: number;
}

export class RollingHashDetector {
  private config: RollingHashConfig;
  private buffer = '';
  private inCodeFence = false;
  private fenceLines = 0; // last partial line for fence detection
  // Map from hash → list of [start_index_in_buffer]
  private hashIndex = new Map<number, number[]>();
  private precomputedPow = 1; // BASE^(window-1) mod MOD, computed once
  private lastIndexedEnd = 0; // exclusive end of indexed ngram start positions

  constructor(configOverride?: Partial<RollingHashConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...(configOverride ?? {}) };
    // Precompute pow for rolling subtraction
    for (let i = 0; i < this.config.windowSize - 1; i++) {
      this.precomputedPow = (this.precomputedPow * HASH_BASE) % HASH_MOD;
    }
  }

  /**
   * Feed new content + check for repeats. Returns detection result.
   * Caller should abort the stream if detected.
   */
  feed(chunk: string): RepeatDetection {
    if (!chunk) return { detected: false };
    this.buffer += chunk;

    // Trim buffer to limit (keep recent chars; drop oldest hash entries)
    if (this.buffer.length > this.config.bufferLimit) {
      const drop = this.buffer.length - this.config.bufferLimit;
      this.buffer = this.buffer.slice(drop);
      // Rebuild hashIndex with shifted positions, dropping anything < 0
      const newIndex = new Map<number, number[]>();
      for (const [h, positions] of this.hashIndex) {
        const shifted = positions.map((p) => p - drop).filter((p) => p >= 0);
        if (shifted.length > 0) newIndex.set(h, shifted);
      }
      this.hashIndex = newIndex;
      this.lastIndexedEnd = Math.max(0, this.lastIndexedEnd - drop);
    }

    // Update code fence state from new content
    this.updateFenceState(chunk);
    if (this.inCodeFence) {
      // Inside code: don't detect, but keep buffering so we resume detection
      // cleanly when fence closes. Also skip indexing — we don't want code
      // ngrams polluting the hashIndex (would false-positive after fence close).
      return { detected: false };
    }

    // Index every unindexed ngram start position. We always index (regardless
    // of minBufferSize) so that when the buffer finally crosses the threshold,
    // we have full history to detect against. Without this, early ngrams from
    // feeds 1..N (before threshold) were never indexed, and feed N+1's check
    // would miss them.
    const endIndex = this.buffer.length - this.config.windowSize + 1;
    if (endIndex > this.lastIndexedEnd) {
      for (let i = this.lastIndexedEnd; i < endIndex; i++) {
        const h = this.hashAt(i);
        let positions = this.hashIndex.get(h);
        if (!positions) {
          positions = [];
          this.hashIndex.set(h, positions);
        }
        positions.push(i);
      }
      this.lastIndexedEnd = endIndex;
    }

    // Don't run detection below min buffer (avoid false-positives on tiny inputs)
    if (this.buffer.length < this.config.minBufferSize) {
      return { detected: false };
    }

    // Check the ngrams that just got indexed in this feed.
    const oldLen = this.buffer.length - chunk.length;
    const startCheck = Math.max(0, oldLen - this.config.windowSize + 1);
    const endCheck = endIndex;

    for (let i = startCheck; i < endCheck; i++) {
      const positions = this.hashIndex.get(this.hashAt(i));
      if (!positions) continue;

      // Trigger check only after we have ≥ threshold positions for this hash
      if (positions.length >= this.config.threshold) {
        // Verify with actual string compare (defend against collisions)
        const candidate = this.buffer.substr(i, this.config.windowSize);
        let realMatches = 0;
        for (const p of positions) {
          if (this.buffer.substr(p, this.config.windowSize) === candidate) {
            realMatches++;
          }
        }
        if (realMatches >= this.config.threshold) {
          log.warn('RollingHashDetector: repeat detected', {
            ngram: candidate.slice(0, 40) + '…',
            hits: realMatches,
            bufferLen: this.buffer.length,
          });
          return {
            detected: true,
            reason: 'ngram-repeat',
            ngram: candidate,
            hits: realMatches,
          };
        }
      }
    }

    return { detected: false };
  }

  /** Reset state — call between sessions. */
  reset(): void {
    this.buffer = '';
    this.hashIndex.clear();
    this.inCodeFence = false;
    this.fenceLines = 0;
    this.lastIndexedEnd = 0;
  }

  /** Stats for /status. */
  get stats(): { bufferLen: number; uniqueHashes: number; inCodeFence: boolean } {
    return {
      bufferLen: this.buffer.length,
      uniqueHashes: this.hashIndex.size,
      inCodeFence: this.inCodeFence,
    };
  }

  /**
   * Hash buffer.substr(start, windowSize) using simple polynomial.
   * Recomputes from scratch (we don't need rolling subtraction since we
   * compute in batches and chunks are small).
   */
  private hashAt(start: number): number {
    let h = 0;
    const end = start + this.config.windowSize;
    for (let i = start; i < end; i++) {
      h = (h * HASH_BASE + this.buffer.charCodeAt(i)) % HASH_MOD;
    }
    return h;
  }

  /**
   * Track ``` code-fence state. Toggles on every triple-backtick we see.
   * Robust against ```ts vs ```python vs bare ``` — only counts the marker.
   */
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
