import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { loadConfig, validateConfig } from '../src/config';

describe('loadConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    Object.keys(savedEnv).forEach(k => delete savedEnv[k]);
  });

  test('returns defaults when no env vars set', () => {
    const config = loadConfig();
    assert.strictEqual(config.executor.type, 'api');
    assert.strictEqual(config.executor.maxTokens, 4096);
    assert.strictEqual(config.executor.temperature, 0.7);
    assert.strictEqual(config.claude.maxTurns, 50);
    assert.strictEqual(config.rotation.enabled, true);
    assert.strictEqual(config.rotation.maxTurns, 30);
    assert.strictEqual(config.autonomous.enabled, true);
    assert.strictEqual(config.autonomous.maxTasksPerHour, 30);
    assert.strictEqual(config.autonomous.requireGate, true);
    assert.strictEqual(config.cron.enabled, true);
    assert.strictEqual(config.logging.level, 'info');
    assert.strictEqual(config.prompt.trackSummary, true);
    assert.strictEqual(config.prompt.maxSummaryEntries, 20);
  });

  test('reads DISCORD_TOKEN and DISCORD_CLIENT_ID', () => {
    setEnv({ DISCORD_TOKEN: 'tok123', DISCORD_CLIENT_ID: 'cid456' });
    const config = loadConfig();
    assert.strictEqual(config.discord.token, 'tok123');
    assert.strictEqual(config.discord.clientId, 'cid456');
  });

  test('parses ALLOWED_USER_IDS as comma-separated list', () => {
    setEnv({ ALLOWED_USER_IDS: 'a, b , c' });
    const config = loadConfig();
    assert.deepStrictEqual(config.discord.allowedUserIds, ['a', 'b', 'c']);
  });

  test('parses empty ALLOWED_USER_IDS as empty array', () => {
    setEnv({ ALLOWED_USER_IDS: '' });
    const config = loadConfig();
    assert.deepStrictEqual(config.discord.allowedUserIds, []);
  });

  test('parses PROVIDERS as JSON array', () => {
    const providers = [{ name: 'p1', apiKey: 'k1', baseUrl: 'http://x' }];
    setEnv({ PROVIDERS: JSON.stringify(providers) });
    const config = loadConfig();
    assert.deepStrictEqual(config.executor.providers, providers);
  });

  test('ignores malformed PROVIDERS JSON', () => {
    setEnv({ PROVIDERS: 'not-json' });
    const config = loadConfig();
    assert.strictEqual(config.executor.providers, undefined);
  });

  test('parses USER_PERMISSIONS', () => {
    setEnv({ USER_PERMISSIONS: 'u1:admin,u2:readonly,u3:user' });
    const config = loadConfig();
    assert.deepStrictEqual(config.permissions.userPermissions, {
      u1: 'admin',
      u2: 'readonly',
      u3: 'user'
    });
  });

  test('ignores invalid permission levels in USER_PERMISSIONS', () => {
    setEnv({ USER_PERMISSIONS: 'u1:superadmin,u2:admin' });
    const config = loadConfig();
    assert.deepStrictEqual(config.permissions.userPermissions, { u2: 'admin' });
  });

  test('EXECUTOR_TYPE override', () => {
    setEnv({ EXECUTOR_TYPE: 'auth' });
    const config = loadConfig();
    assert.strictEqual(config.executor.type, 'auth');
  });

  test('AUTONOMOUS_ENABLED=true enables autonomous', () => {
    setEnv({ AUTONOMOUS_ENABLED: 'true' });
    const config = loadConfig();
    assert.strictEqual(config.autonomous.enabled, true);
  });

  test('AUTONOMOUS_ENABLED=false explicitly disables autonomous', () => {
    setEnv({ AUTONOMOUS_ENABLED: 'false' });
    const config = loadConfig();
    assert.strictEqual(config.autonomous.enabled, false);
  });

  test('AUTONOMOUS_MAX_TASKS_PER_HOUR override', () => {
    setEnv({ AUTONOMOUS_MAX_TASKS_PER_HOUR: '7' });
    const config = loadConfig();
    assert.strictEqual(config.autonomous.maxTasksPerHour, 7);
  });

  test('AUTONOMOUS_REQUIRE_GATE=false disables gate-chain', () => {
    setEnv({ AUTONOMOUS_REQUIRE_GATE: 'false' });
    const config = loadConfig();
    assert.strictEqual(config.autonomous.requireGate, false);
  });

  test('ROTATION_ENABLED=false disables rotation', () => {
    setEnv({ ROTATION_ENABLED: 'false' });
    const config = loadConfig();
    assert.strictEqual(config.rotation.enabled, false);
  });

  test('PROMPT_TRACK_SUMMARY=false disables tracking', () => {
    setEnv({ PROMPT_TRACK_SUMMARY: 'false' });
    const config = loadConfig();
    assert.strictEqual(config.prompt.trackSummary, false);
  });
});

describe('validateConfig', () => {
  test('returns errors for missing discord token and clientId', () => {
    const config = loadConfig();
    // Default config has empty token/clientId
    const errors = validateConfig(config);
    assert.ok(errors.some(e => e.includes('DISCORD_TOKEN')));
    assert.ok(errors.some(e => e.includes('DISCORD_CLIENT_ID')));
  });

  test('returns API_KEY error for api executor without providers', () => {
    const config = loadConfig();
    config.discord.token = 'tok';
    config.discord.clientId = 'cid';
    config.executor.type = 'api';
    config.executor.apiKey = '';
    config.executor.providers = undefined;
    const errors = validateConfig(config);
    assert.ok(errors.some(e => e.includes('API_KEY')));
  });

  test('no API_KEY error when providers are set', () => {
    const config = loadConfig();
    config.discord.token = 'tok';
    config.discord.clientId = 'cid';
    config.executor.type = 'api';
    config.executor.apiKey = '';
    config.executor.providers = [{ name: 'p', apiKey: 'k', baseUrl: 'http://x' } as any];
    const errors = validateConfig(config);
    assert.ok(!errors.some(e => e.includes('API_KEY')));
  });

  test('no API_KEY error for auth executor', () => {
    const config = loadConfig();
    config.discord.token = 'tok';
    config.discord.clientId = 'cid';
    config.executor.type = 'auth';
    config.executor.apiKey = '';
    const errors = validateConfig(config);
    assert.strictEqual(errors.length, 0);
  });

  test('returns empty array when all required fields present', () => {
    const config = loadConfig();
    config.discord.token = 'tok';
    config.discord.clientId = 'cid';
    config.executor.type = 'api';
    config.executor.apiKey = 'key';
    config.executor.baseUrl = 'http://api';
    const errors = validateConfig(config);
    assert.strictEqual(errors.length, 0);
  });
});
