// Tests for src/cli/init-wizard.ts
//
// Strategy: inject a fake WizardIO that scripts both ask() and write() so we
// can run the wizard end-to-end without touching real stdin/stdout.

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runInitWizard,
  validateApiKey,
  validateDiscordToken,
  validateDiscordClientId,
  validateProfileName,
  parseAllowedUserIds,
  maskSecret,
  PROVIDER_PRESETS,
  type WizardIO,
} from '../src/cli/init-wizard';

interface FakeIOResult {
  io: WizardIO;
  output: () => string;
  remainingInputs: () => string[];
}

function makeFakeIO(scriptedInputs: string[]): FakeIOResult {
  const inputs = [...scriptedInputs];
  const out: string[] = [];
  const io: WizardIO = {
    ask: async (prompt: string) => {
      out.push(prompt);
      if (inputs.length === 0) {
        throw new Error(`fake IO: ran out of scripted inputs at prompt: ${JSON.stringify(prompt)}`);
      }
      return inputs.shift() as string;
    },
    write: (text: string) => { out.push(text); },
    close: () => {},
  };
  return {
    io,
    output: () => out.join(''),
    remainingInputs: () => [...inputs],
  };
}

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'manamir-init-'));
}

describe('validators', () => {
  test('validateApiKey rejects empty + whitespace + too-short', () => {
    assert.equal(validateApiKey(''), 'API key cannot be empty');
    assert.equal(validateApiKey('   '), 'API key cannot be empty');
    assert.equal(validateApiKey('short'), 'API key looks too short (need at least 8 chars)');
    assert.equal(validateApiKey('has space inside'), 'API key cannot contain whitespace');
    assert.equal(validateApiKey('sk-12345678'), null);
  });

  test('validateDiscordToken rejects URLs and client_secret-shaped tokens', () => {
    assert.match(validateDiscordToken('https://discord.com/webhook') ?? '', /URL/);
    // No dots = not a bot token
    assert.match(validateDiscordToken('abc123def456ghi789jkl') ?? '', /client_secret/);
    // One dot = still not a bot token
    assert.match(validateDiscordToken('abc.def') ?? '', /client_secret/);
    // Empty
    assert.equal(validateDiscordToken(''), 'Discord token cannot be empty');
    // Real-shaped token
    assert.equal(
      validateDiscordToken('MTAwMDAwMDAwMDAwMDAwMDAwMA.GfAkeT.deadbeefcafebabe1234567890abcdef0123456'),
      null
    );
  });

  test('validateDiscordClientId requires 15-25 digits', () => {
    assert.equal(validateDiscordClientId(''), 'Discord client ID cannot be empty');
    assert.match(validateDiscordClientId('abc') ?? '', /15-25 digits/);
    assert.match(validateDiscordClientId('123') ?? '', /15-25 digits/);
    assert.equal(validateDiscordClientId('1481315001674240102'), null);
  });

  test('validateProfileName allows empty and standard names', () => {
    assert.equal(validateProfileName(''), null);
    assert.equal(validateProfileName('default'), null);
    assert.equal(validateProfileName('my-profile_2'), null);
    assert.match(validateProfileName('bad name!') ?? '', /1-40 chars/);
    assert.match(validateProfileName('a'.repeat(41)) ?? '', /1-40 chars/);
  });

  test('parseAllowedUserIds filters invalid entries', () => {
    const ids = parseAllowedUserIds('1481315001674240102, abc, 999, 1481315001674240103');
    assert.deepEqual(ids, ['1481315001674240102', '1481315001674240103']);
    assert.deepEqual(parseAllowedUserIds(''), []);
  });

  test('maskSecret masks long values, hides short ones entirely', () => {
    assert.equal(maskSecret(''), '(empty)');
    assert.equal(maskSecret('short'), '*****');
    assert.equal(maskSecret('sk-ddeadbeefcafebabe1234567890abe2b'), 'sk-d...e2b');
  });
});

