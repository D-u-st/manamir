// Tier tests — verify the 3-tier loading semantics:
//   tier 1: name + description (catalog)
//   tier 2: frontmatter + first 1000 chars + file list
//   tier 3: full body + supporting files

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  setDiscoveryRoots,
  resetDiscoveryRoots,
} from '../src/skills/discovery';
import {
  listSkillsTier1,
  viewSkillTier2,
  viewSkillTier3,
  readSkillFile,
} from '../src/skills/registry';
import { invalidateCached } from '../src/skills/cache';
import { TIER2_PREVIEW_CHARS } from '../src/skills/types';

let workDir: string;

function writeSkill(
  dir: string,
  name: string,
  description: string,
  body: string
): string {
  const sd = join(dir, name);
  mkdirSync(sd, { recursive: true });
  const md = `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
  writeFileSync(join(sd, 'SKILL.md'), md);
  return sd;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sw-tiers-'));
  invalidateCached();
});

afterEach(() => {
  resetDiscoveryRoots();
  invalidateCached();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe('tier 1', () => {
  test('listSkillsTier1 returns name + description only (no body)', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    const longBody = 'x'.repeat(50_000);
    writeSkill(projDir, 'big-skill', 'Big skill', longBody);
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const list = listSkillsTier1();
    assert.strictEqual(list.length, 1);
    const summary = list[0];
    // Summary should not contain body
    const json = JSON.stringify(summary);
    assert.ok(!json.includes('xxxxxxx'), 'tier-1 summary leaked body');
  });

  test('multiple skills sorted by name', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeSkill(projDir, 'zeta', 'z', '# z');
    writeSkill(projDir, 'alpha', 'a', '# a');
    writeSkill(projDir, 'mike', 'm', '# m');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const list = listSkillsTier1();
    assert.deepStrictEqual(list.map((s) => s.name), ['alpha', 'mike', 'zeta']);
  });
});

describe('tier 2', () => {
  test('returns first 1000 chars of body', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    const longBody = '# Header\n' + 'x'.repeat(5000);
    writeSkill(projDir, 'big', 'big skill', longBody);
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const view = viewSkillTier2('big');
    assert.notStrictEqual(view, null);
    assert.strictEqual(view!.preview.length, TIER2_PREVIEW_CHARS);
    assert.strictEqual(view!.truncated, true);
    assert.match(view!.preview, /^# Header/);
  });

  test('returns full body when shorter than preview limit', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeSkill(projDir, 'small', 'small', 'short body');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const view = viewSkillTier2('small');
    assert.notStrictEqual(view, null);
    assert.strictEqual(view!.truncated, false);
    assert.match(view!.preview, /short body/);
  });

  test('lists supporting files', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    const sd = writeSkill(projDir, 'with-files', 'has files', '# body');
    mkdirSync(join(sd, 'references'), { recursive: true });
    writeFileSync(join(sd, 'references', 'guide.md'), '# Guide');
    mkdirSync(join(sd, 'templates'), { recursive: true });
    writeFileSync(join(sd, 'templates', 'tpl.txt'), 'tpl');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const view = viewSkillTier2('with-files');
    assert.notStrictEqual(view, null);
    assert.deepStrictEqual(
      view!.files.sort(),
      ['references/guide.md', 'templates/tpl.txt']
    );
  });

  test('returns null for unknown skill', () => {
    setDiscoveryRoots({
      projectRoot: join(workDir, 'no-proj'),
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    assert.strictEqual(viewSkillTier2('nope'), null);
  });

  test('exposes frontmatter and source', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeSkill(projDir, 'foo', 'foo desc', '# body');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const view = viewSkillTier2('foo');
    assert.strictEqual(view?.source, 'project');
    assert.strictEqual(view?.frontmatter.name, 'foo');
  });
});

describe('tier 3', () => {
  test('returns full body', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    const longBody = '# Header\n' + 'x'.repeat(5000);
    writeSkill(projDir, 'big', 'big', longBody);
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const view = viewSkillTier3('big');
    assert.notStrictEqual(view, null);
    assert.strictEqual(view!.body.length, longBody.length);
    assert.match(view!.body, /^# Header/);
  });

  test('returns full files', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    const sd = writeSkill(projDir, 'wf', 'wf', '# body');
    mkdirSync(join(sd, 'scripts'), { recursive: true });
    writeFileSync(join(sd, 'scripts', 'run.sh'), '#!/bin/sh');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const view = viewSkillTier3('wf');
    assert.notStrictEqual(view, null);
    assert.deepStrictEqual(view!.files, ['scripts/run.sh']);
  });

  test('returns null for missing skill', () => {
    setDiscoveryRoots({
      projectRoot: join(workDir, 'no-proj'),
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    assert.strictEqual(viewSkillTier3('absent'), null);
  });
});

describe('readSkillFile (path-traversal protection)', () => {
  function setupSkill() {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    const sd = writeSkill(projDir, 'pt', 'pt', '# body');
    mkdirSync(join(sd, 'references'), { recursive: true });
    writeFileSync(join(sd, 'references', 'note.md'), 'note content');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    return sd;
  }

  test('reads valid supporting file', () => {
    setupSkill();
    const r = readSkillFile('pt', 'references/note.md');
    assert.strictEqual(r.error, undefined);
    assert.strictEqual(r.content, 'note content');
  });

  test('rejects ../ traversal', () => {
    setupSkill();
    const r = readSkillFile('pt', '../../../etc/passwd');
    assert.ok(r.error, 'should reject');
  });

  test('rejects absolute path', () => {
    setupSkill();
    const r = readSkillFile('pt', '/etc/passwd');
    assert.ok(r.error);
  });

  test('rejects Windows absolute path', () => {
    setupSkill();
    const r = readSkillFile('pt', 'C:/Windows/system32/config');
    assert.ok(r.error);
  });

  test('rejects unauthorized subdir', () => {
    setupSkill();
    const r = readSkillFile('pt', 'evil/foo.md');
    assert.ok(r.error);
    assert.match(r.error!, /references|templates|scripts|assets/);
  });

  test('rejects empty path', () => {
    setupSkill();
    const r = readSkillFile('pt', '');
    assert.ok(r.error);
  });

  test('errors when skill missing', () => {
    setDiscoveryRoots({
      projectRoot: join(workDir, 'no-proj'),
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const r = readSkillFile('nope', 'references/x.md');
    assert.match(r.error!, /not found/);
  });

  test('errors when file missing', () => {
    setupSkill();
    const r = readSkillFile('pt', 'references/missing.md');
    assert.ok(r.error);
  });
});
