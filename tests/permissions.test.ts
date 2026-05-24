import { describe, test } from 'node:test';
import assert from 'node:assert';
import { PermissionManager } from '../src/security/permissions';

function createManager(
  users: Record<string, 'admin' | 'user' | 'readonly'> = {},
  defaultLevel: 'admin' | 'user' | 'readonly' = 'user'
) {
  return new PermissionManager({
    userPermissions: users,
    defaultLevel
  });
}

describe('PermissionManager — getLevel', () => {
  test('returns assigned level for known user', () => {
    const pm = createManager({ alice: 'admin', bob: 'readonly' });
    assert.strictEqual(pm.getLevel('alice'), 'admin');
    assert.strictEqual(pm.getLevel('bob'), 'readonly');
  });

  test('returns default level for unknown user', () => {
    const pm = createManager({}, 'readonly');
    assert.strictEqual(pm.getLevel('stranger'), 'readonly');
  });
});

describe('PermissionManager — setLevel', () => {
  test('sets level for a user', () => {
    const pm = createManager();
    pm.setLevel('carol', 'admin');
    assert.strictEqual(pm.getLevel('carol'), 'admin');
  });

  test('overrides existing level', () => {
    const pm = createManager({ dave: 'user' });
    pm.setLevel('dave', 'admin');
    assert.strictEqual(pm.getLevel('dave'), 'admin');
  });
});

describe('PermissionManager — check', () => {
  const pm = createManager({ admin1: 'admin', user1: 'user', ro1: 'readonly' });

  test('admin can do everything', () => {
    assert.strictEqual(pm.check('admin1', 'chat'), true);
    assert.strictEqual(pm.check('admin1', 'use_tools'), true);
    assert.strictEqual(pm.check('admin1', 'manage_tasks'), true);
    assert.strictEqual(pm.check('admin1', 'auto_start'), true);
    assert.strictEqual(pm.check('admin1', 'auto_stop'), true);
    assert.strictEqual(pm.check('admin1', 'cron_manage'), true);
    assert.strictEqual(pm.check('admin1', 'view_status'), true);
    assert.strictEqual(pm.check('admin1', 'manage_permissions'), true);
  });

  test('user can chat, use tools, manage tasks, view status', () => {
    assert.strictEqual(pm.check('user1', 'chat'), true);
    assert.strictEqual(pm.check('user1', 'use_tools'), true);
    assert.strictEqual(pm.check('user1', 'manage_tasks'), true);
    assert.strictEqual(pm.check('user1', 'view_status'), true);
  });

  test('user cannot do admin-only actions', () => {
    assert.strictEqual(pm.check('user1', 'auto_start'), false);
    assert.strictEqual(pm.check('user1', 'auto_stop'), false);
    assert.strictEqual(pm.check('user1', 'cron_manage'), false);
    assert.strictEqual(pm.check('user1', 'manage_permissions'), false);
  });

  test('readonly can only view status', () => {
    assert.strictEqual(pm.check('ro1', 'view_status'), true);
    assert.strictEqual(pm.check('ro1', 'chat'), false);
    assert.strictEqual(pm.check('ro1', 'use_tools'), false);
    assert.strictEqual(pm.check('ro1', 'manage_tasks'), false);
    assert.strictEqual(pm.check('ro1', 'auto_start'), false);
  });
});

describe('PermissionManager — guard', () => {
  const pm = createManager({ admin1: 'admin', ro1: 'readonly' });

  test('returns null when action is allowed', () => {
    assert.strictEqual(pm.guard('admin1', 'chat'), null);
  });

  test('returns denial message when action is denied', () => {
    const msg = pm.guard('ro1', 'chat');
    assert.ok(msg !== null);
    assert.ok(msg!.includes('Permission denied'));
    assert.ok(msg!.includes('readonly'));
    assert.ok(msg!.includes('chat'));
  });
});

describe('PermissionManager — listUsers', () => {
  test('lists all configured users', () => {
    const pm = createManager({ a: 'admin', b: 'user' });
    const list = pm.listUsers();
    assert.strictEqual(list.length, 2);
    assert.ok(list.some(u => u.userId === 'a' && u.level === 'admin'));
    assert.ok(list.some(u => u.userId === 'b' && u.level === 'user'));
  });

  test('returns empty array when no users configured', () => {
    const pm = createManager();
    assert.deepStrictEqual(pm.listUsers(), []);
  });

  test('includes dynamically added users', () => {
    const pm = createManager();
    pm.setLevel('new', 'readonly');
    const list = pm.listUsers();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].userId, 'new');
  });
});
