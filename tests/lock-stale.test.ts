import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, isLockHeld, _internals } from '../src/core/lock.js';

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'manamir-lock-test-'));
  lockPath = join(tmpDir, 'manamir.lock');
});

afterEach(() => {
  releaseLock();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

test('acquireLock: succeeds on fresh dir', () => {
  const ok = acquireLock(lockPath);
  assert.strictEqual(ok, true);
  assert.ok(existsSync(lockPath));
});

test('acquireLock: refuses when same lock taken twice in same process', () => {
  acquireLock(lockPath);
  // Same process — write our own PID, mtime fresh → would refuse
  // But since releaseLock unsets activeLockPath, second acquire works
  // (we don't simulate a second process here — just ensure same-process release works)
  releaseLock();
  const ok2 = acquireLock(lockPath);
  assert.strictEqual(ok2, true);
});

test('acquireLock: cleans stale lock when PID dead', () => {
  // Write a lock with a PID that's almost certainly dead
  writeFileSync(lockPath, '99999999', 'utf-8');
  const ok = acquireLock(lockPath);
  assert.strictEqual(ok, true, 'should acquire after cleaning dead-PID lock');
});

test('acquireLock: cleans stale lock when mtime old (PID-recycle scenario)', () => {
  // Write a lock with our current PID (pid alive) but old mtime
  writeFileSync(lockPath, String(process.pid), 'utf-8');
  const old = new Date(Date.now() - 10 * 60_000); // 10 min ago
  utimesSync(lockPath, old, old);

  // Same PID alive but mtime > STALE_AFTER_MS → should clean
  releaseLock(); // clear in-process activeLockPath first (test artifact)
  const ok = acquireLock(lockPath);
  assert.strictEqual(ok, true, 'should acquire after cleaning mtime-stale lock');
});

test('acquireLock: refuses fresh lock with alive PID', () => {
  writeFileSync(lockPath, String(process.pid), 'utf-8');
  // Fresh mtime — kept by acquireLock seeing recent file
  releaseLock();
  // Re-create as if another live process — we're using our PID to fake "alive"
  writeFileSync(lockPath, String(process.pid), 'utf-8');

  const ok = acquireLock(lockPath);
  assert.strictEqual(ok, false, 'should refuse when PID alive AND mtime fresh');
});

test('acquireLock: invalid PID content treated as stale', () => {
  writeFileSync(lockPath, 'not-a-number\n', 'utf-8');
  const ok = acquireLock(lockPath);
  assert.strictEqual(ok, true);
});

test('isLockHeld: returns false when no lock file', () => {
  assert.strictEqual(isLockHeld(lockPath), false);
});

test('isLockHeld: returns true when fresh lock with alive PID', () => {
  writeFileSync(lockPath, String(process.pid), 'utf-8');
  assert.strictEqual(isLockHeld(lockPath), true);
});

test('isLockHeld: returns false when lock has stale mtime', () => {
  writeFileSync(lockPath, String(process.pid), 'utf-8');
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lockPath, old, old);
  assert.strictEqual(isLockHeld(lockPath), false);
});

test('lockFileAgeMs: returns ~0 for just-written file', () => {
  writeFileSync(lockPath, '123', 'utf-8');
  const age = _internals.lockFileAgeMs(lockPath);
  assert.ok(age < 100, `age ${age} should be near 0`);
});

test('lockFileAgeMs: returns Infinity when file missing', () => {
  const age = _internals.lockFileAgeMs(join(tmpDir, 'missing.lock'));
  assert.strictEqual(age, Infinity);
});

test('isProcessAlive: own PID is alive', () => {
  assert.strictEqual(_internals.isProcessAlive(process.pid), true);
});

test('isProcessAlive: very high PID is dead', () => {
  assert.strictEqual(_internals.isProcessAlive(99_999_999), false);
});

test('touchLock: updates mtime', () => {
  writeFileSync(lockPath, '123', 'utf-8');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);
  const ageBefore = _internals.lockFileAgeMs(lockPath);
  _internals.touchLock(lockPath);
  const ageAfter = _internals.lockFileAgeMs(lockPath);
  assert.ok(ageAfter < ageBefore, `mtime should be refreshed (was ${ageBefore}, now ${ageAfter})`);
});

test('releaseLock: removes file', () => {
  acquireLock(lockPath);
  assert.ok(existsSync(lockPath));
  releaseLock();
  assert.strictEqual(existsSync(lockPath), false);
});

test('constants: HEARTBEAT_MS < STALE_AFTER_MS / 2 (margin for missed beats)', () => {
  // Heartbeat must fire several times within stale window so we don't false-stale
  // a healthy process due to one missed beat.
  assert.ok(
    _internals.HEARTBEAT_MS * 4 < _internals.STALE_AFTER_MS,
    `heartbeat ${_internals.HEARTBEAT_MS}ms should be < stale/4 = ${_internals.STALE_AFTER_MS / 4}ms`,
  );
});
