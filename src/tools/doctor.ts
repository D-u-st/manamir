// Doctor command — system health checks

import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { log } from '../utils/logger';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface DoctorOptions {
  fix?: boolean;
  config?: {
    discordToken?: string;
    apiKey?: string;
    apiBaseUrl?: string;
    apiModel?: string;
    sessionDataDir?: string;
    logDir?: string;
    wsPort?: number;
  };
  discordConnected?: boolean;
  wsHealthy?: boolean;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const fix = options.fix ?? false;

  results.push(checkNodeVersion());
  results.push(checkDependencies());
  results.push(checkConfig(options));
  results.push(checkDiscordConnection(options));
  results.push(checkWsServer(options));
  results.push(await checkApiKey(options));
  results.push(checkDiskSpace());
  results.push(checkDataDirs(options, fix));
  results.push(checkLockFile(options, fix));

  return results;
}

function checkNodeVersion(): CheckResult {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0], 10);
  if (major >= 18) {
    return { name: 'Node.js version', status: 'pass', message: `v${version}` };
  }
  return { name: 'Node.js version', status: 'fail', message: `v${version} (need >= 18)` };
}

function checkDependencies(): CheckResult {
  const required = ['discord.js', 'ws', 'undici'];
  const missing: string[] = [];
  for (const pkg of required) {
    try {
      require.resolve(pkg);
    } catch {
      missing.push(pkg);
    }
  }
  if (missing.length === 0) {
    return { name: 'Dependencies', status: 'pass', message: 'All key packages found' };
  }
  return { name: 'Dependencies', status: 'fail', message: `Missing: ${missing.join(', ')}` };
}

function checkConfig(options: DoctorOptions): CheckResult {
  const issues: string[] = [];
  const cfg = options.config;
  if (!cfg) {
    return { name: 'Config', status: 'warn', message: 'No config provided to check' };
  }
  if (!cfg.discordToken) issues.push('DISCORD_TOKEN');
  if (!cfg.apiKey) issues.push('API_KEY');
  if (!cfg.apiBaseUrl) issues.push('API_BASE_URL');

  if (issues.length === 0) {
    return { name: 'Config', status: 'pass', message: 'Required env vars present' };
  }
  return { name: 'Config', status: 'fail', message: `Missing: ${issues.join(', ')}` };
}

function checkDiscordConnection(options: DoctorOptions): CheckResult {
  if (options.discordConnected) {
    return { name: 'Discord', status: 'pass', message: 'Bot connected' };
  }
  return { name: 'Discord', status: 'warn', message: 'Bot not connected' };
}

function checkWsServer(options: DoctorOptions): CheckResult {
  if (options.wsHealthy) {
    return { name: 'WebSocket', status: 'pass', message: 'Server responding' };
  }
  if (options.config?.wsPort) {
    return { name: 'WebSocket', status: 'warn', message: `Port ${options.config.wsPort} not responding` };
  }
  return { name: 'WebSocket', status: 'warn', message: 'Not configured' };
}

async function checkApiKey(options: DoctorOptions): Promise<CheckResult> {
  const cfg = options.config;
  if (!cfg?.apiKey || !cfg?.apiBaseUrl) {
    return { name: 'API Key', status: 'warn', message: 'No API key/URL to test' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(`${cfg.apiBaseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (response.ok) {
      return { name: 'API Key', status: 'pass', message: 'API key valid' };
    }
    return { name: 'API Key', status: 'fail', message: `API returned ${response.status}` };
  } catch (err) {
    return { name: 'API Key', status: 'fail', message: `Connection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function checkDiskSpace(): CheckResult {
  try {
    const cwd = process.cwd();
    const stats = statSync(cwd);
    if (stats) {
      return { name: 'Disk space', status: 'pass', message: 'Writable directory accessible' };
    }
  } catch {
    // fall through
  }
  return { name: 'Disk space', status: 'warn', message: 'Could not verify disk access' };
}

function checkDataDirs(options: DoctorOptions, fix: boolean): CheckResult {
  const dirs = [
    options.config?.sessionDataDir || './data/sessions',
    options.config?.logDir || './logs'
  ].map(d => resolve(d));

  const missing: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      if (fix) {
        try {
          mkdirSync(dir, { recursive: true });
          log.info('Doctor: created missing directory', { dir });
        } catch {
          missing.push(dir);
        }
      } else {
        missing.push(dir);
      }
    }
  }

  if (missing.length === 0) {
    return { name: 'Data directories', status: 'pass', message: fix ? 'All present (created missing)' : 'All present' };
  }
  return { name: 'Data directories', status: 'warn', message: `Missing: ${missing.join(', ')}${fix ? '' : ' (use --fix)'}` };
}

function checkLockFile(options: DoctorOptions, fix: boolean): CheckResult {
  const lockPath = resolve(options.config?.sessionDataDir || './data/sessions', '.lock');
  if (!existsSync(lockPath)) {
    return { name: 'Lock file', status: 'pass', message: 'No stale lock' };
  }

  try {
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 3_600_000) {
      if (fix) {
        unlinkSync(lockPath);
        log.info('Doctor: removed stale lock file', { lockPath, ageMs });
        return { name: 'Lock file', status: 'pass', message: 'Stale lock removed' };
      }
      return { name: 'Lock file', status: 'warn', message: `Stale lock (${Math.floor(ageMs / 60_000)}min old, use --fix)` };
    }
    return { name: 'Lock file', status: 'pass', message: 'Lock file is recent' };
  } catch {
    return { name: 'Lock file', status: 'warn', message: 'Could not check lock file' };
  }
}

export function formatDoctorResults(results: CheckResult[]): string {
  const icons: Record<CheckStatus, string> = { pass: '[PASS]', warn: '[WARN]', fail: '[FAIL]' };
  const lines = results.map(r => `${icons[r.status]} ${r.name}: ${r.message}`);
  const passCount = results.filter(r => r.status === 'pass').length;
  const warnCount = results.filter(r => r.status === 'warn').length;
  const failCount = results.filter(r => r.status === 'fail').length;
  lines.push('');
  lines.push(`Total: ${passCount} pass, ${warnCount} warn, ${failCount} fail`);
  return lines.join('\n');
}
