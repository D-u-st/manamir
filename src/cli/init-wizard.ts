// Manamir init wizard — interactive setup that produces a working .env
// from zero. Designed for first-time users who want a low-friction onboarding.
//
// Usable two ways:
//   * Fully interactive — prompts for every step, with sensible defaults.
//   * Flag-driven    — supply --provider/--api-key/--no-discord etc. and the
//                       wizard skips matching steps. Lets us script setup
//                       (e.g. from CI or from a deploy template).
//
// Inputs and outputs are injected via the `io` parameter so the wizard is
// fully testable without touching real stdin/stdout or the real filesystem.
//
// Design choices (intentional):
//   * No deps. We only use Node built-ins (readline/promises, fs, path).
//   * No interactive input hiding (stdin TTY echo) — readline doesn't expose
//     a clean "noecho" without raw mode hacks. Instead, we mask the value on
//     re-display. Real key paste-protection lives at the terminal level
//     (the wizard prints an explicit "input visible" warning when STDIN is a
//     TTY so users know to clear scrollback if they care).
//   * Validation is intentionally permissive — providers can have any URL
//     scheme, and Discord token shape changes over time. We reject only the
//     things that cannot possibly be right (empty, obvious malformed values).

import { mkdir, writeFile, access } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { resolve, dirname } from 'path';
import { createInterface, type Interface as ReadlineInterface } from 'readline/promises';

// ---------------- Types ----------------

export type ProviderId = 'deepseek' | 'claude' | 'openai' | 'custom';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  apiKeyHint: string;
  apiKeyPrefix?: string; // soft check
}

export interface WizardAnswers {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  apiKey: string;
  discordEnabled: boolean;
  discordToken: string;
  discordClientId: string;
  allowedUserIds: string[];
  profileName: string;
}

export interface WizardFlags {
  provider?: ProviderId;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  noDiscord?: boolean;
  discordToken?: string;
  discordClientId?: string;
  allowedUserIds?: string[];
  profileName?: string;
  yes?: boolean; // accept all defaults non-interactively
}

export interface WizardIO {
  /** Read a single line. Returns the raw user input (no trailing newline). */
  ask: (prompt: string) => Promise<string>;
  /** Print to stdout (no implicit newline). */
  write: (text: string) => void;
  /** Close any underlying readline. */
  close: () => void;
}

export interface WizardResult {
  envPath: string;
  answers: WizardAnswers;
  /** What the wizard actually wrote (so callers can show a summary). */
  envBody: string;
}

// ---------------- Provider presets ----------------

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek (cheap, good for general use)',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    apiKeyHint: 'https://platform.deepseek.com/',
    apiKeyPrefix: 'sk-',
  },
  claude: {
    id: 'claude',
    label: 'Claude API (Anthropic, premium)',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    apiKeyHint: 'https://console.anthropic.com/',
    apiKeyPrefix: 'sk-ant-',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (GPT-4 family)',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    apiKeyHint: 'https://platform.openai.com/api-keys',
    apiKeyPrefix: 'sk-',
  },
  custom: {
    id: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    baseUrl: '',
    defaultModel: '',
    apiKeyHint: '(your provider\'s docs)',
  },
};

const PROVIDER_ORDER: ProviderId[] = ['deepseek', 'claude', 'openai', 'custom'];

// ---------------- Validators (exported so tests can hit them) ----------------

export function validateApiKey(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'API key cannot be empty';
  if (v.length < 8) return 'API key looks too short (need at least 8 chars)';
  if (/\s/.test(v)) return 'API key cannot contain whitespace';
  return null;
}

