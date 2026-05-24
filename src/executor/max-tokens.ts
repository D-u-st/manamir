// Per-model max_tokens cap with dynamic adjust (v2.6.0)
//
// CC精读 (13-1 api-core, getMaxOutputTokensForModel) drives caps from BQ p99
// data — observed Claude p99 ~4911 vs default 32K = 8× waste. We don't have
// fleet telemetry but we have model docs + production observation:
//
//   - DeepSeek chat: API max 8192, p95 well under 4K
//   - DeepSeek reasoner: API max 65536, but reasoning_content adds ~2-8K alone
//   - Claude 3.5 sonnet: API max 8192
//   - GPT-4o: API max 16384
//
// Capping at API max is wasteful (most responses don't need it), but capping
// too low breaks long answers. Solution: start conservative, bump dynamically
// when the session keeps hitting `length` stop_reason.
//
// Why dynamic over fixed:
//   - Most turns end with stop=stop or tool_calls → small cap is fine
//   - Genuine long-answer turns (full code file rewrite, big refactor) hit
//     `length` → bump cap for THIS session
//   - New session resets to baseline — no permanent inflation
//
// Cap is per-session, not per-process: different conversations have wildly
// different needs and persisting across sessions defeats the conservative
// default.

export interface ModelTokenLimits {
  /** Hard ceiling per the API spec; we never exceed this. */
  apiMax: number;
  /** Conservative starting cap — covers ~95% of turns. */
  baseline: number;
  /** Increment when a session keeps hitting `length`. */
  bumpStep: number;
  /** Per-session ceiling — we won't keep bumping past this. */
  sessionCeiling: number;
}

const LIMITS: Record<string, ModelTokenLimits> = {
  'deepseek-chat': {
    apiMax: 8_192,
    baseline: 4_096,
    bumpStep: 2_048,
    sessionCeiling: 8_192,
  },
  'deepseek-reasoner': {
    // reasoning_content can be 2-8K; output budget on top of that.
    // API max is 65K but we cap lower since most users won't need it.
    apiMax: 65_536,
    baseline: 8_192,
    bumpStep: 4_096,
    sessionCeiling: 32_768,
  },
  'claude-3.5-sonnet': {
    apiMax: 8_192,
    baseline: 4_096,
    bumpStep: 2_048,
    sessionCeiling: 8_192,
  },
  'claude-sonnet': {
    apiMax: 8_192,
    baseline: 4_096,
    bumpStep: 2_048,
    sessionCeiling: 8_192,
  },
  'claude-opus': {
    apiMax: 8_192,
    baseline: 4_096,
    bumpStep: 2_048,
    sessionCeiling: 8_192,
  },
  'gpt-4o': {
    apiMax: 16_384,
    baseline: 4_096,
    bumpStep: 2_048,
    sessionCeiling: 16_384,
  },
  'gpt-4': {
    apiMax: 8_192,
    baseline: 4_096,
    bumpStep: 2_048,
    sessionCeiling: 8_192,
  },
  default: {
    apiMax: 8_192,
    baseline: 4_096,
    bumpStep: 2_048,
    sessionCeiling: 8_192,
  },
};

/** Threshold of consecutive `length` hits before bumping. */
export const BUMP_AFTER_HITS = 2;

/** Match by exact key first, then prefix; falls back to default. */
export function getModelTokenLimits(model: string): ModelTokenLimits {
  if (LIMITS[model]) return LIMITS[model];
  for (const key of Object.keys(LIMITS)) {
    if (key !== 'default' && model.startsWith(key)) return LIMITS[key];
  }
  return LIMITS.default;
}

/**
 * Per-session token budget tracker. One instance per ApiExecutor session.
 * Bump fires after BUMP_AFTER_HITS consecutive `length` stops, capped at
 * sessionCeiling.
 */
export class TokenBudget {
  private limits: ModelTokenLimits;
  private currentCap: number;
  private lengthHits = 0;
  private bumpsApplied = 0;

  constructor(public readonly model: string, userOverride?: number) {
    this.limits = getModelTokenLimits(model);
    // User-provided maxTokens (e.g. via CLI flag) wins, but still capped at apiMax.
    if (userOverride && userOverride > 0) {
      this.currentCap = Math.min(userOverride, this.limits.apiMax);
    } else {
      this.currentCap = this.limits.baseline;
    }
  }

  /** What max_tokens to send on the next request. */
  get cap(): number {
    return this.currentCap;
  }

  /** Stats for /status / diagnostics. */
  get stats(): { cap: number; lengthHits: number; bumpsApplied: number; ceiling: number } {
    return {
      cap: this.currentCap,
      lengthHits: this.lengthHits,
      bumpsApplied: this.bumpsApplied,
      ceiling: this.limits.sessionCeiling,
    };
  }

  /**
   * Call after each turn with the response's stop_reason.
   * On consecutive `length` hits, bumps the cap for the next request.
   * Resets the counter on any non-`length` stop.
   */
  observeStopReason(reason: string | undefined): void {
    if (reason === 'length' || reason === 'max_tokens') {
      this.lengthHits++;
      if (
        this.lengthHits >= BUMP_AFTER_HITS &&
        this.currentCap < this.limits.sessionCeiling
      ) {
        const next = Math.min(
          this.currentCap + this.limits.bumpStep,
          this.limits.sessionCeiling,
        );
        if (next > this.currentCap) {
          this.currentCap = next;
          this.bumpsApplied++;
          this.lengthHits = 0; // reset to avoid bumping every turn
        }
      }
    } else if (reason) {
      // Any clean stop resets — single occasional `length` doesn't bump.
      this.lengthHits = 0;
    }
    // undefined reason (e.g. mid-stream abort) doesn't change state.
  }

  /**
   * Whether the previous turn's stop_reason indicates content was truncated.
   * Caller can use this to decide whether to inject a "continue" hint.
   */
  static wasTruncated(stopReason: string | undefined): boolean {
    return stopReason === 'length' || stopReason === 'max_tokens';
  }
}
