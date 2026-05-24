import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadBoot, formatBootForSystemPrompt } from '../src/session/boot';

describe('loadBoot', () => {
  let tmpRoot: string;
  const savedEnv = process.env.BOOT_MD_PATH;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'manamir-boot-'));
    delete process.env.BOOT_MD_PATH;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.BOOT_MD_PATH;
    else process.env.BOOT_MD_PATH = savedEnv;
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('returns content when BOOT.md exists', () => {
    const content = '# Boot\nDo this thing first.\n';
    writeFileSync(join(tmpRoot, 'BOOT.md'), content, 'utf8');
    const result = loadBoot({ projectRoot: tmpRoot });
    assert.strictEqual(result, content);
  });

  test('returns null when BOOT.md is missing', () => {
    const result = loadBoot({ projectRoot: tmpRoot });
    assert.strictEqual(result, null);
  });

  test('returns null when file exceeds maxSizeBytes', () => {
    const big = 'x'.repeat(50);
    writeFileSync(join(tmpRoot, 'BOOT.md'), big, 'utf8');
    const result = loadBoot({ projectRoot: tmpRoot, maxSizeBytes: 10 });
    assert.strictEqual(result, null);
  });

  test('respects BOOT_MD_PATH env override (absolute)', () => {
    const subdir = join(tmpRoot, 'sub');
    mkdirSync(subdir);
    const customPath = join(subdir, 'CUSTOM.md');
    writeFileSync(customPath, 'override content', 'utf8');
    process.env.BOOT_MD_PATH = customPath;
    const result = loadBoot({ projectRoot: tmpRoot });
    assert.strictEqual(result, 'override content');
  });

  test('does not walk parent directories', () => {
    // Place BOOT.md in parent, ask loadBoot to look at child — should miss.
    writeFileSync(join(tmpRoot, 'BOOT.md'), 'parent content', 'utf8');
    const child = join(tmpRoot, 'child');
    mkdirSync(child);
    const result = loadBoot({ projectRoot: child });
    assert.strictEqual(result, null);
  });
});

describe('formatBootForSystemPrompt', () => {
  test('wraps content with boot-instructions XML tag', () => {
    const out = formatBootForSystemPrompt('hello world');
    assert.match(out, /^<boot-instructions source="BOOT\.md">/);
    assert.match(out, /hello world/);
    assert.match(out, /<\/boot-instructions>$/);
  });

  test('preserves multi-line content verbatim', () => {
    const content = 'line1\nline2\nline3';
    const out = formatBootForSystemPrompt(content);
    assert.ok(out.includes(content));
  });
});
