// Hash protection tests — verify saveSkillProtected refuses to overwrite when the
// disk content_hash differs from md5(body), unless force=true. Also verify that
// fresh save stamps a content_hash.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  saveSkill,
  saveSkillProtected,
  bodyHash,
  setSkillsDir,
  getSkillsDir,
} from '../src/skills/store';
import { coerceFrontmatter, parseSkillMarkdown } from '../src/skills/frontmatter';
import type { Skill } from '../src/skills/types';

let prevSkillsDir: string;
let workDir: string;

beforeEach(() => {
  prevSkillsDir = getSkillsDir();
  workDir = mkdtempSync(join(tmpdir(), 'sw-hash-'));
  setSkillsDir(workDir);
});

afterEach(() => {
  setSkillsDir(prevSkillsDir);
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

function makeSkill(name: string, body: string): Skill {
  return {
    frontmatter: {
      name,
      description: `desc for ${name}`,
      createdAt: 0,
      updatedAt: 0,
    },
    body,
    directoryPath: join(workDir, name),
  };
}

describe('bodyHash', () => {
  test('produces md5: prefix', () => {
    const h = bodyHash('hello');
    assert.match(h, /^md5:[0-9a-f]{32}$/);
  });

  test('changes when content changes', () => {
    assert.notStrictEqual(bodyHash('a'), bodyHash('b'));
  });

  test('stable across calls', () => {
    assert.strictEqual(bodyHash('xyz'), bodyHash('xyz'));
  });
});

describe('saveSkill stamps content_hash', () => {
  test('writes content_hash and timestamps to frontmatter', async () => {
    const sk = makeSkill('hashed', 'body content here');
    await saveSkill(sk);
    const md = readFileSync(join(workDir, 'hashed', 'SKILL.md'), 'utf-8');
    const parsed = parseSkillMarkdown(md);
    assert.notStrictEqual(parsed, null);
    const fm = coerceFrontmatter(parsed!.data);
    assert.match(fm.content_hash ?? '', /^md5:[0-9a-f]{32}$/);
    assert.ok(fm.updated_at);
  });

  test('content_hash matches md5(body)', async () => {
    const body = 'specific body for hash check';
    const sk = makeSkill('h2', body);
    await saveSkill(sk);
    const md = readFileSync(join(workDir, 'h2', 'SKILL.md'), 'utf-8');
    const parsed = parseSkillMarkdown(md)!;
    const fm = coerceFrontmatter(parsed.data);
    assert.strictEqual(fm.content_hash, bodyHash(parsed.body));
  });
});

describe('saveSkillProtected', () => {
  test('first write succeeds (no existing file)', async () => {
    const sk = makeSkill('first', 'first body');
    const r = await saveSkillProtected(sk);
    assert.strictEqual(r.ok, true);
  });

  test('second write succeeds when no external edits', async () => {
    const sk = makeSkill('clean', 'v1 body');
    let r = await saveSkillProtected(sk);
    assert.strictEqual(r.ok, true);
    sk.body = 'v2 body';
    r = await saveSkillProtected(sk);
    assert.strictEqual(r.ok, true);
  });

  test('second write blocked when user edited the file', async () => {
    const sk = makeSkill('user-edit', 'agent v1');
    let r = await saveSkillProtected(sk);
    assert.strictEqual(r.ok, true);

    // Simulate user editing the file directly: mutate body, keep stale hash
    const mdPath = join(workDir, 'user-edit', 'SKILL.md');
    const original = readFileSync(mdPath, 'utf-8');
    const userEdited = original.replace('agent v1', 'user manually changed this');
    writeFileSync(mdPath, userEdited);

    sk.body = 'agent v2';
    r = await saveSkillProtected(sk);
    assert.strictEqual(r.ok, false, `should block; reason=${r.reason}`);
    assert.match(r.reason ?? '', /content_hash/);
    assert.ok(r.diff);
    assert.ok(r.conflictHash);
    assert.ok(r.expectedHash);
  });

  test('force=true overrides hash conflict', async () => {
    const sk = makeSkill('forced', 'agent v1');
    await saveSkillProtected(sk);

    const mdPath = join(workDir, 'forced', 'SKILL.md');
    const original = readFileSync(mdPath, 'utf-8');
    writeFileSync(mdPath, original.replace('agent v1', 'user changed'));

    sk.body = 'agent v2';
    const r = await saveSkillProtected(sk, { force: true });
    assert.strictEqual(r.ok, true);
    // Verify it was actually written
    const newMd = readFileSync(mdPath, 'utf-8');
    const parsed = parseSkillMarkdown(newMd)!;
    assert.match(parsed.body, /agent v2/);
  });

  test('returns diff snippet on conflict', async () => {
    const sk = makeSkill('diffy', 'line 1\nline 2\nline 3');
    await saveSkillProtected(sk);
    const mdPath = join(workDir, 'diffy', 'SKILL.md');
    const original = readFileSync(mdPath, 'utf-8');
    const userBody = 'line 1\nUSER EDIT\nline 3';
    writeFileSync(mdPath, original.replace(/line 1\nline 2\nline 3/, userBody));

    sk.body = 'line 1\nAGENT EDIT\nline 3';
    const r = await saveSkillProtected(sk);
    assert.strictEqual(r.ok, false);
    assert.match(r.diff ?? '', /first difference/i);
  });

  test('content_hash refreshed after successful overwrite', async () => {
    const sk = makeSkill('refresh', 'v1');
    await saveSkillProtected(sk);
    const mdPath = join(workDir, 'refresh', 'SKILL.md');
    const md1 = readFileSync(mdPath, 'utf-8');
    const fm1 = coerceFrontmatter(parseSkillMarkdown(md1)!.data);

    sk.body = 'v2 body content';
    await saveSkillProtected(sk);
    const md2 = readFileSync(mdPath, 'utf-8');
    const fm2 = coerceFrontmatter(parseSkillMarkdown(md2)!.data);

    assert.notStrictEqual(fm1.content_hash, fm2.content_hash);
    assert.strictEqual(fm2.content_hash, bodyHash('v2 body content'));
  });

  test('hash check ignores frontmatter changes (only body matters)', async () => {
    const sk = makeSkill('only-body', 'fixed body');
    await saveSkillProtected(sk);

    // User edits frontmatter (but not body) — hash should still match
    const mdPath = join(workDir, 'only-body', 'SKILL.md');
    const md = readFileSync(mdPath, 'utf-8');
    const muddled = md.replace('description: desc for only-body', 'description: tweaked');
    writeFileSync(mdPath, muddled);

    sk.body = 'fixed body'; // unchanged
    const r = await saveSkillProtected(sk);
    assert.strictEqual(r.ok, true, `unexpected block; reason=${r.reason}`);
  });

  test('writing to a file with no stored hash succeeds', async () => {
    // Place a SKILL.md without content_hash
    const dir = join(workDir, 'no-hash');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: no-hash\ndescription: legacy\n---\nlegacy body'
    );
    const sk = makeSkill('no-hash', 'new body');
    const r = await saveSkillProtected(sk);
    assert.strictEqual(r.ok, true, `should accept legacy file; reason=${r.reason}`);
  });
});
