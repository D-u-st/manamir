import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ErrorMonitor } from '../src/monitoring/error-monitor';
import { hooks } from '../src/hooks';

describe('ErrorMonitor', () => {
  let tempDir: string;
  let logPath: string;
  let monitor: ErrorMonitor;
  const alertEvents: Array<Record<string, unknown>> = [];
  let alertHandler: (e: string, data: Record<string, unknown>) => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sw-monitor-'));
    logPath = join(tempDir, 'errors.jsonl');
    alertEvents.length = 0;
    alertHandler = (_e, data) => {
      alertEvents.push(data);
    };
    hooks.on('error_monitor_alert', alertHandler);
  });

  afterEach(async () => {
    if (monitor) {
      monitor.stopAutoFlush();
      await monitor.flush().catch(() => {});
    }
    hooks.off('error_monitor_alert', alertHandler);
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test('records a single warning', () => {
    monitor = new ErrorMonitor({ logPath });
    monitor.record({ code: 'discord_disconnect', message: 'WebSocket closed' });
    const recent = monitor.getRecent();
    assert.strictEqual(recent.length, 1);
    assert.strictEqual(recent[0].code, 'discord_disconnect');
    assert.strictEqual(recent[0].severity, 'warning');
  });

  test('critical event emits alert immediately', async () => {
    monitor = new ErrorMonitor({ logPath });
    monitor.record({
      code: 'api_quota_exhausted',
      severity: 'critical',
      message: 'Out of credits',
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(alertEvents.length, 1);
    assert.strictEqual(alertEvents[0].code, 'api_quota_exhausted');
    assert.strictEqual(alertEvents[0].reason, 'critical_event');
  });

  test('escalation after threshold occurrences', async () => {
    monitor = new ErrorMonitor({
      logPath,
      escalationThreshold: 3,
      escalationWindowMs: 60_000,
    });
    monitor.record({ code: 'tool_timeout', message: 'tool 1' });
    monitor.record({ code: 'tool_timeout', message: 'tool 2' });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(alertEvents.length, 0, 'not yet escalated at 2');
    monitor.record({ code: 'tool_timeout', message: 'tool 3' });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(alertEvents.length, 1, 'escalated at 3');
    assert.strictEqual(alertEvents[0].reason, 'escalated');
  });

  test('escalation only fires once per window', async () => {
    monitor = new ErrorMonitor({
      logPath,
      escalationThreshold: 2,
      escalationWindowMs: 60_000,
    });
    monitor.record({ code: 'flap', message: 'a' });
    monitor.record({ code: 'flap', message: 'b' });
    monitor.record({ code: 'flap', message: 'c' });
    monitor.record({ code: 'flap', message: 'd' });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(alertEvents.length, 1, 'only one alert');
  });

  test('different codes tracked independently', async () => {
    monitor = new ErrorMonitor({
      logPath,
      escalationThreshold: 2,
    });
    monitor.record({ code: 'a', message: '1' });
    monitor.record({ code: 'b', message: '1' });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(alertEvents.length, 0);
    monitor.record({ code: 'a', message: '2' });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(alertEvents.length, 1, 'only "a" escalated');
  });

  test('reportException records as critical', async () => {
    monitor = new ErrorMonitor({ logPath });
    const err = new Error('boom');
    monitor.reportException(err, 'unhandled_throw', { where: 'main' });
    await new Promise((r) => setImmediate(r));
    const recent = monitor.getRecent();
    assert.strictEqual(recent[0].severity, 'critical');
    assert.strictEqual(recent[0].code, 'unhandled_throw');
    assert.ok(recent[0].stack);
    assert.strictEqual(alertEvents.length, 1);
  });

  test('summary returns correct breakdown', () => {
    monitor = new ErrorMonitor({ logPath });
    monitor.record({ code: 'a', severity: 'warning', message: '1' });
    monitor.record({ code: 'a', severity: 'warning', message: '2' });
    monitor.record({ code: 'b', severity: 'critical', message: '3' });
    const s = monitor.summary();
    assert.strictEqual(s.totalRecorded, 3);
    assert.strictEqual(s.bySeverity.warning, 2);
    assert.strictEqual(s.bySeverity.critical, 1);
    assert.strictEqual(s.topCodes[0].code, 'a');
    assert.strictEqual(s.topCodes[0].count, 2);
    assert.ok(s.lastError);
    assert.strictEqual(s.lastError!.code, 'b');
  });

  test('flush persists to disk', async () => {
    monitor = new ErrorMonitor({ logPath });
    monitor.record({ code: 'persist', message: 'test' });
    await monitor.flush();
    assert.ok(existsSync(logPath));
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.code, 'persist');
  });

  test('maxRecentRecords caps in-memory buffer', () => {
    monitor = new ErrorMonitor({ logPath, maxRecentRecords: 5 });
    for (let i = 0; i < 10; i++) {
      monitor.record({ code: `c${i}`, message: `${i}` });
    }
    const recent = monitor.getRecent();
    assert.strictEqual(recent.length, 5);
    // newest first; expect c9, c8, c7, c6, c5
    assert.strictEqual(recent[0].code, 'c9');
    assert.strictEqual(recent[4].code, 'c5');
  });

  test('alert event payload includes code + reason', async () => {
    monitor = new ErrorMonitor({ logPath });
    monitor.record({ code: 'X', severity: 'critical', message: 'm' });
    await new Promise((r) => setImmediate(r));
    const ev = alertEvents[0];
    assert.strictEqual(ev.code, 'X');
    assert.ok(['critical_event', 'escalated'].includes(ev.reason as string));
  });
});
