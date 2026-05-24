// API key safety checks — runs at startup to catch common security mistakes.
// Goal: surface obvious problems (key in plaintext file, .env committed, weak token, etc.)
// without being annoying for power users (everything is warn-level by default).

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { log } from '../utils/logger';

export interface SafetyFinding {
  severity: 'info' | 'warn' | 'critical';
  code: string;
  message: string;
  remediation?: string;
}

export interface SafetyReport {
  passed: boolean; // false if any 'critical'
  findings: SafetyFinding[];
}

const KEY_PATTERNS = [
  { name: 'OpenAI', re: /^sk-[A-Za-z0-9]{20,}/ },
  { name: 'Anthropic', re: /^sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'DeepSeek', re: /^sk-[a-f0-9]{32}/ },
  { name: 'OpenRouter', re: /^sk-or-[A-Za-z0-9]{20,}/ },
  { name: 'Google AI', re: /^AIza[A-Za-z0-9_-]{35}/ },
  { name: 'Discord bot', re: /^[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}/ },
];

function detectKeyType(value: string): string | null {
  for (const { name, re } of KEY_PATTERNS) {
    if (re.test(value)) return name;
  }
  return null;
}

function isShortAndSuspicious(value: string): boolean {
  // Shorter than 20 chars or contains "test"/"demo"/"placeholder"
  if (value.length < 20) return true;
  if (/(test|demo|placeholder|example|your[-_]key|insert[-_]here|fixme|todo)/i.test(value)) {
    return true;
  }
  return false;
}

/**
 * Scan the loaded config (env vars) for common API key safety problems.
 * Returns a report; caller decides whether to abort or just warn.
 */
