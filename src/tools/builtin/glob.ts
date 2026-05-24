// Glob tool: find files by pattern using recursive directory walk

import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { buildTool } from '../build-tool';
import type { ToolDefinition } from '../types';

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
      // Skip common noise directories
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkDir(full, results);
    } else {
      results.push(full);
    }
  }
  return results;
}

function matchGlob(pattern: string, filePath: string): boolean {
  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filePath);
}

export const globTool: ToolDefinition = buildTool({
  name: 'glob',
  description: 'Find files matching a glob pattern in a directory.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.js")' },
      path: { type: 'string', description: 'Root directory to search (default: cwd)' },
    },
    required: ['pattern'],
  },
  readonly: true,
  category: 'search',

  async execute(input) {
    const pattern = input.pattern as string;
    const rootDir = (input.path as string) || process.cwd();

    const allFiles = walkDir(rootDir);
    const matched = allFiles
      .filter((f) => {
        const rel = relative(rootDir, f).replace(/\\/g, '/');
        return matchGlob(pattern, rel);
      })
      .sort();

    if (matched.length === 0) {
      return { content: 'No files matched.', isError: false };
    }

    return { content: matched.join('\n'), isError: false };
  },
});