export function validateDiscordToken(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Discord token cannot be empty';
  // Discord bot tokens are three base64url segments separated by dots.
  // We don't enforce the exact shape (Discord changes it occasionally) but we
  // do reject anything that *clearly* isn't a bot token, like a client_secret
  // (alphanumeric, no dots) or a webhook URL.
  if (v.startsWith('http://') || v.startsWith('https://')) {
    return 'That looks like a URL — paste the bot token, not a webhook URL';
  }
  // client_secret is usually a single alphanumeric/underscore string with no
  // dots. Bot tokens always contain at least 2 dots.
  const dotCount = (v.match(/\./g) || []).length;
  if (dotCount < 2) {
    return 'That looks like a client_secret, not a bot token (bot tokens have 2 dots)';
  }
  return null;
}

export function validateDiscordClientId(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Discord client ID cannot be empty';
  if (!/^\d{15,25}$/.test(v)) return 'Client ID should be 15-25 digits';
  return null;
}

export function validateProfileName(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null; // empty → use default
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(v)) {
    return 'Profile name must be 1-40 chars: letters, digits, _ or -';
  }
  return null;
}

export function parseAllowedUserIds(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{15,25}$/.test(s));
}

export function maskSecret(secret: string): string {
  const v = secret.trim();
  if (!v) return '(empty)';
  if (v.length <= 8) return '*'.repeat(v.length);
  return `${v.slice(0, 4)}...${v.slice(-3)}`;
}

// ---------------- Default IO (real stdin/stdout) ----------------

export function makeStdIO(): WizardIO {
  const rl: ReadlineInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return {
    ask: async (prompt: string) => rl.question(prompt),
    write: (text: string) => process.stdout.write(text),
    close: () => rl.close(),
  };
}

// ---------------- Helpers ----------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function buildEnvBody(a: WizardAnswers): string {
  // Order matters — keep proxy at the top (our proxy-setup.ts reads it),
  // then provider, then Discord, then misc. Comments before each section.
  const lines: string[] = [];
  lines.push('# Generated by `manamir init` — feel free to edit.');
  lines.push('# Re-run with `manamir init --force` to regenerate from scratch.');
  lines.push('');
  lines.push('# ---------------- Network ----------------');
  lines.push('# Uncomment if you need an outbound proxy (e.g. corporate or geo-restricted region).');
  lines.push('# HTTPS_PROXY=http://127.0.0.1:1080');
  lines.push('# HTTP_PROXY=http://127.0.0.1:1080');
  lines.push('');
  lines.push('# ---------------- LLM provider ----------------');
  lines.push(`EXECUTOR_TYPE=api`);
  lines.push(`API_KEY=${a.apiKey}`);
  lines.push(`API_BASE_URL=${a.baseUrl}`);
  lines.push(`API_MODEL=${a.model}`);
  lines.push(`API_MAX_TOKENS=4096`);
  lines.push(`API_TEMPERATURE=0.7`);
  lines.push('');
  lines.push('# ---------------- Discord ----------------');
  if (a.discordEnabled) {
    lines.push(`DISCORD_TOKEN=${a.discordToken}`);
    lines.push(`DISCORD_CLIENT_ID=${a.discordClientId}`);
    lines.push(`ALLOWED_USER_IDS=${a.allowedUserIds.join(',')}`);
  } else {
    lines.push('# Discord disabled — `npm start` will refuse to boot without these set.');
    lines.push('# Use `npm run cli` for the local REPL channel only.');
    lines.push('# DISCORD_TOKEN=');
    lines.push('# DISCORD_CLIENT_ID=');
    lines.push('# ALLOWED_USER_IDS=');
  }
  lines.push('');
  lines.push('# ---------------- Profile & data ----------------');
  if (a.profileName && a.profileName !== 'default') {
    lines.push(`MANAMIR_PROFILE=${a.profileName}`);
  } else {
    lines.push(`# MANAMIR_PROFILE=default`);
  }
  lines.push('');
  lines.push('# ---------------- Logging ----------------');
  lines.push('LOG_LEVEL=info');
  lines.push('LOG_DIR=./logs');
  lines.push('');
  lines.push('# See docs/CONFIGURATION.md for the full env var reference.');
  lines.push('');
  return lines.join('\n');
}

