// Write tool: atomic file write

import { existsSync, readFileSync, statSync } from 'fs';
import { buildTool } from '../build-tool';
import { checkPathPolicy } from '../policy';
import { atomicWrite } from '../../utils/atomic-write';
import { setFileState, checkFileStaleness } from '../file-state';
import type { ToolDefinition } from '../types';

export const writeTool: ToolDefinition = buildTool({
  name: 'write',
  description: 'Write content to a file using atomic write (tmpfile + rename).',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
      content: { type: 'string', description: 'Content to write' },
      backup: { type: 'boolean', description: 'Create .bak backup of existing file (default false)' },
    },
    required: ['file_path', 'content'],
  },
  readonly: false,
  category: 'filesystem',

  async execute(input) {
    const filePath = input.file_path as string;
    const content = input.content as string;
    const backup = (input.backup as boolean) || false;

    const violation = checkPathPolicy('write', filePath);
    if (violation) {
      return { content: `Policy violation: ${violation.reason}`, isError: true };
    }

    // RFC-005 Layer 2: staleness check for existing files only.
    // 新文件（不存在）不走 check —— write 可以创建新文件无须先 read。
    if (existsSync(filePath)) {
      const currentContent = readFileSync(filePath, 'utf-8');
      const currentMtime = statSync(filePath).mtimeMs;
      const stalenessError = checkFileStaleness(filePath, currentContent, currentMtime);
      if (stalenessError) {
        return { content: stalenessError, isError: true };
      }
    }

    await atomicWrite(filePath, content, backup);

    // RFC-005 Layer 2: update file-state with written content.
    const newMtime = statSync(filePath).mtimeMs;
    setFileState(filePath, { content, mtimeMs: newMtime });

    return { content: `Wrote ${content.length} bytes to ${filePath}`, isError: false };
  },
});
