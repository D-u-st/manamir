// Tool Policy Pipeline (P-63): deny dangerous operations before execution

import { resolve } from 'path';
import { stripAnsi, normalizeUnicode } from '../security/redact';

const BLOCKED_PATH_PREFIXES = [
  '/etc/shadow',
  '/etc/passwd',
  '/etc/sudoers',
  '/proc/',
  '/sys/',
  '/dev/',
  '/boot/',
  '/root/.ssh/',
  '/root/.gnupg/',
];

const BLOCKED_PATH_SUFFIXES = [
  '/.ssh/id_rsa',
  '/.ssh/id_ed25519',
  '/.ssh/authorized_keys',
  '/.env',
];

const BLOCKED_COMMAND_PATTERNS: RegExp[] = [
  // Original 8 patterns
  /\brm\s+(-\w*r\w*\s+)*(-\w*f\w*\s+)*\//,
  /\bdd\b.*\bif=/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bmkfs\b/,
  /\bchmod\s+(-r\s+)?777\s+\//i,
  /:\(\)\s*\{.*\}.*;\s*:/,
  /\bchown\s+-R\b/,
  /\b(curl|wget)\b.*\|\s*(sh|bash)\b/,

  // SQL destructive operations
  /\b(drop|truncate)\s+(table|database|schema|index)\b/i,
  /\bdelete\s+from\b/i,
  /\balter\s+table\b.*\bdrop\b/i,

  // Service disruption
  /\bsystemctl\s+(stop|restart|disable)\b/i,
  /\bservice\s+\w+\s+(stop|restart)\b/i,
  /\bkill\s+-9\s+-1\b/,
  /\bpkill\s+-9\b/,
  /\bkillall\s+-9\b/,

  // Shell injection vectors
  /\bsh\s+-c\b/,
  /\bbash\s+-c\b/,
  /\bpython3?\s+-[ce]\b/,
  /\bnode\s+-e\b/,
  /\bperl\s+-e\b/,
  /\bruby\s+-e\b/,

  // Pipe-to-shell variants
  /\b(curl|wget)\b.*\|\s*(python|perl|ruby|node)\b/,
  /<<[<-]?\s*\w+.*\b(sh|bash)\b/,

  // Destructive find/xargs
  /\bxargs\b.*\brm\b/,
  /\bfind\b.*-delete\b/,
  /\bfind\b.*-exec\s+rm\b/,

  // Git destructive operations
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+push\s+--force\b/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+clean\s+-f/,
  /\bgit\s+branch\s+-D\b/,

  // chmod+execute chain
  /\bchmod\s+\+x\b.*&&/,

  // Self-termination protection
  /\bpkill\s+.*manamir\b/i,
  /\bkill\b.*\$\(pgrep\s+manamir\)/i,
  /\bkillall\s+.*manamir\b/i,

  // Disk/filesystem destruction
  /\bformat\b.*\/dev\//,
  /\bfdisk\b/,
  /\bparted\b/,
  />\s*\/dev\/(sd|hd|nvme)/,

  // Credential exfiltration
  /\bcat\b.*\/(etc\/shadow|\.ssh\/|\.gnupg\/)/,
  /\bbase64\b.*\/(etc\/shadow|\.ssh\/)/,
];

export interface PolicyViolation {
  tool: string;
  reason: string;
  input: string;
}

/**
 * Relaxed mode: when MANAMIR_POLICY_RELAXED=true, command-policy regex checks
 * are skipped (path-policy stays — protecting /etc/shadow etc. is non-negotiable).
 *
 * Use ONLY in single-user trusted environments. NEVER enable when the bot is
 * exposed to other users (Discord with multiple ALLOWED_USER_IDS).
 *
 * Trade-off:
 *   - Strict (default): may show ❌ on legitimate `python -c`, `bash -c` etc.,
 *     but protects against prompt-injection attempts to execute attacker code.
 *   - Relaxed: AI uses inline interpreters freely, but attacker prompts could
 *     execute arbitrary code if they reach the bot.
 */
function isRelaxedMode(): boolean {
  return (process.env.MANAMIR_POLICY_RELAXED ?? '').toLowerCase() === 'true';
}

export function checkPathPolicy(toolName: string, filePath: string): PolicyViolation | null {
  const normalized = resolve(filePath).replace(/\\/g, '/');

  for (const prefix of BLOCKED_PATH_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return { tool: toolName, reason: `Blocked path prefix: ${prefix}`, input: filePath };
    }
  }

  for (const suffix of BLOCKED_PATH_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      return { tool: toolName, reason: `Blocked path suffix: ${suffix}`, input: filePath };
    }
  }

  return null;
}

export function checkCommandPolicy(toolName: string, command: string): PolicyViolation | null {
  // Relaxed mode skips command-policy regex (kept opt-in via env var).
  // Path-policy is intentionally still enforced.
  if (isRelaxedMode()) return null;

  const cleaned = stripAnsi(command);
  const normalized = normalizeUnicode(cleaned).toLowerCase().replace(/\s+/g, ' ').trim();

  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(normalized)) {
      return { tool: toolName, reason: `Blocked command pattern: ${pattern.source}`, input: command };
    }
  }

  return null;
}
