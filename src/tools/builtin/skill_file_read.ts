// skill_file_read: read a supporting file inside a skill directory.
// Path-traversal protected (must resolve under references/, templates/, scripts/, assets/).

import { buildTool } from '../build-tool';
import type { ToolDefinition } from '../types';
import { readSkillFile } from '../../skills/registry';

export const skillFileReadTool: ToolDefinition = buildTool({
  name: 'skill_file_read',
  description:
    'Read a supporting file inside a skill directory. ' +
    'file_path must live under references/, templates/, scripts/, or assets/. ' +
    'Path traversal (..) and absolute paths are rejected.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name.' },
      file_path: {
        type: 'string',
        description: 'Path under references/, templates/, scripts/, or assets/',
      },
    },
    required: ['name', 'file_path'],
  },
  readonly: true,
  category: 'system',

  async execute(input) {
    const name = input.name as string;
    const filePath = input.file_path as string;
    if (!name) return { content: 'name is required.', isError: true };
    if (!filePath) return { content: 'file_path is required.', isError: true };
    const result = readSkillFile(name, filePath);
    if (result.error) return { content: result.error, isError: true };
    return { content: result.content, isError: false };
  },
});
