// PID lock file (P-14, hardened v2.6.0)
// Prevents multiple instances from running simultaneously.
// v2.6.0 hardening (pitfalls #64): mtime-fallback stale check + heartbeat.
//
// Why: process.kill(pid, 0) returns true when *some* process with that PID
// exists — but PIDs get recycled, so a long-dead manamir's PID may now
// belong to an unrelated process (sshd, init, etc.). When that happens,
// startup falsely sees the lock as live and refuses to start.
//
// Fix: in addition to PID check, also check the lockfile's mtime. If the
// file hasn't been touched in STALE_AFTER_MS, assume the holder died (a
// running manamir heartbeats every HEARTBEAT_MS).

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { log } from '../utils/logger';

const DEFAULT_LOCK_PATH = './data/manamir.lock';

const HEARTBEAT_MS = 30_000;        // touch lockfile mtime every 30s while alive
const STALE_AFTER_MS = 5 * 60_000;  // mtime older than 5min → stale even if PID alive

let activeLockPath: string | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = just check existence/permission
    return true;
  } catch {
    return false;
  }
}

function lockFileAgeMs(lockPath: string): number {
  try {
    const stat = statSync(lockPath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return Infinity;
  }
}

/**
 * Touch lockfile mtime. Called by heartbeat. Safe to call repeatedly.
 * Uses utimesSync (no content rewrite) so concurrent readers always see
 * a consistent PID line.
 */
function touchLock(lockPath: string): void {
  try {
    const now = new Date();
    utimesSync(lockPath, now, now);
  } catch (err) {
    // File may have been deleted (e.g. user `rm -f data/manamir.lock`).
    // Don't crash — next acquire would catch absence anyway.
    log.warn('Lock heartbeat: touch failed', {
      lockPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function startHeartbeat(lockPath: string): void {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => touchLock(lockPath), HEARTBEAT_MS);
  // Don't pin event loop — manamir should be free to exit cleanly.
  heartbeatInterval.unref?.();
}

function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export function acquireLock(lockPath: string = DEFAULT_LOCK_PATH): boolean {
  const dir = dirname(lockPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Check existing lock — both PID liveness AND mtime freshness.
  if (existsSync(lockPath)) {
    const content = readFileSync(lockPath, 'utf-8').trim();
    const existingPid = parseInt(content, 10);
    const ageMs = lockFileAgeMs(lockPath);

    const pidAlive = !isNaN(existingPid) && isProcessAlive(existingPid);
    const mtimeFresh = ageMs < STALE_AFTER_MS;

    // Both signals must agree: PID alive AND lock recently touched.
    // PID alive but mtime stale → previous holder died but PID got recycled
    // to an unrelated process; treat as stale.
    if (pidAlive && mtimeFresh) {
      log.error('Lock file exists and is fresh', {
        lockPath,
        existingPid,
        lockAgeMs: Math.round(ageMs),
      });
      return false;
    }

    // Stale lock — log the reason for diagnostics
    log.warn('Removing stale lock file', {
      lockPath,
      stalePid: existingPid,
      pidAlive,
      mtimeFresh,
      lockAgeMs: Math.round(ageMs),
      reason: !pidAlive ? 'pid-dead' : 'mtime-stale',
    });
    try {
      unlinkSync(lockPath);
    } catch (err) {
      log.warn('Failed to remove stale lock', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Write our PID
  writeFileSync(lockPath, String(process.pid), 'utf-8');
  activeLockPath = lockPath;
  startHeartbeat(lockPath);

  log.info('Lock acquired', { lockPath, pid: process.pid });
  return true;
}

export function releaseLock(): void {
  stopHeartbeat();
  if (!activeLockPath) return;

  try {
    if (existsSync(activeLockPath)) {
      unlinkSync(activeLockPath);
      log.info('Lock released', { lockPath: activeLockPath });
    }
  } catch (err) {
    log.error('Failed to release lock', { error: String(err) });
  }

  activeLockPath = null;
}

export function installLockCleanup(): void {
  const cleanup = () => {
    releaseLock();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Best-effort cleanup on unexpected exit
  process.on('exit', () => {
    releaseLock();
  });
}

export function isLockHeld(lockPath: string = DEFAULT_LOCK_PATH): boolean {
  if (!existsSync(lockPath)) return false;

  const content = readFileSync(lockPath, 'utf-8').trim();
  const pid = parseInt(content, 10);
  if (isNaN(pid) || !isProcessAlive(pid)) return false;

  // Also check mtime: PID alive but lock stale → not really held
  return lockFileAgeMs(lockPath) < STALE_AFTER_MS;
}

// Exported for tests.
export const _internals = {
  HEARTBEAT_MS,
  STALE_AFTER_MS,
  touchLock,
  isProcessAlive,
  lockFileAgeMs,
};
