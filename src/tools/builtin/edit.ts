// Edit tool: precise string replacement in files

import { readFileSync, existsSync, statSync } from 'fs';
import { buildTool } from '../build-tool';
import { checkPathPolicy } from '../policy';
import { atomicWrite } from '../../utils/atomic-write';
import { setFileState, checkFileStaleness } from '../file-state';
import type { ToolDefinition } from '../types';

export const editTool: ToolDefinition = buildTool({
  name: 'edit',
  description: 'Replace an exact string in a file. Fails if old_string is not found or is ambiguous (found multiple times without replace_all).',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
      old_string: { type: 'string', description: 'Exact text to find and replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' }
    },
    required: ['file_path', 'old_string', 'new_string']
  },
  readonly: false,
  category: 'filesystem',

  async execute(input) {
    const filePath = input.file_path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) || false;

    const violation = checkPathPolicy('edit', filePath);
    if (violation) {
      return { content: `Policy violation: ${violation.reason}`, isError: true };
    }

    if (!existsSync(filePath)) {
      return { content: `File not found: ${filePath}`, isError: true };
    }

    const content = readFileSync(filePath, 'utf-8');

    // RFC-005 Layer 2: staleness check (拒绝 edit 没 read 过 / 已被外部改的文件)
    const currentMtime = statSync(filePath).mtimeMs;
    const stalenessError = checkFileStaleness(filePath, content, currentMtime);
    if (stalenessError) {
      return { content: stalenessError, isError: true };
    }

    // Count occurrences
    let count = 0;
    let searchPos = 0;
    while (true) {
      const idx = content.indexOf(oldString, searchPos);
      if (idx === -1) break;
      count++;
      searchPos = idx + oldString.length;
    }

    if (count === 0) {
      return { content: 'old_string not found in file', isError: true };
    }

    if (count > 1 && !replaceAll) {
      return {
        content: `old_string found ${count} times, use replace_all or provide more context`,
        isError: true
      };
    }

    // Find line numbers of matches for the summary
    const affectedLines: number[] = [];
    let searchStart = 0;
    while (true) {
        const idx = content.indexOf(oldString, searchStart);
        if (idx === -1) break;
        const lineNum = content.substring(0, idx).split('\n').length;
        if (!affectedLines.includes(lineNum)) {
            affectedLines.push(lineNum);
        }
        searchStart = idx + oldString.length;
        if (!replaceAll) break;
    }

    // Perform replacement
    let updated: string;
    if (replaceAll) {
      updated = content.split(oldString).join(newString);
    } else {
      const idx = content.indexOf(oldString);
      updated = content.substring(0, idx) + newString + content.substring(idx + oldString.length);
    }

    await atomicWrite(filePath, updated);

    // RFC-005 Layer 2: update file-state with post-edit content so subsequent
    // edits in the same turn don't need a re-read.
    const newMtime = statSync(filePath).mtimeMs;
    setFileState(filePath, { content: updated, mtimeMs: newMtime });

    const lineInfo = affectedLines.length > 0
      ? ` (around line${affectedLines.length > 1 ? 's' : ''} ${affectedLines.join(', ')})`
      : '';
    return {
      content: `Replaced ${count} occurrence${count > 1 ? 's' : ''} in ${filePath}${lineInfo}`,
      isError: false
    };
  }
});
