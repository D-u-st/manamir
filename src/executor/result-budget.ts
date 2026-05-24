// Tool Result 3-Layer Budget (P0-2D): prevent context explosion from tool outputs

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { log } from '../utils/logger';

const PER_TOOL_MAX_CHARS = 100_000;
const PER_TURN_MAX_CHARS = 200_000;
const PREVIEW_CHARS = 1_500;
const SPILL_DIR = join(process.cwd(), 'data', 'tool-results');

interface BudgetResult {
  content: string;
  spilled: boolean;
  spillPath?: string;
}

function generatePreview(content: string): string {
  if (content.length <= PREVIEW_CHARS) return content;
  const truncated = content.slice(0, PREVIEW_CHARS);
  const lastNewline = truncated.lastIndexOf('\n');
  const cutPoint = lastNewline > PREVIEW_CHARS * 0.5 ? lastNewline : PREVIEW_CHARS;
  return truncated.slice(0, cutPoint) + `\n\n[...truncated, ${content.length} chars total]`;
}

function spillToDisk(content: string, toolName: string): string {
  if (!existsSync(SPILL_DIR)) {
    mkdirSync(SPILL_DIR, { recursive: true });
  }
  const id = `${toolName}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const filePath = join(SPILL_DIR, `${id}.txt`);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

export function applyPerToolBudget(content: string, toolName: string): BudgetResult {
  if (content.length <= PER_TOOL_MAX_CHARS) {
    return { content, spilled: false };
  }

  log.info('ResultBudget: per-tool limit exceeded, spilling to disk', {
    tool: toolName,
    chars: content.length,
    limit: PER_TOOL_MAX_CHARS
  });

  const spillPath = spillToDisk(content, toolName);
  const preview = generatePreview(content);
  return {
    content: `${preview}\n\n[Full result spilled to: ${spillPath}]`,
    spilled: true,
    spillPath
  };
}

export interface TurnBudgetEntry {
  toolName: string;
  content: string;
  originalLength: number;
}

export function applyTurnBudget(results: TurnBudgetEntry[]): TurnBudgetEntry[] {
  const totalChars = results.reduce((sum, r) => sum + r.content.length, 0);
  if (totalChars <= PER_TURN_MAX_CHARS) {
    return results;
  }

  log.info('ResultBudget: per-turn limit exceeded, spilling largest results', {
    totalChars,
    limit: PER_TURN_MAX_CHARS,
    resultCount: results.length
  });

  const indexed = results.map((r, i) => ({ ...r, index: i }));
  indexed.sort((a, b) => b.content.length - a.content.length);

  let currentTotal = totalChars;

  for (const entry of indexed) {
    if (currentTotal <= PER_TURN_MAX_CHARS) break;
    if (entry.content.length <= PREVIEW_CHARS) continue;

    const spillPath = spillToDisk(entry.content, entry.toolName);
    const preview = generatePreview(entry.content);
    const newContent = `${preview}\n\n[Full result spilled to: ${spillPath}]`;

    currentTotal -= entry.content.length - newContent.length;
    results[entry.index] = {
      ...results[entry.index],
      content: newContent
    };
  }

  return results;
}
