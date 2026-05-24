// skills_list: tier-1 listing — name + description + category for all discoverable skills.
// Optional category filter (substring match, case-insensitive).

import { buildTool } from '../build-tool';
import type { ToolDefinition } from '../types';
import { listSkillsTier1 } from '../../skills/registry';

export const skillsListTool: ToolDefinition = buildTool({
  name: 'skills_list',
  description:
    'List all discoverable skills across project (.claude/skills), user (~/.claude/skills), legacy ' +
    '(~/.manamir/skills), and bundled locations. Returns name + description + category + source. ' +
    'Use skill_view (tier 2) to peek and skill_open (tier 3) to load the full body.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Optional category substring filter (case-insensitive).',
      },
      tag: {
        type: 'string',
        description: 'Optional tag exact-match filter.',
      },
    },
    required: [],
  },
  readonly: true,
  category: 'system',

  async execute(input) {
    const category = (input.category as string | undefined)?.toLowerCase();
    const tag = input.tag as string | undefined;

    let skills = listSkillsTier1();
    if (category) {
      skills = skills.filter((s) => (s.category ?? '').toLowerCase().includes(category));
    }
    if (tag) {
      skills = skills.filter((s) => (s.tags ?? []).includes(tag));
    }

    if (!skills.length) {
      return { content: 'No skills installed.', isError: false };
    }
    const lines = skills.map((s) => {
      const cat = s.category ? ` [${s.category}]` : '';
      const src = s.source ? ` (${s.source})` : '';
      return `- ${s.name}${cat}${src}: ${s.description}`;
    });
    return { content: lines.join('\n'), isError: false };
  },
});
