// skill_info: usage stats + version + trust info for a skill.

import { buildTool } from '../build-tool';
import type { ToolDefinition } from '../types';
import { findSkillByName } from '../../skills/discovery';
import { resolveCreatedBy, resolveTrust } from '../../skills/trust';
import { listSkillRefs } from '../../skills/chain';

export const skillInfoTool: ToolDefinition = buildTool({
  name: 'skill_info',
  description:
    'Return metadata about a skill: name, version, source, trust, created/updated timestamps, ' +
    'use_count, last_used_at, allowed/forbidden tools, chain references.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name.' },
    },
    required: ['name'],
  },
  readonly: true,
  category: 'system',

  async execute(input) {
    const name = input.name as string;
    if (!name) return { content: 'name is required.', isError: true };

    const raw = findSkillByName(name);
    if (!raw) return { content: `Skill '${name}' not found.`, isError: true };

    const fm = raw.frontmatter;
    const trust = resolveTrust(fm, raw.source);
    const createdBy = resolveCreatedBy(fm, raw.source);
    const refs = listSkillRefs(raw.body);

    const info = {
      name: fm.name,
      description: fm.description,
      version: fm.version ?? null,
      source: raw.source,
      trust,
      created_by: createdBy,
      created_at: fm.created_at ?? null,
      updated_at: fm.updated_at ?? null,
      use_count: fm.use_count ?? 0,
      last_used_at: fm.last_used_at ?? null,
      tags: fm.tags ?? [],
      category: fm.category ?? null,
      allowed_tools: fm.allowed_tools ?? null,
      forbidden_tools: fm.forbidden_tools ?? null,
      content_hash: fm.content_hash ?? null,
      body_chars: raw.body.length,
      chain_refs: refs,
      directory: raw.directoryPath,
    };
    return { content: JSON.stringify(info, null, 2), isError: false };
  },
});
