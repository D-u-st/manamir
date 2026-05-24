// RateLimitTracker — parses standard OpenAI-style rate-limit headers and
// surfaces "should I sleep before the next call?" hints.
//
// Headers handled (case-insensitive):
//   x-ratelimit-remaining-requests
//   x-ratelimit-remaining-tokens
//   x-ratelimit-reset-requests   (duration: "5", "1ms", "1.5s", "1m30s", or epoch-seconds)
//   x-ratelimit-reset-tokens
//   retry-after                  (seconds — RFC-7231; HTTP-date form not supported)
//
// shouldSleepBeforeNext():
//   - If a 'retry-after' has been observed AND its target is in the future
//     → returns ms until target.
//   - Else if requestsRemaining <= CRITICAL_REQUESTS (2) AND
//     resetAt is < CRITICAL_WINDOW_MS (30s) away → returns ms until reset.
//   - Otherwise 0.

import { log } from '../utils/logger';

export interface RateLimitSnapshot {
  requestsRemaining?: number;
  tokensRemaining?: number;
  requestsResetAt?: number;  // epoch ms
  tokensResetAt?: number;
  retryAfterAt?: number;     // epoch ms (server-mandated wait)
  lastUpdated: number;
}

const WARN_REQUESTS = 10;
const CRITICAL_REQUESTS = 2;
const CRITICAL_WINDOW_MS = 30_000;

export class RateLimitTracker {
  private snapshot: RateLimitSnapshot = { lastUpdated: 0 };

  /**
   * Update the snapshot from a Headers object or plain record. Missing headers
   * are simply ignored (the previous snapshot value is retained).
   */
  update(headers: Headers | Record<string, string> | Record<string, string | undefined>): void {
    const get = makeGetter(headers);

    const reqRem = parseIntSafe(get('x-ratelimit-remaining-requests'));
    const tokRem = parseIntSafe(get('x-ratelimit-remaining-tokens'));
    const reqReset = parseDurationOrEpochToMs(get('x-ratelimit-reset-requests'));
    const tokReset = parseDurationOrEpochToMs(get('x-ratelimit-reset-tokens'));
    const retryAfter = parseRetryAfterMs(get('retry-after'));

    const now = Date.now();
    if (reqRem !== undefined) this.snapshot.requestsRemaining = reqRem;
    if (tokRem !== undefined) this.snapshot.tokensRemaining = tokRem;
    if (reqReset !== undefined) this.snapshot.requestsResetAt = now + reqReset;
    if (tokReset !== undefined) this.snapshot.tokensResetAt = now + tokReset;
    if (retryAfter !== undefined) this.snapshot.retryAfterAt = now + retryAfter;
    this.snapshot.lastUpdated = now;

    // Warn-level threshold for visibility.
    if (reqRem !== undefined && reqRem <= WARN_REQUESTS) {
      log.warn('RateLimitTracker: requests budget low', {
        remaining: reqRem,
        resetMs: reqReset
      });
    }
  }

  /** Read-only copy of the latest snapshot. */
  getSnapshot(): RateLimitSnapshot {
    return { ...this.snapshot };
  }

  /**
   * Returns ms to sleep before the next call. Zero means "go now".
   * Uses Date.now() at call time so old snapshots naturally expire.
   */
  shouldSleepBeforeNext(): number {
    const now = Date.now();

    // Honor server-mandated retry-after first.
    if (this.snapshot.retryAfterAt !== undefined) {
      const wait = this.snapshot.retryAfterAt - now;
      if (wait > 0) return wait;
    }

    const remaining = this.snapshot.requestsRemaining;
    const resetAt = this.snapshot.requestsResetAt;
    if (
      remaining !== undefined &&
      remaining <= CRITICAL_REQUESTS &&
      resetAt !== undefined
    ) {
      const wait = resetAt - now;
      if (wait > 0 && wait < CRITICAL_WINDOW_MS) {
        return wait;
      }
    }

    return 0;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function makeGetter(
  headers: Headers | Record<string, string> | Record<string, string | undefined>
): (name: string) => string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    const h = headers as Headers;
    return (name) => {
      const v = h.get(name);
      return v === null ? undefined : v;
    };
  }
  // Plain object — build a lower-cased lookup once.
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers as Record<string, string | undefined>)) {
    if (v !== undefined) lower[k.toLowerCase()] = v;
  }
  return (name) => lower[name.toLowerCase()];
}

function parseIntSafe(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
}

/**
 * Parse OpenAI-style reset values into milliseconds-from-now.
 * Accepted forms:
 *   "5"        → 5000 ms (bare seconds; OpenAI legacy)
 *   "5ms"      → 5 ms
 *   "1.5s"     → 1500 ms
 *   "1m30s"    → 90_000 ms
 *   "1h2m3s"   → 3_723_000 ms
 *   "1700000000" (>= 10^10) → treated as epoch ms relative to now
 *
 * Returns undefined if input is missing / unparseable / negative.
 */
function parseDurationOrEpochToMs(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const s = v.trim();

  // Pure number?
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return undefined;
    // Heuristic: very large → epoch (seconds since 1970 ≈ 1.7e9, ms ≈ 1.7e12)
    if (n >= 1e10) {
      // Treat as epoch ms.
      const delta = n - Date.now();
      return delta > 0 ? delta : 0;
    }
    if (n >= 1e9) {
      // Treat as epoch seconds.
      const delta = n * 1000 - Date.now();
      return delta > 0 ? delta : 0;
    }
    // Bare seconds.
    const ms = Math.round(n * 1000);
    return ms >= 0 ? ms : undefined;
  }

  // Composite duration: e.g. "1h2m3s500ms"
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const num = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (!Number.isFinite(num)) return undefined;
    if (unit === 'ms') total += num;
    else if (unit === 's') total += num * 1000;
    else if (unit === 'm') total += num * 60_000;
    else if (unit === 'h') total += num * 3_600_000;
  }
  if (!matched) return undefined;
  return Math.round(total);
}

/**
 * Parse the Retry-After header. Per RFC-7231 it can be either delta-seconds
 * or an HTTP-date; we handle the former (most LLM providers send seconds).
 */
function parseRetryAfterMs(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.round(n * 1000);
  }
  // HTTP-date fallback
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    const delta = t - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}
