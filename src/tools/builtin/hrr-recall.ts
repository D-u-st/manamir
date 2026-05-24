// hrr_recall tool: query an HRR bundle by role to recover the bound filler(s)
//
// Wraps HRRMemory.query(label, role, topK) and returns the top hits ranked by
// cosine similarity. Shares the singleton HRRMemory created via initHrrTool.

import { buildTool } from '../build-tool';
import { getHrrMemory } from './hrr-remember';
import type { ToolDefinition } from '../types';

export const hrrRecallTool: ToolDefinition = buildTool({
  name: 'hrr_recall',
  description:
    'Query a previously stored HRR bundle by role to recover the bound filler. ' +
    'Returns the top-K matching symbol names ranked by cosine similarity. ' +
    'Use this after hrr_remember to retrieve facts you bound earlier ' +
    '(e.g. label="person1", role="name" → recovers "xiaoming").',
  parameters: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: 'The bundle label returned by hrr_remember.',
      },
      role: {
        type: 'string',
        description: 'The role/key to unbind (e.g. "name", "color", "city").',
      },
      topK: {
        type: 'number',
        description: 'How many top hits to return (default 3).',
      },
    },
    required: ['label', 'role'],
  },
  readonly: true,
  category: 'system',

  async execute(input) {
    const memory = getHrrMemory();
    if (!memory) {
      return {
        content: 'HRR memory not initialized. Call initHrrTool() first.',
        isError: true,
      };
    }

    const label = typeof input.label === 'string' ? input.label : '';
    const role = typeof input.role === 'string' ? input.role : '';
    if (!label.trim()) {
      return { content: 'Invalid input: label must be a non-empty string', isError: true };
    }
    if (!role.trim()) {
      return { content: 'Invalid input: role must be a non-empty string', isError: true };
    }

    const topKRaw = input.topK;
    const topK = typeof topKRaw === 'number' && topKRaw > 0 ? Math.floor(topKRaw) : 3;

    const hits = memory.query(label, role, topK);

    return {
      content: JSON.stringify({ hits }),
      isError: false,
    };
  },
});
