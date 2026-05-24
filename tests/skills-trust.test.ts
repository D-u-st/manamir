// Trust matrix tests — verify per-tool permission resolution based on trust,
// created_by, allowed_tools, and forbidden_tools.

import { describe, test } from 'node:test';
import assert from 'node:assert';

import {
  checkToolPermission,
  defaultTrustForSource,
  resolveCreatedBy,
  resolveTrust,
  requiresStrictScan,
} from '../src/skills/trust';
import type { SkillFrontmatter } from '../src/skills/types';

function fm(overrides: Partial<SkillFrontmatter>): SkillFrontmatter {
  return {
    name: 'test',
    description: 'test',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('defaultTrustForSource', () => {
  test('bundled -> system', () => {
    assert.strictEqual(defaultTrustForSource('bundled'), 'system');
  });
  test('project -> user', () => {
    assert.strictEqual(defaultTrustForSource('project'), 'user');
  });
  test('user -> user', () => {
    assert.strictEqual(defaultTrustForSource('user'), 'user');
  });
  test('legacy -> user', () => {
    assert.strictEqual(defaultTrustForSource('legacy'), 'user');
  });
});

describe('resolveTrust', () => {
  test('frontmatter trust wins', () => {
    assert.strictEqual(resolveTrust(fm({ trust: 'agent' }), 'project'), 'agent');
  });
  test('falls back to source default', () => {
    assert.strictEqual(resolveTrust(fm({}), 'bundled'), 'system');
    assert.strictEqual(resolveTrust(fm({}), 'project'), 'user');
  });
});

describe('resolveCreatedBy', () => {
  test('frontmatter created_by wins', () => {
    assert.strictEqual(resolveCreatedBy(fm({ created_by: 'agent' }), 'bundled'), 'agent');
  });
  test('bundled defaults to system when not set', () => {
    assert.strictEqual(resolveCreatedBy(fm({}), 'bundled'), 'system');
  });
  test('non-bundled defaults to user when not set', () => {
    assert.strictEqual(resolveCreatedBy(fm({}), 'project'), 'user');
    assert.strictEqual(resolveCreatedBy(fm({}), 'user'), 'user');
  });
});

describe('checkToolPermission: agent trust', () => {
  test('agent + bash = blocked by default', () => {
    const p = checkToolPermission(fm({}), 'user', 'bash');
    // user source defaults to user trust → not agent path
    assert.strictEqual(p.allowed, true);
    // explicitly mark as agent created
    const p2 = checkToolPermission(fm({ created_by: 'agent', trust: 'agent' }), 'user', 'bash');
    assert.strictEqual(p2.allowed, false);
    assert.match(p2.reason, /agent/);
  });

  test('agent + bash explicitly opted in via allowed_tools = allowed', () => {
    const p = checkToolPermission(
      fm({ trust: 'agent', created_by: 'agent', allowed_tools: ['bash', 'read'] }),
      'user',
      'bash'
    );
    assert.strictEqual(p.allowed, true);
  });

  test('agent + read (read-only) = allowed', () => {
    const p = checkToolPermission(
      fm({ trust: 'agent', created_by: 'agent' }),
      'user',
      'read'
    );
    assert.strictEqual(p.allowed, true);
  });

  test('agent + write = blocked', () => {
    const p = checkToolPermission(
      fm({ trust: 'agent', created_by: 'agent' }),
      'user',
      'write'
    );
    assert.strictEqual(p.allowed, false);
  });
});

describe('checkToolPermission: user trust', () => {
  test('user + bash = allowed', () => {
    const p = checkToolPermission(fm({}), 'project', 'bash');
    assert.strictEqual(p.allowed, true);
  });

  test('user + write = allowed', () => {
    const p = checkToolPermission(fm({}), 'project', 'write');
    assert.strictEqual(p.allowed, true);
  });

  test('user + forbidden_tools blocks', () => {
    const p = checkToolPermission(
      fm({ forbidden_tools: ['bash'] }),
      'project',
      'bash'
    );
    assert.strictEqual(p.allowed, false);
    assert.match(p.reason, /forbidden/);
  });
});

describe('checkToolPermission: system trust', () => {
  test('system + bash = allowed', () => {
    const p = checkToolPermission(fm({}), 'bundled', 'bash');
    assert.strictEqual(p.allowed, true);
  });

  test('system + write = allowed', () => {
    const p = checkToolPermission(fm({}), 'bundled', 'write');
    assert.strictEqual(p.allowed, true);
  });

  test('system can still be restricted via allowed_tools', () => {
    const p = checkToolPermission(fm({ allowed_tools: ['read'] }), 'bundled', 'bash');
    assert.strictEqual(p.allowed, false);
  });
});

describe('checkToolPermission: allowed_tools whitelist', () => {
  test('whitelist mode: only listed tools allowed', () => {
    const f = fm({ allowed_tools: ['read', 'glob'] });
    assert.strictEqual(checkToolPermission(f, 'project', 'read').allowed, true);
    assert.strictEqual(checkToolPermission(f, 'project', 'bash').allowed, false);
  });

  test('forbidden takes precedence over allowed', () => {
    const f = fm({ allowed_tools: ['bash'], forbidden_tools: ['bash'] });
    const p = checkToolPermission(f, 'project', 'bash');
    assert.strictEqual(p.allowed, false);
  });
});

describe('requiresStrictScan', () => {
  test('agent created_by requires strict scan', () => {
    assert.strictEqual(requiresStrictScan(fm({ created_by: 'agent' }), 'project'), true);
  });
  test('user created_by does not require strict scan', () => {
    assert.strictEqual(requiresStrictScan(fm({ created_by: 'user' }), 'project'), false);
  });
  test('system created_by does not require strict scan', () => {
    assert.strictEqual(requiresStrictScan(fm({}), 'bundled'), false);
  });
});

describe('end-to-end tool permission scenarios', () => {
  test('agent skill from project source: bash blocked, read allowed', () => {
    const f = fm({ created_by: 'agent', trust: 'agent' });
    assert.strictEqual(checkToolPermission(f, 'project', 'bash').allowed, false);
    assert.strictEqual(checkToolPermission(f, 'project', 'read').allowed, true);
  });

  test('user skill from project source: all allowed', () => {
    const f = fm({});
    assert.strictEqual(checkToolPermission(f, 'project', 'bash').allowed, true);
    assert.strictEqual(checkToolPermission(f, 'project', 'write').allowed, true);
  });

  test('bundled skill: all allowed unless explicit allowed_tools', () => {
    const f = fm({});
    assert.strictEqual(checkToolPermission(f, 'bundled', 'bash').allowed, true);
  });

  test('agent override: user explicitly granted bash via allowed_tools', () => {
    const f = fm({
      trust: 'agent',
      created_by: 'agent',
      allowed_tools: ['bash'],
    });
    assert.strictEqual(checkToolPermission(f, 'project', 'bash').allowed, true);
  });
});