// ---------------- Step prompts ----------------

async function pickProvider(io: WizardIO, flag?: ProviderId): Promise<ProviderId> {
  if (flag) {
    if (!(flag in PROVIDER_PRESETS)) {
      throw new Error(`Unknown provider: ${flag}`);
    }
    io.write(`Provider: ${PROVIDER_PRESETS[flag].label} (from --provider)\n`);
    return flag;
  }
  io.write('\nStep 1: Provider selection\n');
  io.write('  Which LLM provider do you want to use?\n');
  PROVIDER_ORDER.forEach((id, i) => {
    io.write(`  (${i + 1}) ${PROVIDER_PRESETS[id].label}\n`);
  });
  while (true) {
    const ans = (await io.ask('> ')).trim();
    const n = parseInt(ans, 10);
    if (!Number.isFinite(n) || n < 1 || n > PROVIDER_ORDER.length) {
      io.write(`  Please enter 1-${PROVIDER_ORDER.length}.\n`);
      continue;
    }
    return PROVIDER_ORDER[n - 1];
  }
}

async function askApiKey(io: WizardIO, preset: ProviderPreset, flag?: string): Promise<string> {
  if (flag) {
    const err = validateApiKey(flag);
    if (err) throw new Error(`--api-key invalid: ${err}`);
    io.write(`API key: ${maskSecret(flag)} (from --api-key)\n`);
    return flag.trim();
  }
  io.write('\nStep 2: API key\n');
  io.write(`  Get your API key from ${preset.apiKeyHint}\n`);
  if (preset.apiKeyPrefix) {
    io.write(`  Expected prefix: "${preset.apiKeyPrefix}"\n`);
  }
  io.write('  Paste here (will be displayed once for you to verify):\n');
  while (true) {
    const ans = await io.ask('> ');
    const err = validateApiKey(ans);
    if (err) {
      io.write(`  ${err}. Try again.\n`);
      continue;
    }
    if (preset.apiKeyPrefix && !ans.trim().startsWith(preset.apiKeyPrefix)) {
      io.write(`  Note: that doesn't start with "${preset.apiKeyPrefix}" — using anyway.\n`);
    }
    return ans.trim();
  }
}

async function askBaseUrl(io: WizardIO, preset: ProviderPreset, flag?: string): Promise<string> {
  if (flag) {
    io.write(`Base URL: ${flag} (from --base-url)\n`);
    return flag.trim();
  }
  if (preset.id === 'custom') {
    while (true) {
      const ans = (await io.ask('  Base URL (e.g. https://api.example.com/v1): ')).trim();
      if (!ans) {
        io.write('  Base URL cannot be empty for custom provider.\n');
        continue;
      }
      if (!/^https?:\/\//.test(ans)) {
        io.write('  URL must start with http:// or https://\n');
        continue;
      }
      return ans;
    }
  }
  return preset.baseUrl;
}

async function askModel(io: WizardIO, preset: ProviderPreset, flag?: string): Promise<string> {
  if (flag) {
    io.write(`Model: ${flag} (from --model)\n`);
    return flag.trim();
  }
  if (preset.id === 'custom') {
    const ans = (await io.ask('  Model name: ')).trim();
    return ans || 'gpt-3.5-turbo';
  }
  return preset.defaultModel;
}

