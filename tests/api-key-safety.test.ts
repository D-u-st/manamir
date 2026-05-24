import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scanApiKeySafety } from '../src/security/api-key-safety';

describe('scanApiKeySafety', () => {
  let tempDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(k: string, v: string | undefined): void {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sw-keysafety-'));
    setEnv('API_KEY', undefined);
    setEnv('DISCORD_TOKEN', undefined);
    setEnv('AUTONOMOUS_ENABLED', undefined);
    setEnv('ALLOWED_USER_IDS', undefined);
    setEnv('MANAMIR_POLICY_RELAXED', undefined);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    Object.keys(savedEnv).forEach((k) => delete savedEnv[k]);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test('passes with no env set', () => {
    const report = scanApiKeySafety({ projectRoot: tempDir });
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.findings.length, 0);
  });

  test('detects placeholder API_KEY', () => {
    setEnv('API_KEY', 'your-key-here');
    const report = scanApiKeySafety({ projectRoot: tempDir });
    assert.strictEqual(report.passed, false);
    const placeholder = report.findings.find((f) => f.code === 'placeholder_key');
    assert.ok(placeholder);
    assert.strictEqual(placeholder!.severity, 'critical');
  });

  test('warns on unknown key format', () => {
    setEnv('API_KEY', 'random-but-long-string-not-matching-known-formats-aaaaaa');
    const report = scanApiKeySafety({ projectRoot: tempDir });
    const unknown = report.findings.find((f) => f.code === 'unknown_key_format');
    assert.ok(unknown);
    assert.strictEqual(unknown!.severity, 'warn');
  });

  test('accepts valid DeepSeek key format', () => {
    setEnv('API_KEY', 'sk-ddeadbeefcafebabe1234567890abe2b');
    const report = scanApiKeySafety({ projectRoot: tempDir });
    const unknown = report.findings.find((f) => f.code === 'unknown_key_format');
    assert.strictEqual(unknown, undefined);
  });

  test('warns on short Discord token', () => {
    setEnv('DISCORD_TOKEN', 'too-short');
    const report = scanApiKeySafety({ projectRoot: tempDir });
    const dt = report.findings.find((f) => f.code === 'discord_token_format');
    assert.ok(dt);
  });

  test('flags .env not in .gitignore when .git exists', () => {
    mkdirSync(join(tempDir, '.git'));
    writeFileSync(join(tempDir, '.env'), 'API_KEY=sk-test123');
    // No .gitignore at all
    const report = scanApiKeySafety({ projectRoot: tempDir });
    const f = report.findings.find((f) => f.code === 'env_not_gitignored');
    assert.ok(f);
    assert.strictEqual(f!.severity, 'critical');
  });

  test('passes when .env IS in .gitignore', () => {
    mkdirSync(join(tempDir, '.git'));
    writeFileSync(join(tempDir, '.env'), 'API_KEY=sk-ddeadbeefcafebabe1234567890abe2b');
    writeFileSync(join(tempDir, '.gitignore'), 'node_modules/\n.env\n.env.local\n');
    const report = scanApiKeySafety({ projectRoot: tempDir });
    const f = report.findings.find((f) => f.code === 'env_not_gitignored');
    assert.strictEqual(f, undefined);
  });

  test('warns on autonomous + no allowlist', () => {
    setEnv('AUTONOMOUS_ENABLED', 'true');
    setEnv('ALLOWED_USER_IDS', '');
    const report = scanApiKeySafety({ projectRoot: tempDir });
    const f = report.findings.find((f) => f.code === 'autonomous_no_allowlist');
    assert.ok(f);
  });

  test('critical: relaxed + multiple users', () => {
    setEnv('MANAMIR_POLICY_RELAXED', 'true');
    setEnv('ALLOWED_USER_IDS', 'user1,user2,user3');
    const report = scanApiKeySafety({ projectRoot: tempDir });
    assert.strictEqual(report.passed, false);
    const f = report.findings.find((f) => f.code === 'relaxed_with_multiple_users');
    assert.ok(f);
    assert.strictEqual(f!.severity, 'critical');
  });

  test('relaxed + single user is OK', () => {
    setEnv('MANAMIR_POLICY_RELAXED', 'true');
    setEnv('ALLOWED_USER_IDS', 'just-me');
    const report = scanApiKeySafety({ projectRoot: tempDir });
    const f = report.findings.find((f) => f.code === 'relaxed_with_multiple_users');
    assert.strictEqual(f, undefined);
  });

  test('detects multiple keys in one .env line', () => {
    writeFileSync(
      join(tempDir, '.env'),
      'API_KEY=sk-ddeadbeefcafebabe1234567890abe2b sk-anotherkey1234567890123456789012'
    );
    const report = scanApiKeySafety({
      projectRoot: tempDir,
      envFilePath: join(tempDir, '.env'),
    });
    const f = report.findings.find((f) => f.code === 'multiple_keys_one_line');
    assert.ok(f);
  });
});
