// Loop/hallucination detection (P-76) — detect repetitive executor outputs
import { EventEmitter } from 'events';
import { log } from '../utils/logger';

export type LoopLevel = 'ok' | 'warning' | 'critical';

export interface LoopDetectorOptions {
  windowSize: number;       // sliding window (default 10)
  warningThreshold: number; // similar outputs for WARNING (default 3)
  criticalThreshold: number;// similar outputs for CRITICAL (default 5)
  similarityThreshold: number; // 0-1, ratio for "similar" (default 0.8)
}

const DEFAULTS: LoopDetectorOptions = {
  windowSize: 10,
  warningThreshold: 3,
  criticalThreshold: 5,
  similarityThreshold: 0.8
};

export class LoopDetector extends EventEmitter {
  private window: string[] = [];
  private opts: LoopDetectorOptions;
  private currentLevel: LoopLevel = 'ok';

  constructor(options: Partial<LoopDetectorOptions> = {}) {
    super();
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Record an executor output and check for loops. Returns current level. */
  record(output: string): LoopLevel {
    const normalized = this.normalize(output);
    this.window.push(normalized);
    if (this.window.length > this.opts.windowSize) {
      this.window.shift();
    }

    const streak = this.getStreak();
    const prev = this.currentLevel;

    if (streak >= this.opts.criticalThreshold) {
      this.currentLevel = 'critical';
      if (prev !== 'critical') {
        log.error('Loop detected: CRITICAL — auto-aborting', { streak });
        this.emit('critical', { streak, lastOutput: output });
      }
    } else if (streak >= this.opts.warningThreshold) {
      this.currentLevel = 'warning';
      if (prev === 'ok') {
        log.warn('Loop detected: WARNING — similar outputs repeating', { streak });
        this.emit('warning', { streak, lastOutput: output });
      }
    } else {
      this.currentLevel = 'ok';
    }

    return this.currentLevel;
  }

  getLevel(): LoopLevel {
    return this.currentLevel;
  }

  reset(): void {
    this.window = [];
    this.currentLevel = 'ok';
  }

  /** Count consecutive similar outputs from the end of the window */
  private getStreak(): number {
    if (this.window.length < 2) return 1;
    const last = this.window[this.window.length - 1];
    let streak = 1;
    for (let i = this.window.length - 2; i >= 0; i--) {
      if (this.similarity(this.window[i], last) >= this.opts.similarityThreshold) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }

  /** Normalize whitespace for comparison */
  private normalize(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
  }

  /** Levenshtein-based string similarity */
  private similarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;

    const len1 = a.length, len2 = b.length;
    // Optimization: if lengths differ by >50%, they're not similar
    if (Math.abs(len1 - len2) / Math.max(len1, len2) > 0.5) return 0;

    // Levenshtein
    let prev = Array.from({ length: len2 + 1 }, (_, i) => i);
    for (let i = 1; i <= len1; i++) {
        const curr = [i];
        for (let j = 1; j <= len2; j++) {
            curr[j] = a[i-1] === b[j-1]
                ? prev[j-1]
                : 1 + Math.min(prev[j], curr[j-1], prev[j-1]);
        }
        prev = curr;
    }
    return 1 - prev[len2] / Math.max(len1, len2);
  }
}