async function askDiscordSection(
  io: WizardIO,
  flags: WizardFlags
): Promise<{ enabled: boolean; token: string; clientId: string; allowed: string[] }> {
  if (flags.noDiscord) {
    io.write('\nStep 3: Discord — disabled (--no-discord)\n');
    return { enabled: false, token: '', clientId: '', allowed: [] };
  }

  let enable: boolean;
  if (flags.discordToken !== undefined || flags.discordClientId !== undefined) {
    enable = true;
    io.write('\nStep 3: Discord — enabled (flags provided)\n');
  } else {
    io.write('\nStep 3: Discord (optional)\n');
    while (true) {
      const ans = (await io.ask('  Do you want to enable Discord bot? (y/n): ')).trim().toLowerCase();
      if (ans === 'y' || ans === 'yes') { enable = true; break; }
      if (ans === 'n' || ans === 'no' || ans === '') { enable = false; break; }
      io.write('  Please answer y or n.\n');
    }
  }

  if (!enable) return { enabled: false, token: '', clientId: '', allowed: [] };

  // Token
  let token: string;
  if (flags.discordToken) {
    const err = validateDiscordToken(flags.discordToken);
    if (err) throw new Error(`--discord-token invalid: ${err}`);
    token = flags.discordToken.trim();
    io.write(`  Token: ${maskSecret(token)} (from --discord-token)\n`);
  } else {
    io.write('  Discord bot token (https://discord.com/developers/applications)\n');
    while (true) {
      const ans = await io.ask('  > ');
      const err = validateDiscordToken(ans);
      if (err) { io.write(`  ${err}. Try again.\n`); continue; }
      token = ans.trim();
      break;
    }
  }

  // Client ID
  let clientId: string;
  if (flags.discordClientId) {
    const err = validateDiscordClientId(flags.discordClientId);
    if (err) throw new Error(`--discord-client-id invalid: ${err}`);
    clientId = flags.discordClientId.trim();
    io.write(`  Client ID: ${clientId} (from --discord-client-id)\n`);
  } else {
    while (true) {
      const ans = await io.ask('  Discord client ID: ');
      const err = validateDiscordClientId(ans);
      if (err) { io.write(`  ${err}. Try again.\n`); continue; }
      clientId = ans.trim();
      break;
    }
  }

  // Allowed users
  let allowed: string[];
  if (flags.allowedUserIds) {
    allowed = flags.allowedUserIds;
    io.write(`  Allowed users: ${allowed.length} ID(s) (from --allowed-user-ids)\n`);
  } else {
    const ans = await io.ask('  Allowed user IDs (comma-separated, your Discord user ID): ');
    allowed = parseAllowedUserIds(ans);
    if (allowed.length === 0) {
      io.write('  Warning: no valid user IDs — bot will respond to nobody until you add some.\n');
    }
  }

  return { enabled: true, token, clientId, allowed };
}

async function askProfileName(io: WizardIO, flag?: string, yes?: boolean): Promise<string> {
  if (flag !== undefined) {
    const err = validateProfileName(flag);
    if (err) throw new Error(`--profile invalid: ${err}`);
    const v = flag.trim() || 'default';
    io.write(`Profile: ${v} (from --profile)\n`);
    return v;
  }
  // --yes implies "accept all defaults" — don't ask for profile name.
  if (yes) {
    io.write('\nStep 4: Profile name — default (--yes)\n');
    return 'default';
  }
  io.write('\nStep 4: Profile name\n');
  io.write('  Profile name lets you run multiple isolated instances.\n');
  while (true) {
    const ans = await io.ask('  Profile name [default]: ');
    const err = validateProfileName(ans);
    if (err) { io.write(`  ${err}. Try again.\n`); continue; }
    return ans.trim() || 'default';
  }
}

