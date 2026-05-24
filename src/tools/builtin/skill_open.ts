// skill_open: tier-3 dedicated tool. Returns full SKILL.md, expands chain
// references by default, bumps usage stats.

import { buildTool } from '../build-tool';
import type { ToolDefinition } from '../types';
import { viewSkillTier3 } from '../../skills/registry';
import { serializeFrontmatter } from '../../skills/frontmatter';
import { resolveChain } from '../../skills/chain';
import { findSkillByName } from '../../skills/discovery';
import { bumpSkillUsage } from '../../skills/store';

export const skillOpenTool: ToolDefinition = buildTool({
  name: 'skill_open',
  description:
    'Open a skill at tier 3 (full body). Recursively expands {{skill:name}} chain references ' +
    '(max depth 3). Bumps the skill usage counter. Use this when you commit to executing the skill.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name.' },
      no_chain: {
        type: 'boolean',
        description: 'Disable chain expansion (default false → expansion is on).',
      },
    },
    required: ['name'],
  },
  readonly: false,
  category: 'system',

  async execute(input) {
    const name = input.name as string;
    if (!name) return { content: 'name is required.', isError: true };
    const noChain = Boolean(input.no_chain);

    const view = viewSkillTier3(name);
    if (!view) return { content: `Skill '${name}' not found.`, isError: true };

    let body = view.body;
    let chainNote = '';
    if (!noChain) {
      const resolution = resolveChain(
        body,
        (n) => {
          if (n === name) return null;
          const inner = findSkillByName(n);
          return inner ? inner.body : null;
        },
        name
      );
      body = resolution.body;
      const notes: string[] = [];
      if (resolution.expandedRefs.length) notes.push(`expanded: ${resolution.expandedRefs.join(', ')}`);
      if (resolution.missingRefs.length) notes.push(`missing: ${resolution.missingRefs.join(', ')}`);
      if (resolution.cyclesDetected.length) notes.push(`cycles: ${resolution.cyclesDetected.join(', ')}`);
      if (resolution.depthExceeded.length) notes.push(`depth-exceeded: ${resolution.depthExceeded.join(', ')}`);
      if (notes.length) chainNote = `\n\n[chain: ${notes.join('; ')}]`;
    }

    // Best-effort usage bump
    void bumpSkillUsage(name);

    const rendered = serializeFrontmatter(view.frontmatter, body);
    const filesNote = view.files.length
      ? `\n\n[Supporting files: ${view.files.join(', ')}]`
      : '';
    const sourceNote = `\n\n[Source: ${view.source}]`;
    return { content: rendered + filesNote + sourceNote + chainNote, isError: false };
  },
});
