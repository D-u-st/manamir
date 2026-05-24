// Tests for session browse + resume:
//   - HistoryStore.getSessionPreview() summarizes a JSONL session.
//   - SessionManager.adoptSession() reassigns a saved session id to a channel.
//   - getSession() returns the adopted session afterwards.
//
// We construct minimal config + a fake history JSONL by hand. SessionManager's
// adoptSession path hits the API backend buildBackend(), so we configure
// EXECUTOR_TYPE=api with a dummy key — no network calls are made because we
// never actually call sendMessage().

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { HistoryStore } from '../src/session/history';
import { SessionManager } from '../src/session/manager';
import { sessionId, messageId } from '../src/types';
import type { ChatMessage } from '../src/types';
import type { ManamirConfig } from '../src/config';

function makeConfig(dataDir: string, memoryDir: string, logDir: string): ManamirConfig {
  return {
    discord: { token: 'x', clientId: 'x', allowedUserIds: [] },
    executor: {
      type: 'api',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid',
      model: 'test-model',
      maxTokens: 4096,
      temperature: 0.7,
    },
    prompt: { trackSummary: true, maxSummaryEntries: 20 },
    claude: { cliPath: 'claude', maxTurnDurationMs: 60_000, maxTurns: 10 },
    session: { dataDir, idleTimeoutMs: 3_600_000, maxHistoryMessages: 200 },
    rotation: { enabled: false, maxTurns: 30, maxMinutes: 20 },
    memory: { dataDir: memoryDir, maxMemoriesInPrompt: 5 },
    autonomous: { enabled: false, maxConcurrentTasks: 1, pauseBetweenTasksMs: 5000, workingDirectory: '/tmp' },
    agents: { maxConcurrent: 3, defaultRoles: ['researcher'], maxTurnsPerAgent: 10 },
    speculation: { overlayDir: join(dataDir, 'speculation'), autoCleanupMs: 3_600_000 },
    cron: {
      enabled: false,
      sessionCleanupIntervalMs: 600_000,
      memoryPruneIntervalMs: 3_600_000,
      dailyLogDistillIntervalMs: 3_600_000,
    },
    permissions: { userPermissions: {}, defaultLevel: 'user' },
    logging: { level: 'error', dir: logDir },
  };
}

function writeFakeSession(dataDir: string, sid: string, messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>): void {
  const lines: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const msg: ChatMessage = {
      id: messageId(`msg_${i}`),
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      sessionId: sessionId(sid),
    };
    lines.push(JSON.stringify(msg));
  }
  writeFileSync(join(dataDir, `${sid}.jsonl`), lines.join('\n') + '\n', 'utf-8');
}

describe('session-resume — HistoryStore.getSessionPreview', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sess-preview-'));
  });

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns correct summary for an existing session', () => {
    const sid = 'sw_test_preview';
    writeFakeSession(tmpDir, sid, [
      { role: 'user', content: 'first user message', timestamp: 1000 },
      { role: 'assistant', content: 'first assistant reply', timestamp: 2000 },
      { role: 'user', content: 'second user message', timestamp: 3000 },
      { role: 'assistant', content: 'second assistant reply', timestamp: 4000 },
    ]);

    const store = new HistoryStore(tmpDir);
    const preview = store.getSessionPreview(sessionId(sid));

    assert.strictEqual(preview.messageCount, 4);
    assert.strictEqual(preview.firstMessage, 1000);
    assert.strictEqual(preview.lastActivity, 4000);
    assert.strictEqual(preview.firstUser, 'first user message');
    assert.strictEqual(preview.firstAssistant, 'first assistant reply');
  });

  test('returns zeroed preview for unknown session id', () => {
    const store = new HistoryStore(tmpDir);
    const preview = store.getSessionPreview(sessionId('does_not_exist'));
    assert.strictEqual(preview.messageCount, 0);
    assert.strictEqual(preview.firstMessage, 0);
    assert.strictEqual(preview.firstUser, '');
    assert.strictEqual(preview.firstAssistant, '');
  });
});

describe('session-resume — SessionManager.adoptSession', () => {
  let rootDir: string;
  let dataDir: string;
  let memoryDir: string;
  let logDir: string;
  let manager: SessionManager;

  before(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'sess-adopt-'));
    dataDir = join(rootDir, 'sessions');
    memoryDir = join(rootDir, 'memory');
    logDir = join(rootDir, 'logs');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    // Pre-seed a saved session JSONL.
    writeFakeSession(dataDir, 'sw_adopt_target', [
      { role: 'user', content: 'remember this please', timestamp: 1000 },
      { role: 'assistant', content: 'noted, I will remember', timestamp: 2000 },
      { role: 'user', content: 'and this too', timestamp: 3000 },
    ]);

    manager = new SessionManager(makeConfig(dataDir, memoryDir, logDir));
    manager.start();
  });

  after(() => {
    manager.stop();
    if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true });
  });

  test('successfully reassigns saved session id to a new channel', () => {
    const adopted = manager.adoptSession('cli-local', 'cli-user', 'sw_adopt_target');
    assert.notStrictEqual(adopted, null, 'adoptSession should return a Session');
    assert.strictEqual(String(adopted!.id), 'sw_adopt_target');
    assert.strictEqual(adopted!.channelId, 'cli-local');
    assert.strictEqual(adopted!.userId, 'cli-user');

    const history = adopted!.getHistory();
    assert.strictEqual(history.length, 3);
    assert.strictEqual(history[0].content, 'remember this please');
  });

  test('after adoption, getSession returns the adopted session', () => {
    const got = manager.getSession('cli-local');
    assert.notStrictEqual(got, undefined);
    assert.strictEqual(String(got!.id), 'sw_adopt_target');
  });

  test('adoptSession returns null when the session id has no history', () => {
    const result = manager.adoptSession('cli-local', 'cli-user', 'sw_does_not_exist');
    assert.strictEqual(result, null);
  });
});