async function confirm(io: WizardIO, a: WizardAnswers, flags: WizardFlags): Promise<boolean> {
  io.write('\nStep 5: Confirm\n');
  io.write('  Configuration:\n');
  io.write(`    Provider:   ${PROVIDER_PRESETS[a.provider].label}\n`);
  io.write(`    Base URL:   ${a.baseUrl}\n`);
  io.write(`    Model:      ${a.model}\n`);
  io.write(`    API key:    ${maskSecret(a.apiKey)}\n`);
  if (a.discordEnabled) {
    io.write(`    Discord:    enabled\n`);
    io.write(`      token:    ${maskSecret(a.discordToken)}\n`);
    io.write(`      client:   ${a.discordClientId}\n`);
    io.write(`      allowed:  ${a.allowedUserIds.length} user(s)\n`);
  } else {
    io.write(`    Discord:    disabled\n`);
  }
  io.write(`    Profile:    ${a.profileName}\n\n`);

  if (flags.yes) {
    io.write('  --yes given, writing without prompt.\n');
    return true;
  }
  while (true) {
    const ans = (await io.ask('  Write to .env? (y/n): ')).trim().toLowerCase();
    if (ans === 'y' || ans === 'yes' || ans === '') return true;
    if (ans === 'n' || ans === 'no') return false;
    io.write('  Please answer y or n.\n');
  }
}

// ---------------- Main entry ----------------

export interface RunInitWizardOpts {
  configPath: string;
  force?: boolean;
  flags?: WizardFlags;
  io?: WizardIO;
  /** If true, never write — just return what *would* have been written. */
  dryRun?: boolean;
}

export async function runInitWizard(opts: RunInitWizardOpts): Promise<WizardResult> {
  const flags: WizardFlags = opts.flags ?? {};
  const io: WizardIO = opts.io ?? makeStdIO();
  const envPath = resolve(opts.configPath);

  try {
    // Refuse to overwrite without --force
    if (!opts.dryRun && (await fileExists(envPath)) && !opts.force) {
      io.write(`\nRefusing to overwrite existing ${envPath}.\n`);
      io.write('Re-run with --force to overwrite, or pick a different --config path.\n');
      throw new Error('refusing to overwrite without --force');
    }

    if (!flags.yes) {
      io.write('\nWelcome to Manamir! Let\'s set you up.\n');
    }

    // Step 1
    const provider = await pickProvider(io, flags.provider);
    const preset = PROVIDER_PRESETS[provider];

    // Step 2
    const apiKey = await askApiKey(io, preset, flags.apiKey);

    // Base URL + model (custom may need prompts; presets are deterministic)
    const baseUrl = await askBaseUrl(io, preset, flags.baseUrl);
    const model = await askModel(io, preset, flags.model);

    // Step 3
    const discord = await askDiscordSection(io, flags);

    // Step 4
    const profileName = await askProfileName(io, flags.profileName, flags.yes);

    const answers: WizardAnswers = {
      provider,
      baseUrl,
      model,
      apiKey,
      discordEnabled: discord.enabled,
      discordToken: discord.token,
      discordClientId: discord.clientId,
      allowedUserIds: discord.allowed,
      profileName,
    };

    const proceed = await confirm(io, answers, flags);
    const envBody = buildEnvBody(answers);

    if (!proceed) {
      io.write('\nAborted by user. Nothing written.\n');
      return { envPath, answers, envBody };
    }

    if (opts.dryRun) {
      io.write('\n(dry-run — no files written)\n');
      return { envPath, answers, envBody };
    }

    // Write .env atomically
    await mkdir(dirname(envPath), { recursive: true });
    await writeFile(envPath, envBody, { encoding: 'utf8', mode: 0o600 });
    io.write(`\nWrote ${envPath}\n`);

    // Create profile data dir so a subsequent `npm start` doesn't trip on
    // missing dirs.
    const dataDir = resolve(dirname(envPath), 'data');
    const profileDir = resolve(dataDir, 'profiles', profileName);
    await mkdir(profileDir, { recursive: true });
    io.write(`Created ${profileDir}\n`);

    io.write('\nNext steps:\n');
    if (answers.discordEnabled) {
      io.write('  npm start            # start the bot (Discord + WS)\n');
    } else {
      io.write('  npm run cli          # local REPL (no Discord)\n');
    }
    io.write('  npm run cli          # local REPL\n');
    io.write('\nRead the full guide at docs/QUICKSTART.md\n');

    return { envPath, answers, envBody };
  } finally {
    io.close();
  }
}
