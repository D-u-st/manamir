import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getProfileName,
  getProfileRoot,
  profilePath,
  resolveProfileScoped,
  resolveSkillsDir,
  resetProfileCache,
} from '../src/profile';

describe('profile/manager', () => {
  let tempRoot: string;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(k: string, v: string | undefined): void {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'sw-profile-'));
    setEnv('MANAMIR_PROFILES_ROOT', tempRoot);
    resetProfileCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    Object.keys(savedEnv).forEach(k => delete savedEnv[k]);
    resetProfileCache();
    if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  });

  test('default profile name when env unset', () => {
    setEnv('MANAMIR_PROFILE', undefined);
    assert.strictEqual(getProfileName(), 'default');
  });

  test('reads MANAMIR_PROFILE env', () => {
    setEnv('MANAMIR_PROFILE', 'work');
    assert.strictEqual(getProfileName(), 'work');
  });

  test('rejects invalid profile names', () => {
    setEnv('MANAMIR_PROFILE', 'bad/name');
    assert.throws(() => getProfileName(), /Invalid MANAMIR_PROFILE/);
  });

  test('rejects empty after trim', () => {
    setEnv('MANAMIR_PROFILE', '   ');
    assert.strictEqual(getProfileName(), 'default');
  });

  test('rejects too long names', () => {
    setEnv('MANAMIR_PROFILE', 'a'.repeat(50));
    assert.throws(() => getProfileName(), /Invalid MANAMIR_PROFILE/);
  });

  test('getProfileRoot creates directory', () => {
    setEnv('MANAMIR_PROFILE', 'alice');
    const root = getProfileRoot();
    assert.ok(existsSync(root));
    assert.ok(root.endsWith(join('alice')));
  });

  test('profilePath joins under profile root', () => {
    setEnv('MANAMIR_PROFILE', 'alice');
    const sessions = profilePath('sessions');
    assert.ok(sessions.includes('alice'));
    assert.ok(sessions.endsWith('sessions'));
  });

  test('resolveProfileScoped: env value wins', () => {
    setEnv('MANAMIR_PROFILE', 'alice');
    const result = resolveProfileScoped('/tmp/explicit-override', 'sessions');
    assert.ok(result.endsWith('explicit-override'));
  });

  test('resolveProfileScoped: empty env falls back to profile-scoped', () => {
    setEnv('MANAMIR_PROFILE', 'alice');
    const result = resolveProfileScoped('', 'sessions');
    assert.ok(result.includes('alice'));
    assert.ok(result.endsWith('sessions'));
  });

  test('resolveProfileScoped: undefined env falls back to profile-scoped', () => {
    setEnv('MANAMIR_PROFILE', 'bob');
    const result = resolveProfileScoped(undefined, 'memory');
    assert.ok(result.includes('bob'));
    assert.ok(result.endsWith('memory'));
  });

  test('resolveSkillsDir: SKILLS_DIR env wins', () => {
    setEnv('MANAMIR_PROFILE', 'alice');
    setEnv('SKILLS_DIR', '/tmp/explicit-skills');
    const result = resolveSkillsDir();
    assert.ok(result.endsWith('explicit-skills'));
  });

  test('resolveSkillsDir: non-default profile scopes under profile', () => {
    setEnv('MANAMIR_PROFILE', 'alice');
    setEnv('SKILLS_DIR', undefined);
    const result = resolveSkillsDir();
    assert.ok(result.includes('alice'));
    assert.ok(result.endsWith('skills'));
  });

  test('resolveSkillsDir: default profile uses ~/.manamir/skills (legacy)', () => {
    setEnv('MANAMIR_PROFILE', undefined);
    setEnv('SKILLS_DIR', undefined);
    const result = resolveSkillsDir();
    // legacy global location
    assert.ok(result.includes('.manamir'));
    assert.ok(result.endsWith('skills'));
  });

  test('two profiles produce isolated paths', () => {
    setEnv('MANAMIR_PROFILE', 'alice');
    const aliceRoot = getProfileRoot();
    resetProfileCache();
    setEnv('MANAMIR_PROFILE', 'bob');
    const bobRoot = getProfileRoot();
    assert.notStrictEqual(aliceRoot, bobRoot);
    assert.ok(aliceRoot.includes('alice'));
    assert.ok(bobRoot.includes('bob'));
  });
});
