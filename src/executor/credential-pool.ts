// CredentialPool — manages multiple API keys for a single provider with
// round-robin rotation on rate-limit / billing / auth failures.
//
// Distinct from FailoverExecutor (which juggles different providers): this
// only swaps the credential triple (apiKey/baseUrl/model) inside ONE provider
// when one key is rate-limited, billed-out, or revoked.
//
// Lifecycle:
//   rate_limit → cool current credential for 60s, rotate to next active
//   billing    → disable current credential for this session, rotate
//   auth       → disable current credential for this session, rotate
//   on success → clear cooling for the just-used credential
//
// Returns null from rotateOnFailure() once no credentials remain active.

import { log } from '../utils/logger';

export interface Credential {
  apiKey: string;
  baseUrl: string;
  model: string;
  label?: string;  // for logging
}

export type RotateReason = 'rate_limit' | 'billing' | 'auth';

export type CredentialStatus = 'active' | 'cooling' | 'disabled';

interface CredentialState {
  credential: Credential;
  status: CredentialStatus;
  coolDownUntil?: number;  // epoch ms, only set when status === 'cooling'
}

const RATE_LIMIT_COOLDOWN_MS = 60_000;

export class CredentialPool {
  private states: CredentialState[];
  private currentIndex: number;

  constructor(credentials: Credential[]) {
    if (!credentials || credentials.length === 0) {
      throw new Error('CredentialPool: at least one credential is required');
    }
    this.states = credentials.map((c, i) => ({
      credential: { ...c, label: c.label ?? `cred-${i}` },
      status: 'active'
    }));
    this.currentIndex = 0;
  }

  /** Return the currently selected credential. Auto-recovers expired cooldowns. */
  current(): Credential {
    this.refreshCoolingStates();
    const cur = this.states[this.currentIndex];
    if (cur.status === 'active') {
      return cur.credential;
    }
    // Current is no longer usable; pick any active one.
    const next = this.findNextActive(this.currentIndex);
    if (next === -1) {
      // Nothing active — return current credential anyway (caller should have
      // checked health() / rotateOnFailure() return). This keeps current()
      // total without throwing in read-paths.
      return cur.credential;
    }
    this.currentIndex = next;
    return this.states[next].credential;
  }

  /**
   * Rotate based on a failure reason. Updates current credential's status,
   * advances currentIndex to the next active credential, and returns the new
   * credential. Returns null if no active credentials remain.
   */
  rotateOnFailure(reason: RotateReason): Credential | null {
    this.refreshCoolingStates();
    const cur = this.states[this.currentIndex];

    if (reason === 'rate_limit') {
      cur.status = 'cooling';
      cur.coolDownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      log.warn('CredentialPool: credential cooling on rate_limit', {
        label: cur.credential.label,
        coolDownMs: RATE_LIMIT_COOLDOWN_MS
      });
    } else {
      // billing or auth → disable for this session
      cur.status = 'disabled';
      cur.coolDownUntil = undefined;
      log.warn('CredentialPool: credential disabled', {
        label: cur.credential.label,
        reason
      });
    }

    const next = this.findNextActive(this.currentIndex);
    if (next === -1) {
      log.error('CredentialPool: all credentials exhausted');
      return null;
    }
    this.currentIndex = next;
    return this.states[next].credential;
  }

  /**
   * Reset rotation/cooling state for the current credential after a successful
   * call. Disabled credentials stay disabled; only cooling states clear.
   */
  reset(): void {
    const cur = this.states[this.currentIndex];
    if (cur.status === 'cooling') {
      cur.status = 'active';
      cur.coolDownUntil = undefined;
    }
  }

  /** Diagnostic snapshot for /status etc. */
  health(): Array<{ label: string; status: CredentialStatus; coolDownUntil?: number }> {
    this.refreshCoolingStates();
    return this.states.map(s => ({
      label: s.credential.label ?? '',
      status: s.status,
      coolDownUntil: s.coolDownUntil
    }));
  }

  /** Number of credentials in any active state (active or cooling-but-expired). */
  get activeCount(): number {
    this.refreshCoolingStates();
    return this.states.filter(s => s.status === 'active').length;
  }

  /** Total credentials in the pool, regardless of status. */
  get size(): number {
    return this.states.length;
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Promote any cooling credential whose cooldown has elapsed back to active. */
  private refreshCoolingStates(): void {
    const now = Date.now();
    for (const s of this.states) {
      if (s.status === 'cooling' && s.coolDownUntil !== undefined && s.coolDownUntil <= now) {
        s.status = 'active';
        s.coolDownUntil = undefined;
      }
    }
  }

  /**
   * Round-robin search for the next 'active' credential starting AFTER
   * fromIndex. Returns -1 if none found. Does NOT mutate state.
   */
  private findNextActive(fromIndex: number): number {
    const n = this.states.length;
    for (let step = 1; step <= n; step++) {
      const idx = (fromIndex + step) % n;
      if (this.states[idx].status === 'active') return idx;
    }
    return -1;
  }
}
