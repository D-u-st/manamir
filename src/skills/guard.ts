// Skill security scanner.
// Regex-based static analysis for exfil / injection / destructive / persistence / network patterns,
// structural checks (file count, size, binaries), invisible Unicode detection,
// and trust-aware install policy.

import { existsSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync } from 'fs';
import { extname, join, relative, sep, basename } from 'path';
import type {
  Finding,
  PolicyDecision,
  ScanResult,
  Severity,
  TrustLevel,
  Verdict,
} from './types';

interface ThreatPattern {
  pattern: RegExp;
  id: string;
  severity: Severity;
  category: string;
  description: string;
}

const THREAT_PATTERNS: ThreatPattern[] = [
  // Exfiltration — shell commands with secrets
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'env_exfil_curl', severity: 'critical', category: 'exfiltration', description: 'curl interpolating secret env variable' },
  { pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'env_exfil_wget', severity: 'critical', category: 'exfiltration', description: 'wget interpolating secret env variable' },
  { pattern: /fetch\s*\([^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|API)/i, id: 'env_exfil_fetch', severity: 'critical', category: 'exfiltration', description: 'fetch() with secret env variable' },
  { pattern: /base64[^\n]*env/i, id: 'encoded_exfil', severity: 'high', category: 'exfiltration', description: 'base64 combined with env access' },
  { pattern: /\$HOME\/\.ssh|~\/\.ssh/i, id: 'ssh_dir_access', severity: 'high', category: 'exfiltration', description: 'references SSH directory' },
  { pattern: /\$HOME\/\.aws|~\/\.aws/i, id: 'aws_dir_access', severity: 'high', category: 'exfiltration', description: 'references AWS credentials dir' },
  { pattern: /\$HOME\/\.gnupg|~\/\.gnupg/i, id: 'gpg_dir_access', severity: 'high', category: 'exfiltration', description: 'references GPG keyring' },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, id: 'read_secrets_file', severity: 'critical', category: 'exfiltration', description: 'reads known secrets file' },
  { pattern: /printenv|env\s*\|/i, id: 'dump_all_env', severity: 'high', category: 'exfiltration', description: 'dumps all env variables' },
  { pattern: /process\.env\[/i, id: 'node_process_env', severity: 'high', category: 'exfiltration', description: 'accesses process.env' },
  { pattern: /\b(dig|nslookup|host)\s+[^\n]*\$/i, id: 'dns_exfil', severity: 'critical', category: 'exfiltration', description: 'DNS lookup with interpolation (possible DNS exfil)' },
  { pattern: /!\[.*\]\(https?:\/\/[^\)]*\$\{?/i, id: 'md_image_exfil', severity: 'high', category: 'exfiltration', description: 'markdown image URL with interpolation' },

  // Prompt injection
  { pattern: /ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+instructions/i, id: 'prompt_injection_ignore', severity: 'critical', category: 'injection', description: 'prompt injection: ignore previous instructions' },
  { pattern: /you\s+are\s+(?:\w+\s+)*now\s+/i, id: 'role_hijack', severity: 'high', category: 'injection', description: 'attempts to override the agent role' },
  { pattern: /do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user/i, id: 'deception_hide', severity: 'critical', category: 'injection', description: 'hide information from user' },
  { pattern: /system\s+prompt\s+override/i, id: 'sys_prompt_override', severity: 'critical', category: 'injection', description: 'attempts to override system prompt' },
  { pattern: /pretend\s+(?:\w+\s+)*(you\s+are|to\s+be)\s+/i, id: 'role_pretend', severity: 'high', category: 'injection', description: 'assume different identity' },
  { pattern: /disregard\s+(?:\w+\s+)*(your|all|any)\s+(?:\w+\s+)*(instructions|rules|guidelines)/i, id: 'disregard_rules', severity: 'critical', category: 'injection', description: 'disregard rules' },
  { pattern: /output\s+(?:\w+\s+)*(system|initial)\s+prompt/i, id: 'leak_system_prompt', severity: 'high', category: 'injection', description: 'extract system prompt' },
  { pattern: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, id: 'html_comment_injection', severity: 'high', category: 'injection', description: 'hidden instructions in HTML comments' },
  { pattern: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, id: 'hidden_div', severity: 'high', category: 'injection', description: 'hidden HTML div' },
  { pattern: /\bDAN\s+mode\b|Do\s+Anything\s+Now/i, id: 'jailbreak_dan', severity: 'critical', category: 'injection', description: 'DAN jailbreak attempt' },

  // Destructive
  { pattern: /rm\s+-rf\s+\//, id: 'destructive_root_rm', severity: 'critical', category: 'destructive', description: 'recursive delete from root' },
  { pattern: /chmod\s+777/, id: 'insecure_perms', severity: 'medium', category: 'destructive', description: 'world-writable permissions' },
  { pattern: />\s*\/etc\//, id: 'system_overwrite', severity: 'critical', category: 'destructive', description: 'overwrites system config file' },
  { pattern: /\bmkfs\b/i, id: 'format_filesystem', severity: 'critical', category: 'destructive', description: 'formats a filesystem' },
  { pattern: /\bdd\s+.*if=.*of=\/dev\//i, id: 'disk_overwrite', severity: 'critical', category: 'destructive', description: 'raw disk write operation' },

  // Persistence
  { pattern: /\bcrontab\b/i, id: 'persistence_cron', severity: 'medium', category: 'persistence', description: 'modifies cron jobs' },
  { pattern: /authorized_keys/i, id: 'ssh_backdoor', severity: 'critical', category: 'persistence', description: 'modifies SSH authorized_keys' },
  { pattern: /\/etc\/sudoers|visudo/i, id: 'sudoers_mod', severity: 'critical', category: 'persistence', description: 'modifies sudoers' },
  { pattern: /AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules/i, id: 'agent_config_mod', severity: 'critical', category: 'persistence', description: 'references agent config files' },

  // Network
  { pattern: /\bnc\s+-[lp]|ncat\s+-[lp]|\bsocat\b/i, id: 'reverse_shell', severity: 'critical', category: 'network', description: 'possible reverse shell listener' },
  { pattern: /\bngrok\b|\blocaltunnel\b|\bserveo\b|\bcloudflared\b/i, id: 'tunnel_service', severity: 'high', category: 'network', description: 'tunneling service' },
  { pattern: /\/bin\/(ba)?sh\s+-i\s+.*>\/dev\/tcp\//i, id: 'bash_reverse_shell', severity: 'critical', category: 'network', description: 'bash reverse shell via /dev/tcp' },
  { pattern: /webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com/i, id: 'exfil_service', severity: 'high', category: 'network', description: 'known exfil/webhook service' },

  // Obfuscation
  { pattern: /base64\s+(-d|--decode)\s*\|/i, id: 'base64_decode_pipe', severity: 'high', category: 'obfuscation', description: 'base64 decode piped to execution' },
  { pattern: /\beval\s*\(\s*["']/, id: 'eval_string', severity: 'high', category: 'obfuscation', description: 'eval() with string argument' },
  { pattern: /echo\s+[^\n]*\|\s*(bash|sh|python|perl|ruby|node)/i, id: 'echo_pipe_exec', severity: 'critical', category: 'obfuscation', description: 'echo piped to interpreter' },

  // Supply chain
  { pattern: /curl\s+[^\n]*\|\s*(ba)?sh/i, id: 'curl_pipe_shell', severity: 'critical', category: 'supply_chain', description: 'curl piped to shell' },
  { pattern: /wget\s+[^\n]*-O\s*-\s*\|\s*(ba)?sh/i, id: 'wget_pipe_shell', severity: 'critical', category: 'supply_chain', description: 'wget piped to shell' },

  // Privilege escalation
  { pattern: /^allowed-tools\s*:/im, id: 'allowed_tools_field', severity: 'high', category: 'privilege_escalation', description: 'skill pre-approves tool access' },
  { pattern: /\bsudo\b/i, id: 'sudo_usage', severity: 'high', category: 'privilege_escalation', description: 'uses sudo' },
  { pattern: /NOPASSWD/i, id: 'nopasswd_sudo', severity: 'critical', category: 'privilege_escalation', description: 'passwordless sudoers entry' },

  // Hardcoded secrets
  { pattern: /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}/i, id: 'hardcoded_secret', severity: 'critical', category: 'credential_exposure', description: 'possible hardcoded secret' },
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, id: 'embedded_private_key', severity: 'critical', category: 'credential_exposure', description: 'embedded private key' },
  { pattern: /ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,}/, id: 'github_token_leaked', severity: 'critical', category: 'credential_exposure', description: 'GitHub PAT in skill content' },
  { pattern: /sk-ant-[A-Za-z0-9_-]{90,}/, id: 'anthropic_key_leaked', severity: 'critical', category: 'credential_exposure', description: 'possible Anthropic API key' },
  { pattern: /AKIA[0-9A-Z]{16}/, id: 'aws_access_key_leaked', severity: 'critical', category: 'credential_exposure', description: 'AWS access key ID' },

  // Crypto mining
  { pattern: /xmrig|stratum\+tcp|monero|coinhive|cryptonight/i, id: 'crypto_mining', severity: 'critical', category: 'mining', description: 'crypto mining reference' },
];

const INVISIBLE_CHARS: Record<string, string> = {
  '\u200b': 'zero-width space',
  '\u200c': 'zero-width non-joiner',
  '\u200d': 'zero-width joiner',
  '\u2060': 'word joiner',
  '\u2062': 'invisible times',
  '\u2063': 'invisible separator',
  '\u2064': 'invisible plus',
  '\ufeff': 'BOM',
  '\u202a': 'LTR embedding',
  '\u202b': 'RTL embedding',
  '\u202c': 'pop directional',
  '\u202d': 'LTR override',
  '\u202e': 'RTL override',
  '\u2066': 'LTR isolate',
  '\u2067': 'RTL isolate',
  '\u2068': 'first strong isolate',
  '\u2069': 'pop directional isolate',
};

const SCANNABLE_EXTENSIONS = new Set([
  '.md', '.txt', '.py', '.sh', '.bash', '.js', '.ts', '.rb',
  '.yaml', '.yml', '.json', '.toml', '.cfg', '.ini', '.conf',
  '.html', '.css', '.xml', '.tex', '.r', '.jl', '.pl', '.php',
]);

const SUSPICIOUS_BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.com',
  '.msi', '.dmg', '.app', '.deb', '.rpm',
]);

const MAX_FILE_COUNT = 50;
const MAX_TOTAL_SIZE_KB = 1024;
const MAX_SINGLE_FILE_KB = 256;

const TRUSTED_REPOS = new Set(['openai/skills', 'anthropics/skills']);

const INSTALL_POLICY: Record<TrustLevel, [PolicyDecision, PolicyDecision, PolicyDecision]> = {
  'builtin': ['allow', 'allow', 'allow'],
  'trusted': ['allow', 'allow', 'block'],
  'community': ['allow', 'block', 'block'],
  'agent-created': ['allow', 'allow', 'ask'],
};

const VERDICT_INDEX: Record<Verdict, number> = { safe: 0, caution: 1, dangerous: 2 };

function resolveTrustLevel(source: string): TrustLevel {
  if (source === 'agent-created') return 'agent-created';
  if (source.startsWith('official/') || source === 'official') return 'builtin';
  for (const repo of TRUSTED_REPOS) {
    if (source === repo || source.startsWith(repo + '/')) return 'trusted';
  }
  return 'community';
}

function determineVerdict(findings: Finding[]): Verdict {
  if (!findings.length) return 'safe';
  if (findings.some((f) => f.severity === 'critical')) return 'dangerous';
  return 'caution';
}

export function scanFile(filePath: string, relPath?: string): Finding[] {
  const display = relPath || basename(filePath);
  const ext = extname(filePath).toLowerCase();
  if (!SCANNABLE_EXTENSIONS.has(ext) && basename(filePath) !== 'SKILL.md') return [];

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const findings: Finding[] = [];
  const lines = content.split('\n');
  const seen = new Set<string>();

  for (const tp of THREAT_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const key = `${tp.id}:${i}`;
      if (seen.has(key)) continue;
      if (tp.pattern.test(lines[i])) {
        seen.add(key);
        let match = lines[i].trim();
        if (match.length > 120) match = match.slice(0, 117) + '...';
        findings.push({
          patternId: tp.id,
          severity: tp.severity,
          category: tp.category,
          file: display,
          line: i + 1,
          match,
          description: tp.description,
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    for (const ch of Object.keys(INVISIBLE_CHARS)) {
      if (lines[i].includes(ch)) {
        findings.push({
          patternId: 'invisible_unicode',
          severity: 'high',
          category: 'injection',
          file: display,
          line: i + 1,
          match: `U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} (${INVISIBLE_CHARS[ch]})`,
          description: `invisible unicode character ${INVISIBLE_CHARS[ch]}`,
        });
        break;
      }
    }
  }

  return findings;
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

function checkStructure(skillDir: string): Finding[] {
  const findings: Finding[] = [];
  let fileCount = 0;
  let totalSize = 0;

  const allPaths: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        const rel = relative(skillDir, full).split(sep).join('/');
        try {
          const resolved = realpathSync(full);
          const baseResolved = realpathSync(skillDir);
          if (!resolved.startsWith(baseResolved)) {
            findings.push({
              patternId: 'symlink_escape',
              severity: 'critical',
              category: 'traversal',
              file: rel,
              line: 0,
              match: `symlink -> ${resolved}`,
              description: 'symlink points outside skill directory',
            });
          }
        } catch {
          findings.push({
            patternId: 'broken_symlink',
            severity: 'medium',
            category: 'traversal',
            file: rel,
            line: 0,
            match: 'broken symlink',
            description: 'broken or circular symlink',
          });
        }
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }

      fileCount++;
      totalSize += st.size;
      allPaths.push(full);

      const rel = relative(skillDir, full).split(sep).join('/');
      const ext = extname(full).toLowerCase();

      if (st.size > MAX_SINGLE_FILE_KB * 1024) {
        findings.push({
          patternId: 'oversized_file',
          severity: 'medium',
          category: 'structural',
          file: rel,
          line: 0,
          match: `${Math.floor(st.size / 1024)}KB`,
          description: `file > ${MAX_SINGLE_FILE_KB}KB`,
        });
      }

      if (SUSPICIOUS_BINARY_EXTENSIONS.has(ext)) {
        findings.push({
          patternId: 'binary_file',
          severity: 'critical',
          category: 'structural',
          file: rel,
          line: 0,
          match: `binary: ${ext}`,
          description: `binary/executable file (${ext}) in skill`,
        });
      }
    }
  };

  walk(skillDir);

  if (fileCount > MAX_FILE_COUNT) {
    findings.push({
      patternId: 'too_many_files',
      severity: 'medium',
      category: 'structural',
      file: '(directory)',
      line: 0,
      match: `${fileCount} files`,
      description: `skill has ${fileCount} files (limit ${MAX_FILE_COUNT})`,
    });
  }

  if (totalSize > MAX_TOTAL_SIZE_KB * 1024) {
    findings.push({
      patternId: 'oversized_skill',
      severity: 'high',
      category: 'structural',
      file: '(directory)',
      line: 0,
      match: `${Math.floor(totalSize / 1024)}KB total`,
      description: `skill exceeds ${MAX_TOTAL_SIZE_KB}KB`,
    });
  }

  return findings;
}

export function scanSkill(skillPath: string, source = 'community'): ScanResult {
  const skillName = basename(skillPath);
  const trustLevel = resolveTrustLevel(source);
  const findings: Finding[] = [];

  let st;
  try {
    st = statSync(skillPath);
  } catch {
    st = null;
  }

  if (st?.isDirectory()) {
    findings.push(...checkStructure(skillPath));
    for (const f of walkFiles(skillPath)) {
      const rel = relative(skillPath, f).split(sep).join('/');
      findings.push(...scanFile(f, rel));
    }
  } else if (st?.isFile()) {
    findings.push(...scanFile(skillPath, basename(skillPath)));
  }

  const verdict = determineVerdict(findings);
  const categories = Array.from(new Set(findings.map((f) => f.category))).sort();
  const summary = findings.length
    ? `${skillName}: ${verdict} — ${findings.length} finding(s) in ${categories.join(', ')}`
    : `${skillName}: clean scan`;

  return {
    skillName,
    source,
    trustLevel,
    verdict,
    findings,
    scannedAt: new Date().toISOString(),
    summary,
  };
}

export function shouldAllowInstall(
  result: ScanResult,
  force = false
): { allowed: boolean | null; reason: string } {
  const policy = INSTALL_POLICY[result.trustLevel] ?? INSTALL_POLICY.community;
  const decision = policy[VERDICT_INDEX[result.verdict]];

  if (decision === 'allow') {
    return { allowed: true, reason: `Allowed (${result.trustLevel} / ${result.verdict})` };
  }
  if (force) {
    return { allowed: true, reason: `Force-installed despite ${result.verdict}` };
  }
  if (decision === 'ask') {
    return { allowed: null, reason: `Requires confirmation (${result.trustLevel} / ${result.verdict})` };
  }
  return {
    allowed: false,
    reason: `Blocked (${result.trustLevel} / ${result.verdict}, ${result.findings.length} findings)`,
  };
}

export function formatScanReport(result: ScanResult): string {
  const lines: string[] = [];
  lines.push(`Scan: ${result.skillName} (${result.source}/${result.trustLevel})  Verdict: ${result.verdict.toUpperCase()}`);
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...result.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  for (const f of sorted) {
    lines.push(`  ${f.severity.toUpperCase().padEnd(8)} ${f.category.padEnd(14)} ${(f.file + ':' + f.line).padEnd(30)} "${f.match.slice(0, 60)}"`);
  }
  const { allowed, reason } = shouldAllowInstall(result);
  const status = allowed === true ? 'ALLOWED' : allowed === null ? 'NEEDS CONFIRMATION' : 'BLOCKED';
  lines.push(`Decision: ${status} — ${reason}`);
  return lines.join('\n');
}

export { existsSync as _existsSync };
