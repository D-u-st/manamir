// Read tool: read file contents with line numbers + dedup/modification detection

import { readFileSync, existsSync, statSync } from 'fs';
import { setFileState } from '../file-state';
import { createHash } from 'crypto';
import { buildTool } from '../build-tool';
import { checkPathPolicy } from '../policy';
import { log } from '../../utils/logger';
import type { ToolDefinition } from '../types';

interface ReadRecord {
  mtimeMs: number;
  contentHash: string;
}

const readTracker = new Map<string, ReadRecord>();
const consecutiveReadCount = new Map<string, number>();

const MAX_CONSECUTIVE_READS = 4;
const WARN_CONSECUTIVE_READS = 3;

function readKey(path: string, offset: number, limit: number | undefined): string {
  return `${path}:${offset}:${limit ?? 'all'}`;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function resetReadTracker(): void {
  readTracker.clear();
  consecutiveReadCount.clear();
}

export function notifyFileWrite(filePath: string): void {
  for (const key of readTracker.keys()) {
    if (key.startsWith(filePath + ':')) {
      readTracker.delete(key);
    }
  }
  consecutiveReadCount.delete(filePath);
}

export const readTool: ToolDefinition = buildTool({
  name: 'read',
  description: 'Read a file and return its contents with line numbers.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
      offset: { type: 'number', description: 'Starting line number (0-based, default 0)' },
      limit: { type: 'number', description: 'Number of lines to read (default: all)' },
    },
    required: ['file_path'],
  },
  readonly: true,
  category: 'filesystem',

  async execute(input) {
    const filePath = input.file_path as string;
    const offset = (input.offset as number) || 0;
    const limit = input.limit as number | undefined;

    const violation = checkPathPolicy('read', filePath);
    if (violation) {
      return { content: `Policy violation: ${violation.reason}`, isError: true };
    }

    if (!existsSync(filePath)) {
      return { content: `File not found: ${filePath}`, isError: true };
    }

    const stat = statSync(filePath);
    const key = readKey(filePath, offset, limit);

    const prevRecord = readTracker.get(key);
    if (prevRecord && prevRecord.mtimeMs === stat.mtimeMs) {
      const count = (consecutiveReadCount.get(filePath) ?? 0) + 1;
      consecutiveReadCount.set(filePath, count);

      if (count >= MAX_CONSECUTIVE_READS) {
        log.warn('ReadTool: blocked consecutive identical read', { filePath, count });
        return {
          content: `[Blocked: file "${filePath}" has been read ${count} times with no changes. Modify the file or try a different approach.]`,
          isError: true
        };
      }

      if (count >= WARN_CONSECUTIVE_READS) {
        log.warn('ReadTool: consecutive identical read warning', { filePath, count });
        return {
          content: `[File unchanged since last read — ${filePath}. Read count: ${count}/${MAX_CONSECUTIVE_READS} before block.]`,
          isError: false
        };
      }

      return {
        content: '[File unchanged since last read]',
        isError: false
      };
    }

    if (prevRecord && prevRecord.mtimeMs !== stat.mtimeMs) {
      log.info('ReadTool: file modified externally since last read', { filePath });
    }

    const raw = readFileSync(filePath, 'utf-8');
    const hash = hashContent(raw);

    readTracker.set(key, { mtimeMs: stat.mtimeMs, contentHash: hash });
    consecutiveReadCount.set(filePath, 0);

    // RFC-005 Layer 2: track full content + mtime so edit/write can verify staleness.
    setFileState(filePath, {
      content: raw,
      mtimeMs: stat.mtimeMs,
      offset: offset > 0 ? offset : undefined,
      limit,
    });

    let lines = raw.split('\n');

    if (offset > 0) {
      lines = lines.slice(offset);
    }
    if (limit !== undefined && limit > 0) {
      lines = lines.slice(0, limit);
    }

    const numbered = lines.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');

    let prefix = '';
    if (prevRecord && prevRecord.mtimeMs !== stat.mtimeMs) {
      prefix = '[Warning: file was modified externally since your last read]\n';
    }

    return { content: prefix + numbered, isError: false };
  },
});
