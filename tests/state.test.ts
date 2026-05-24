import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  state,
  registerSession,
  unregisterSession,
  getSession,
  trackCost,
  trackExecution,
  trackError,
  trackMessage,
  stateSnapshot,
  type SessionEntry
} from '../src/core/state';
import { sessionId } from '../src/types';

function makeEntry(id: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: sessionId(id),
    channelId: 'ch1',
    userId: 'u1',
    status: 'idle',
    createdAt: Date.now(),
    lastActivity: Date.now(),
    claudeSessionId: null,
    ...overrides
  };
}

describe('state — session registry', () => {
  beforeEach(() => {
    // Clean up sessions between tests
    for (const key of [...state.sessions.keys()]) {
      state.sessions.delete(key);
    }
    for (const key of [...state.sessionCosts.keys()]) {
      state.sessionCosts.delete(key);
    }
  });

  test('registerSession adds to sessions map', () => {
    const entry = makeEntry('s1');
    registerSession(entry);
    assert.strictEqual(state.sessions.size, 1);
    assert.strictEqual(state.sessions.get(sessionId('s1')), entry);
  });

  test('getSession returns registered session', () => {
    const entry = makeEntry('s2');
    registerSession(entry);
    assert.deepStrictEqual(getSession(sessionId('s2')), entry);
  });

  test('getSession returns undefined for unknown id', () => {
    assert.strictEqual(getSession(sessionId('nonexistent')), undefined);
  });

  test('unregisterSession removes session and its costs', () => {
    const sid = sessionId('s3');
    registerSession(makeEntry('s3'));
    trackCost(sid, 0.5);
    assert.strictEqual(state.sessionCosts.has(sid), true);

    const removed = unregisterSession(sid);
    assert.strictEqual(removed, true);
    assert.strictEqual(state.sessions.has(sid), false);
    assert.strictEqual(state.sessionCosts.has(sid), false);
  });

  test('unregisterSession returns false for unknown id', () => {
    assert.strictEqual(unregisterSession(sessionId('nope')), false);
  });
});

describe('state — cost tracking', () => {
  const sid = sessionId('cost-test');

  beforeEach(() => {
    state.totalCostUsd = 0;
    state.sessionCosts.clear();
  });

  test('trackCost accumulates total cost', () => {
    trackCost(sid, 0.01);
    trackCost(sid, 0.02);
    assert.ok(Math.abs(state.totalCostUsd - 0.03) < 1e-10);
  });

  test('trackCost accumulates per-session cost', () => {
    trackCost(sid, 0.1);
    trackCost(sid, 0.2);
    const sessionCost = state.sessionCosts.get(sid);
    assert.ok(sessionCost !== undefined);
    assert.ok(Math.abs(sessionCost - 0.3) < 1e-10);
  });

  test('trackCost handles multiple sessions independently', () => {
    const sid2 = sessionId('cost-test-2');
    trackCost(sid, 1.0);
    trackCost(sid2, 2.0);
    assert.ok(Math.abs(state.sessionCosts.get(sid)! - 1.0) < 1e-10);
    assert.ok(Math.abs(state.sessionCosts.get(sid2)! - 2.0) < 1e-10);
  });
});

describe('state — execution tracking', () => {
  beforeEach(() => {
    state.activeExecutorCount = 0;
    state.totalExecutions = 0;
  });

  test('trackExecution(true) increments active and total', () => {
    trackExecution(true);
    assert.strictEqual(state.activeExecutorCount, 1);
    assert.strictEqual(state.totalExecutions, 1);
  });

  test('trackExecution(false) decrements active count', () => {
    trackExecution(true);
    trackExecution(true);
    trackExecution(false);
    assert.strictEqual(state.activeExecutorCount, 1);
    assert.strictEqual(state.totalExecutions, 2);
  });

  test('trackExecution(false) does not go below zero', () => {
    trackExecution(false);
    assert.strictEqual(state.activeExecutorCount, 0);
  });
});

describe('state — message and error tracking', () => {
  test('trackMessage increments totalMessages', () => {
    const before = state.totalMessages;
    trackMessage();
    assert.strictEqual(state.totalMessages, before + 1);
  });

  test('trackError increments totalErrors', () => {
    const before = state.totalErrors;
    trackError();
    assert.strictEqual(state.totalErrors, before + 1);
  });
});

describe('stateSnapshot', () => {
  test('returns expected keys', () => {
    const snap = stateSnapshot();
    const keys = Object.keys(snap);
    assert.ok(keys.includes('uptimeMs'));
    assert.ok(keys.includes('pid'));
    assert.ok(keys.includes('sessions'));
    assert.ok(keys.includes('activeExecutors'));
    assert.ok(keys.includes('totalExecutions'));
    assert.ok(keys.includes('totalCostUsd'));
    assert.ok(keys.includes('totalMessages'));
    assert.ok(keys.includes('totalErrors'));
    assert.ok(keys.includes('isShuttingDown'));
  });

  test('uptimeMs is positive', () => {
    const snap = stateSnapshot();
    assert.ok((snap.uptimeMs as number) >= 0);
  });
});
