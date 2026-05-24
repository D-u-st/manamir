// Discovery tests — verify the 4-tier auto-discovery (project > user > legacy > bundled),
// priority resolution when same skill name appears in multiple sources, and tier-1 catalog cap.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  discoverSkills,
  findSkillByName,
  setDiscoveryRoots,
  resetDiscoveryRoots,
  getDiscoveryLocations,
} from '../src/skills/discovery';
import { invalidateCached } from '../src/skills/cache';
import {
  renderSkillCatalog,
  catalogByteSize,
  listSkillsTier1,
} from '../src/skills/registry';

let workDir: string;

function writeSkill(
  root: string,
  name: string,
  description: string,
  body = '# body\n',
  extra: Record<string, string | number> = {}
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const fmLines = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${typeof v === 'number' ? v : v}`),
    '---',
    '',
    body,
  ];
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, fmLines.join('\n'));
  return file;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sw-discovery-'));
  invalidateCached();
});

afterEach(() => {
  resetDiscoveryRoots();
  invalidateCached();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe('discovery', () => {
  test('returns no locations when no dirs exist', () => {
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: join(workDir, 'no-bundled'),
    });
    const skills = discoverSkills();
    assert.deepStrictEqual(skills, []);
  });

  test('finds project-local skills', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeSkill(projDir, 'deploy', 'Deploy the app');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const skills = discoverSkills();
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].name, 'deploy');
    assert.strictEqual(skills[0].source, 'project');
  });

  test('finds user-global skills', () => {
    const userDir = join(workDir, 'user');
    mkdirSync(userDir, { recursive: true });
    writeSkill(userDir, 'restart-bot', 'Restart the bot');
    setDiscoveryRoots({
      projectRoot: join(workDir, 'no-proj'),
      userSkillsDir: userDir,
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const skills = discoverSkills();
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].name, 'restart-bot');
    assert.strictEqual(skills[0].source, 'user');
  });

  test('finds legacy skills (~/.manamir/skills)', () => {
    const legacyDir = join(workDir, 'legacy');
    mkdirSync(legacyDir, { recursive: true });
    writeSkill(legacyDir, 'old-thing', 'Legacy skill');
    setDiscoveryRoots({
      projectRoot: join(workDir, 'no-proj'),
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: legacyDir,
      bundledSkillsDir: null,
    });
    const skills = discoverSkills();
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].source, 'legacy');
  });

  test('finds bundled skills', () => {
    const bundDir = join(workDir, 'bundled');
    mkdirSync(bundDir, { recursive: true });
    writeSkill(bundDir, 'builtin-skill', 'Built-in');
    setDiscoveryRoots({
      projectRoot: join(workDir, 'no-proj'),
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: bundDir,
    });
    const skills = discoverSkills();
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].source, 'bundled');
  });

  test('priority: project > user > legacy > bundled (same name)', () => {
    const projDir = join(workDir, '.claude', 'skills');
    const userDir = join(workDir, 'user');
    const legDir = join(workDir, 'legacy');
    const bundDir = join(workDir, 'bundled');
    [projDir, userDir, legDir, bundDir].forEach((d) => mkdirSync(d, { recursive: true }));
    writeSkill(projDir, 'shared', 'project version');
    writeSkill(userDir, 'shared', 'user version');
    writeSkill(legDir, 'shared', 'legacy version');
    writeSkill(bundDir, 'shared', 'bundled version');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: userDir,
      legacySkillsDir: legDir,
      bundledSkillsDir: bundDir,
    });
    const skills = discoverSkills();
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].source, 'project');
    assert.strictEqual(skills[0].description, 'project version');
  });

  test('priority: user wins over legacy and bundled when no project', () => {
    const userDir = join(workDir, 'user');
    const legDir = join(workDir, 'legacy');
    const bundDir = join(workDir, 'bundled');
    [userDir, legDir, bundDir].forEach((d) => mkdirSync(d, { recursive: true }));
    writeSkill(userDir, 'shared', 'user version');
    writeSkill(legDir, 'shared', 'legacy version');
    writeSkill(bundDir, 'shared', 'bundled version');
    setDiscoveryRoots({
      projectRoot: join(workDir, 'no-proj'),
      userSkillsDir: userDir,
      legacySkillsDir: legDir,
      bundledSkillsDir: bundDir,
    });
    const skills = discoverSkills();
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].source, 'user');
  });

  test('priority: legacy wins over bundled when no project/user', () => {
    const legDir = join(workDir, 'legacy');
    const bundDir = join(workDir, 'bundled');
    [legDir, bundDir].forEach((d) => mkdirSync(d, { recursive: true }));
    writeSkill(legDir, 'shared', 'legacy version');
    writeSkill(bundDir, 'shared', 'bundled version');
    setDiscoveryRoots({
      projectRoot: join(workDir, 'no-proj'),
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: legDir,
      bundledSkillsDir: bundDir,
    });
    const skills = discoverSkills();
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].source, 'legacy');
  });

  test('different names from different sources all surface', () => {
    const projDir = join(workDir, '.claude', 'skills');
    const userDir = join(workDir, 'user');
    const bundDir = join(workDir, 'bundled');
    [projDir, userDir, bundDir].forEach((d) => mkdirSync(d, { recursive: true }));
    writeSkill(projDir, 'a', 'project');
    writeSkill(userDir, 'b', 'user');
    writeSkill(bundDir, 'c', 'bundled');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: userDir,
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: bundDir,
    });
    const skills = discoverSkills();
    assert.strictEqual(skills.length, 3);
    const sources = skills.map((s) => s.source).sort();
    assert.deepStrictEqual(sources, ['bundled', 'project', 'user']);
  });

  test('findSkillByName respects priority', () => {
    const projDir = join(workDir, '.claude', 'skills');
    const userDir = join(workDir, 'user');
    [projDir, userDir].forEach((d) => mkdirSync(d, { recursive: true }));
    writeSkill(projDir, 'shared', 'proj');
    writeSkill(userDir, 'shared', 'user');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: userDir,
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const found = findSkillByName('shared');
    assert.notStrictEqual(found, null);
    assert.strictEqual(found?.source, 'project');
    assert.strictEqual(found?.frontmatter.description, 'proj');
  });

  test('findSkillByName returns null for unknown', () => {
    setDiscoveryRoots({
      projectRoot: join(workDir, 'no-proj'),
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    assert.strictEqual(findSkillByName('nope'), null);
  });

  test('walks nested directories for SKILL.md', () => {
    const projDir = join(workDir, '.claude', 'skills');
    const sub = join(projDir, 'category-a', 'nested');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'SKILL.md'), '---\nname: nested\ndescription: deep\n---\nbody');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const skills = discoverSkills();
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].name, 'nested');
  });

  test('skips non-SKILL.md files', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'README.md'), '# not a skill');
    writeFileSync(join(projDir, 'SKILL.txt'), 'wrong ext');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    assert.deepStrictEqual(discoverSkills(), []);
  });

  test('includeBundled=false excludes bundled skills', () => {
    const userDir = join(workDir, 'user');
    const bundDir = join(workDir, 'bundled');
    [userDir, bundDir].forEach((d) => mkdirSync(d, { recursive: true }));
    writeSkill(userDir, 'a', 'user');
    writeSkill(bundDir, 'b', 'bundled');
    setDiscoveryRoots({
      projectRoot: join(workDir, 'no-proj'),
      userSkillsDir: userDir,
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: bundDir,
    });
    const skills = discoverSkills({ includeBundled: false });
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].source, 'user');
  });

  test('discovery locations include bundled when set', () => {
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: workDir,
      legacySkillsDir: workDir,
      bundledSkillsDir: workDir,
    });
    const locs = getDiscoveryLocations();
    const sources = locs.map((l) => l.source).sort();
    assert.deepStrictEqual(sources, ['bundled', 'legacy', 'project', 'user']);
  });
});

describe('catalog rendering', () => {
  beforeEach(() => {
    invalidateCached();
  });

  test('empty when no skills', () => {
    setDiscoveryRoots({
      projectRoot: join(workDir, 'no-proj'),
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    assert.strictEqual(renderSkillCatalog(), '');
  });

  test('renders a basic catalog', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeSkill(projDir, 'deploy-app', 'Deploy manamir to production');
    writeSkill(projDir, 'restart-bot', 'Restart the bot in tmux');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const cat = renderSkillCatalog();
    assert.match(cat, /Available Skills/);
    assert.match(cat, /- deploy-app: Deploy/);
    assert.match(cat, /- restart-bot: Restart/);
  });

  test('respects 5KB cap', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    // Create 200 skills with ~80-char descriptions → ~16KB unrendered
    const longDesc = 'A long description that is intended to exceed the cap, '.repeat(2);
    for (let i = 0; i < 200; i++) {
      writeSkill(projDir, `skill-${i.toString().padStart(3, '0')}`, longDesc);
    }
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const size = catalogByteSize();
    // Allow a small footer overhang (the truncation footer + final footer)
    assert.ok(size < 6 * 1024, `catalog size ${size} should be under ~6KB`);
    const cat = renderSkillCatalog();
    assert.match(cat, /truncated/);
  });

  test('sorts by last_used_at desc then name', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    // Use deterministic ISO timestamps
    writeSkill(projDir, 'old', 'old skill', '# body', { last_used_at: '2020-01-01T00:00:00Z' });
    writeSkill(projDir, 'recent', 'recent', '# body', { last_used_at: '2025-01-01T00:00:00Z' });
    writeSkill(projDir, 'never', 'never used');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const cat = renderSkillCatalog({ group: false });
    const lines = cat.split('\n').filter((l) => l.startsWith('- '));
    assert.ok(lines[0].includes('recent'), `expected recent first, got: ${lines[0]}`);
  });

  test('category filter works', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeSkill(projDir, 'a', 'apple', '# body', { category: 'fruits' });
    writeSkill(projDir, 'b', 'broccoli', '# body', { category: 'vegetables' });
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const cat = renderSkillCatalog({ category: 'fruit' });
    assert.match(cat, /apple/);
    assert.doesNotMatch(cat, /broccoli/);
  });

  test('groups by category', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeSkill(projDir, 'a', 'a-desc', '# body', { category: 'foo' });
    writeSkill(projDir, 'b', 'b-desc', '# body', { category: 'bar' });
    writeSkill(projDir, 'c', 'c-desc');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const cat = renderSkillCatalog({ group: true });
    assert.match(cat, /## bar/);
    assert.match(cat, /## foo/);
  });

  test('listSkillsTier1 returns DiscoveredSkill summaries', () => {
    const projDir = join(workDir, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeSkill(projDir, 'x', 'x desc');
    setDiscoveryRoots({
      projectRoot: workDir,
      userSkillsDir: join(workDir, 'no-user'),
      legacySkillsDir: join(workDir, 'no-legacy'),
      bundledSkillsDir: null,
    });
    const list = listSkillsTier1();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'x');
    assert.strictEqual(list[0].source, 'project');
  });
});
