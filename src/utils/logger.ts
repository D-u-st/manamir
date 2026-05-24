// Simple structured logger — no heavy deps like winston
// Writes to stdout (Bun/systemd captures) + optional file rotation

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

let currentLevel: LogLevel = 'info';
let logDir: string | null = null;
let consoleSilent = false;

export function configureLogger(level: LogLevel, dir?: string): void {
  currentLevel = level;
  if (dir) {
    logDir = dir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Silence console output (still writes to file). Useful for CLI mode where
 * logger noise would corrupt the readline prompt / streaming display.
 */
export function setLoggerConsoleSilent(silent: boolean): void {
  consoleSilent = silent;
}

function formatMessage(level: LogLevel, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  return `${ts} [${level.toUpperCase()}] ${msg}${metaStr}`;
}

function writeLog(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLevel]) return;

  const formatted = formatMessage(level, msg, meta);

  // Console output (suppressed in silent mode — file output still happens)
  if (!consoleSilent) {
    if (level === 'error') {
      console.error(formatted);
    } else if (level === 'warn') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }

  // File output
  if (logDir) {
    const date = new Date().toISOString().slice(0, 10);
    const file = level === 'error' ? `error-${date}.log` : `bot-${date}.log`;
    try {
      appendFileSync(join(logDir, file), formatted + '\n');
    } catch {
      // Don't crash on log write failure
    }
  }
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => writeLog('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => writeLog('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => writeLog('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => writeLog('error', msg, meta)
};