describe('runInitWizard — flag-driven flows', () => {
  test('full flag-driven non-interactive: writes correct .env', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      const fake = makeFakeIO([]); // no prompts at all expected
      const result = await runInitWizard({
        configPath: envPath,
        flags: {
          provider: 'deepseek',
          apiKey: 'sk-ddeadbeefcafebabe1234567890abe2b',
          noDiscord: true,
          profileName: 'default',
          yes: true,
        },
        io: fake.io,
      });
      assert.equal(result.envPath, envPath);
      assert.equal(result.answers.provider, 'deepseek');
      assert.equal(result.answers.discordEnabled, false);
      assert.equal(result.answers.baseUrl, PROVIDER_PRESETS.deepseek.baseUrl);
      assert.equal(result.answers.model, PROVIDER_PRESETS.deepseek.defaultModel);

      const onDisk = await readFile(envPath, 'utf8');
      assert.match(onDisk, /API_KEY=sk-ddeadbeefcafebabe1234567890abe2b/);
      assert.match(onDisk, /API_BASE_URL=https:\/\/api\.deepseek\.com/);
      assert.match(onDisk, /API_MODEL=deepseek-chat/);
      // Discord lines should be commented out
      assert.match(onDisk, /# DISCORD_TOKEN=/);
      assert.equal(fake.remainingInputs().length, 0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite existing .env without --force', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      await writeFile(envPath, 'EXISTING=true\n');
      const fake = makeFakeIO([]);
      await assert.rejects(
        runInitWizard({
          configPath: envPath,
          flags: { provider: 'deepseek', apiKey: 'sk-12345678', noDiscord: true, yes: true },
          io: fake.io,
        }),
        /refusing to overwrite without --force/
      );
      // Output should suggest --force
      assert.match(fake.output(), /--force/);
      // Original file untouched
      const onDisk = await readFile(envPath, 'utf8');
      assert.equal(onDisk, 'EXISTING=true\n');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('--force allows overwrite', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      await writeFile(envPath, 'OLD=true\n');
      const fake = makeFakeIO([]);
      await runInitWizard({
        configPath: envPath,
        force: true,
        flags: { provider: 'deepseek', apiKey: 'sk-12345678', noDiscord: true, yes: true },
        io: fake.io,
      });
      const onDisk = await readFile(envPath, 'utf8');
      assert.doesNotMatch(onDisk, /OLD=true/);
      assert.match(onDisk, /API_KEY=sk-12345678/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('--no-discord skips all Discord prompts', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      // Only the provider step would consume an input if not flag-driven.
      // We feed nothing — if the wizard tries to prompt, it'll throw.
      const fake = makeFakeIO([]);
      const result = await runInitWizard({
        configPath: envPath,
        flags: {
          provider: 'openai',
          apiKey: 'sk-abcdefghij',
          noDiscord: true,
          profileName: 'work',
          yes: true,
        },
        io: fake.io,
      });
      assert.equal(result.answers.discordEnabled, false);
      assert.equal(result.answers.discordToken, '');
      assert.equal(result.answers.profileName, 'work');
      // Output should mention "disabled" for Discord
      assert.match(fake.output(), /Discord — disabled/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('dry-run does not write file but returns body', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      const fake = makeFakeIO([]);
      const result = await runInitWizard({
        configPath: envPath,
        dryRun: true,
        flags: {
          provider: 'deepseek',
          apiKey: 'sk-ddeadbeefcafebabe1234567890abe2b',
          noDiscord: true,
          yes: true,
        },
        io: fake.io,
      });
      // Body must contain the key
      assert.match(result.envBody, /API_KEY=sk-ddeadbeefcafebabe1234567890abe2b/);
      // But on disk: nothing
      await assert.rejects(readFile(envPath, 'utf8'));
      // And the secret must be masked in stdout (mask = first4 + ... + last3)
      assert.match(fake.output(), /sk-d\.\.\.e2b/);
      assert.doesNotMatch(fake.output(), /API key:.*sk-ddeadbeefcafebabe1234567890abe2b/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('flag --api-key with whitespace is rejected at parse time', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      const fake = makeFakeIO([]);
      await assert.rejects(
        runInitWizard({
          configPath: envPath,
          flags: { provider: 'deepseek', apiKey: 'has space here', noDiscord: true, yes: true },
          io: fake.io,
        }),
        /--api-key invalid/
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('flag --discord-token rejects URL-shaped tokens (no client_secret leak)', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      const fake = makeFakeIO([]);
      await assert.rejects(
        runInitWizard({
          configPath: envPath,
          flags: {
            provider: 'deepseek',
            apiKey: 'sk-12345678',
            discordToken: 'https://discord.com/api/webhooks/123/abc',
            discordClientId: '1481315001674240102',
            yes: true,
          },
          io: fake.io,
        }),
        /--discord-token invalid/
      );
      // also reject client_secret-shaped
      const fake2 = makeFakeIO([]);
      await assert.rejects(
        runInitWizard({
          configPath: envPath,
          flags: {
            provider: 'deepseek',
            apiKey: 'sk-12345678',
            discordToken: 'short_no_dots_here',
            discordClientId: '1481315001674240102',
            yes: true,
          },
          io: fake2.io,
        }),
        /--discord-token invalid/
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('invalid --profile flag rejected', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      const fake = makeFakeIO([]);
      await assert.rejects(
        runInitWizard({
          configPath: envPath,
          flags: {
            provider: 'deepseek',
            apiKey: 'sk-12345678',
            noDiscord: true,
            profileName: 'bad name!',
            yes: true,
          },
          io: fake.io,
        }),
        /--profile invalid/
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('creates profile data dir on disk', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      const fake = makeFakeIO([]);
      await runInitWizard({
        configPath: envPath,
        flags: {
          provider: 'deepseek',
          apiKey: 'sk-12345678',
          noDiscord: true,
          profileName: 'alpha',
          yes: true,
        },
        io: fake.io,
      });
      const profileDir = join(tmp, 'data', 'profiles', 'alpha');
      // readdir on it should succeed
      const fs = await import('fs/promises');
      const stat = await fs.stat(profileDir);
      assert.ok(stat.isDirectory());
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('runInitWizard — interactive flows', () => {
  test('empty profile input → uses "default"', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      // Script: pick provider 1 (deepseek), paste key, decline discord, blank profile, confirm
      const fake = makeFakeIO([
        '1',                                          // provider
        'sk-ddeadbeefcafebabe1234567890abe2b',        // api key
        'n',                                          // no discord
        '',                                           // profile (default)
        'y',                                          // confirm write
      ]);
      const result = await runInitWizard({
        configPath: envPath,
        flags: {},
        io: fake.io,
      });
      assert.equal(result.answers.profileName, 'default');
      assert.equal(result.answers.discordEnabled, false);
      assert.equal(result.answers.provider, 'deepseek');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('interactive: declines confirmation → no file written', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      const fake = makeFakeIO([
        '1',                                          // provider
        'sk-ddeadbeefcafebabe1234567890abe2b',        // api key
        'n',                                          // no discord
        '',                                           // profile
        'n',                                          // DECLINE
      ]);
      const result = await runInitWizard({
        configPath: envPath,
        flags: {},
        io: fake.io,
      });
      // Body computed but not written
      assert.match(result.envBody, /API_KEY=/);
      await assert.rejects(readFile(envPath, 'utf8'));
      assert.match(fake.output(), /Aborted by user/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('interactive: invalid input loops until valid', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      const fake = makeFakeIO([
        '99',                                         // bad provider choice
        'abc',                                        // bad provider choice
        '1',                                          // valid: deepseek
        '',                                           // bad: empty key
        'short',                                      // bad: too short
        'sk-ddeadbeefcafebabe1234567890abe2b',        // valid
        'maybe',                                      // bad y/n
        'n',                                          // n for discord
        '',                                           // profile
        'y',                                          // confirm
      ]);
      await runInitWizard({
        configPath: envPath,
        flags: {},
        io: fake.io,
      });
      assert.equal(fake.remainingInputs().length, 0);
      // Output should show retry messages
      assert.match(fake.output(), /Please enter 1-/);
      assert.match(fake.output(), /Try again/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('interactive: discord enabled flow with allowed users', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      const fake = makeFakeIO([
        '1',                                          // deepseek
        'sk-ddeadbeefcafebabe1234567890abe2b',        // key
        'y',                                          // enable discord
        'MTAwMDAwMDAwMDAwMDAwMDAwMA.GfAkeT.deadbeefcafebabe1234567890abcdef0123456', // token
        '1481315001674240102',                        // client id
        '1481315001674240103, 1481315001674240104',   // allowed users
        'team',                                       // profile
        'y',                                          // confirm
      ]);
      const result = await runInitWizard({
        configPath: envPath,
        flags: {},
        io: fake.io,
      });
      assert.equal(result.answers.discordEnabled, true);
      assert.deepEqual(result.answers.allowedUserIds, [
        '1481315001674240103',
        '1481315001674240104',
      ]);
      assert.equal(result.answers.profileName, 'team');

      const onDisk = await readFile(envPath, 'utf8');
      assert.match(onDisk, /DISCORD_TOKEN=MTAw/);
      assert.match(onDisk, /MANAMIR_PROFILE=team/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('runInitWizard — semantics', () => {
  test('skip-already-set: flag wins, no prompt for that field', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      // Script ONLY the inputs that should still be needed (none, since
      // we provide everything via flags + yes).
      const fake = makeFakeIO([]);
      await runInitWizard({
        configPath: envPath,
        flags: {
          provider: 'claude',
          apiKey: 'sk-ant-api03-XXXXXXXXX',
          noDiscord: true,
          profileName: 'default',
          yes: true,
        },
        io: fake.io,
      });
      // No leftover scripted inputs and no errors — every step was skipped.
      assert.equal(fake.remainingInputs().length, 0);
      const onDisk = await readFile(envPath, 'utf8');
      assert.match(onDisk, /API_BASE_URL=https:\/\/api\.anthropic\.com/);
      assert.match(onDisk, /API_MODEL=claude-sonnet-4-5/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('custom provider requires interactive base URL', async () => {
    const tmp = await makeTmpDir();
    const envPath = join(tmp, '.env');
    try {
      const fake = makeFakeIO([
        'not-a-url',                                  // rejected
        'https://api.example.com/v1',                 // ok
        'my-model-name',                              // model
      ]);
      const result = await runInitWizard({
        configPath: envPath,
        flags: {
          provider: 'custom',
          apiKey: 'sk-custom-key-12345',
          noDiscord: true,
          profileName: 'default',
          yes: true,
        },
        io: fake.io,
      });
      assert.equal(result.answers.baseUrl, 'https://api.example.com/v1');
      assert.equal(result.answers.model, 'my-model-name');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('overwrites pre-existing .env in nested config path with --force', async () => {
    const tmp = await makeTmpDir();
    const subdir = join(tmp, 'deep', 'nested');
    const envPath = join(subdir, '.env');
    try {
      await mkdir(subdir, { recursive: true });
      await writeFile(envPath, 'OLD=1\n');
      const fake = makeFakeIO([]);
      await runInitWizard({
        configPath: envPath,
        force: true,
        flags: { provider: 'deepseek', apiKey: 'sk-12345678', noDiscord: true, yes: true },
        io: fake.io,
      });
      const onDisk = await readFile(envPath, 'utf8');
      assert.doesNotMatch(onDisk, /OLD=1/);
      assert.match(onDisk, /API_KEY=sk-12345678/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
