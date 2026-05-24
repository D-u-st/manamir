// Search tool: simplified file content search

import { readdirSync, readFileSync } from 'fs';
import { join, relative, extname } from 'path';
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
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkDir(full, results);
    } else {
      results.push(full);
    }
  }
  return results;
}

function matchGlob(pattern: string, filePath: string): boolean {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(filePath);
}

export const searchTool: ToolDefinition = buildTool({
  name: 'search',
  description: 'Search file contents for a text query. Simpler than grep — does case-insensitive literal matching by default.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to search for' },
      path: { type: 'string', description: 'Directory to search in (default: cwd)' },
      file_pattern: { type: 'string', description: 'Glob filter like "*.ts" or "**/*.js"' },
      max_results: { type: 'number', description: 'Max matching lines to return (default 50)' }
    },
    required: ['query']
  },
  readonly: true,
  category: 'search',

  async execute(input) {
    const query = (input.query as string).toLowerCase();
    const rootDir = (input.path as string) || process.cwd();
    const filePattern = input.file_pattern as string | undefined;
    const maxResults = (input.max_results as number) || 50;

    const allFiles = walkDir(rootDir);
    const matches: string[] = [];

    for (const filePath of allFiles) {
      if (filePattern) {
        const rel = relative(rootDir, filePath).replace(/\\/g, '/');
        if (!matchGlob(filePattern, rel)) continue;
      }

      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      const rel = relative(rootDir, filePath).replace(/\\/g, '/');

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(query)) {
          matches.push(`${rel}:${i + 1}: ${lines[i]}`);
          if (matches.length >= maxResults) break;
        }
      }

      if (matches.length >= maxResults) break;
    }

    if (matches.length === 0) {
      return { content: 'No matches found.', isError: false };
    }

    const header = matches.length >= maxResults
      ? `Showing first ${maxResults} matches:\n`
      : `Found ${matches.length} match${matches.length > 1 ? 'es' : ''}:\n`;

    return { content: header + matches.join('\n'), isError: false };
  }
});