export function scanApiKeySafety(opts: {
  projectRoot?: string;
  envFilePath?: string;
} = {}): SafetyReport {
  const findings: SafetyFinding[] = [];
  const projectRoot = opts.projectRoot ?? process.cwd();
  const envFilePath = opts.envFilePath ?? join(projectRoot, '.env');

  // Check 1: API_KEY present + format
  const apiKey = (process.env.API_KEY ?? '').trim();
  if (apiKey) {
    const detectedType = detectKeyType(apiKey);
    if (!detectedType) {
      findings.push({
        severity: 'warn',
        code: 'unknown_key_format',
        message: 'API_KEY does not match any known provider key format.',
        remediation: 'Verify the key is correct and from a supported provider (OpenAI/Anthropic/DeepSeek/OpenRouter/Google).',
      });
    }
    if (isShortAndSuspicious(apiKey)) {
      findings.push({
        severity: 'critical',
        code: 'placeholder_key',
        message: 'API_KEY looks like a placeholder or test value.',
        remediation: 'Set a real API key in your .env file.',
      });
    }
  }

  // Check 2: Discord token format
  const discordToken = (process.env.DISCORD_TOKEN ?? '').trim();
  if (discordToken && !detectKeyType(discordToken)?.includes('Discord')) {
    findings.push({
      severity: 'warn',
      code: 'discord_token_format',
      message: 'DISCORD_TOKEN does not match the expected Discord bot token format.',
      remediation: 'Tokens look like XXXXX.YYYYY.ZZZZZZZ — get one from https://discord.com/developers/applications.',
    });
  }

  // Check 3: .env file permissions (Unix only — skip on Windows)
  if (process.platform !== 'win32' && existsSync(envFilePath)) {
    try {
      const st = statSync(envFilePath);
      // mode & 0o077 — any group/world bits set is too permissive
      const mode = st.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        findings.push({
          severity: 'warn',
          code: 'env_file_too_permissive',
          message: `.env file mode is ${mode.toString(8)} — readable by group/others.`,
          remediation: `Run: chmod 600 ${envFilePath}`,
        });
      }
    } catch {
      // ignore stat errors
    }
  }

  // Check 4: .env in .git or under a tracked location
  const gitDir = join(projectRoot, '.git');
  const gitignore = join(projectRoot, '.gitignore');
  if (existsSync(gitDir) && existsSync(envFilePath)) {
    let gitignoreContent = '';
    if (existsSync(gitignore)) {
      try {
        gitignoreContent = readFileSync(gitignore, 'utf-8');
      } catch {
        // ignore
      }
    }
    const envIgnored = /^\.env(\s|$)/m.test(gitignoreContent) || /^\.env\b/m.test(gitignoreContent);
    if (!envIgnored) {
      findings.push({
        severity: 'critical',
        code: 'env_not_gitignored',
        message: 'Project has a .git directory but .env is NOT in .gitignore.',
        remediation: 'Add ".env" to .gitignore IMMEDIATELY to avoid committing secrets.',
      });
    }
  }

  // Check 5: Multiple keys on the same line (parsing error / accidental concatenation)
  if (existsSync(envFilePath)) {
    try {
      const envContent = readFileSync(envFilePath, 'utf-8');
      const lines = envContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('#') || !line.includes('=')) continue;
        // Count how many "key-like" substrings appear on this line.
        // Strip leading ^ anchor so the pattern matches anywhere in the line.
        let keyHits = 0;
        for (const { re } of KEY_PATTERNS) {
          const unanchored = re.source.replace(/^\^/, '');
          const matches = line.match(new RegExp(unanchored, 'g'));
          if (matches) keyHits += matches.length;
        }
        if (keyHits > 1) {
          findings.push({
            severity: 'warn',
            code: 'multiple_keys_one_line',
            message: `Line ${i + 1} of .env appears to contain multiple keys.`,
            remediation: 'Verify the file: each KEY=VALUE should be on its own line.',
          });
        }
      }
    } catch {
      // ignore
    }
  }

  // Check 6: AUTONOMOUS_ENABLED + no ALLOWED_USER_IDS = open access
  const autonomousOn =
    (process.env.AUTONOMOUS_ENABLED ?? '').toLowerCase() === 'true';
  const allowedUsers = (process.env.ALLOWED_USER_IDS ?? '').trim();
  if (autonomousOn && !allowedUsers) {
    findings.push({
      severity: 'warn',
      code: 'autonomous_no_allowlist',
      message: 'AUTONOMOUS_ENABLED=true but ALLOWED_USER_IDS is empty.',
      remediation: 'Set ALLOWED_USER_IDS to your Discord user ID to prevent strangers from queueing tasks.',
    });
  }

  // Check 7: POLICY_RELAXED + multi-user = dangerous
  const relaxed =
    (process.env.MANAMIR_POLICY_RELAXED ?? '').toLowerCase() === 'true';
  const userCount = allowedUsers.split(',').filter((s) => s.trim()).length;
  if (relaxed && userCount > 1) {
    findings.push({
      severity: 'critical',
      code: 'relaxed_with_multiple_users',
      message: `MANAMIR_POLICY_RELAXED=true but ALLOWED_USER_IDS lists ${userCount} users.`,
      remediation: 'Disable MANAMIR_POLICY_RELAXED or restrict to a single trusted user.',
    });
  }

  const passed = findings.every((f) => f.severity !== 'critical');
  return { passed, findings };
}

/**
 * Run the safety scan and log findings. Returns true if safe to start, false
 * if a critical finding should abort startup.
 */
export function logSafetyReport(report: SafetyReport): void {
  if (report.findings.length === 0) {
    log.info('API key safety: all checks passed');
    return;
  }

  for (const f of report.findings) {
    const meta = { code: f.code, remediation: f.remediation };
    if (f.severity === 'critical') {
      log.error(`API key safety [CRITICAL]: ${f.message}`, meta);
    } else if (f.severity === 'warn') {
      log.warn(`API key safety: ${f.message}`, meta);
    } else {
      log.info(`API key safety: ${f.message}`, meta);
    }
  }
}
