// Grep tool: search file contents by regex

import { readdirSync, readFileSync } from 'fs';
import { join, relative, extname } from 'path';
import { buildTool } from '../build-tool';
import type { ToolDefinition } from '../types';

const TYPE_EXTENSIONS: Record<string, string[]> = {
  ts: ['.ts', '.tsx'],
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  py: ['.py'],
  java: ['.java'],
  json: ['.json'],
  md: ['.md'],
  yaml: ['.yaml', '.yml'],
  rust: ['.rs'],
  go: ['.go'],
};

function walkDir(dir: string, results: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkDir(full, results);
    } else {
      results.push(full);
    }
  }
  return results;
}

export const grepTool: ToolDefinition = buildTool({
  name: 'grep',
  description: 'Search file contents using a regex pattern. Returns matching lines with file path and line number.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in (default: cwd)' },
      type: { type: 'string', description: 'File type filter (e.g., "ts", "js", "py")' },
      ignore_case: { type: 'boolean', description: 'Case insensitive search (default false)' },
      max_results: { type: 'number', description: 'Max matching lines to return (default 100)' },
    },
    required: ['pattern'],
  },
  readonly: true,
  category: 'search',

  async execute(input) {
    const patternStr = input.pattern as string;
    const rootDir = (input.path as string) || process.cwd();
    const fileType = input.type as string | undefined;
    const ignoreCase = (input.ignore_case as boolean) || false;
    const maxResults = (input.max_results as number) || 100;

    let regex: RegExp;
    try {
      regex = new RegExp(patternStr, ignoreCase ? 'i' : '');
    } catch (e) {
      return { content: `Invalid regex: ${patternStr}`, isError: true };
    }

    const allowedExts = fileType ? TYPE_EXTENSIONS[fileType] : null;
    const allFiles = walkDir(rootDir);
    const matches: string[] = [];

    for (const filePath of allFiles) {
      if (allowedExts && !allowedExts.includes(extname(filePath))) continue;

      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      const rel = relative(rootDir, filePath).replace(/\\/g, '/');

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i]}`);
          if (matches.length >= maxResults) break;
        }
      }

      if (matches.length >= maxResults) break;
    }

    if (matches.length === 0) {
      return { content: 'No matches found.', isError: false };
    }

    return { content: matches.join('\n'), isError: false };
  },
});
