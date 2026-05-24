// skill_view: tier-aware view tool.
//
//   default (tier 2): frontmatter + first 1000 chars of body + supporting file list
//   full=true (tier 3): full frontmatter + full body + supporting file list
//   file_path provided: load a specific supporting file under references/, templates/,
//     scripts/, or assets/ (tier 3 supporting-file read)

import { buildTool } from '../build-tool';
import type { ToolDefinition } from '../types';
import { readSkillFile, viewSkillTier2, viewSkillTier3 } from '../../skills/registry';
import { serializeFrontmatter } from '../../skills/frontmatter';
import { resolveChain } from '../../skills/chain';
import { findSkillByName } from '../../skills/discovery';

export const skillViewTool: ToolDefinition = buildTool({
  name: 'skill_view',
  description:
    'View a skill. Default (tier 2) returns frontmatter + first 1000 chars + file list. ' +
    'Pass full=true (tier 3) for the complete body. ' +
    'Pass file_path to read a supporting file inside the skill (references/, templates/, scripts/, assets/).',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name.' },
      full: { type: 'boolean', description: 'If true, return full body (tier 3).' },
      file_path: {
        type: 'string',
        description: 'Optional supporting file path within the skill.',
      },
      resolve_chain: {
        type: 'boolean',
        description: 'If true, expand {{skill:other}} references in the body (tier 3 only).',
      },
    },
    required: ['name'],
  },
  readonly: true,
  category: 'system',

  async execute(input) {
    const name = input.name as string;
    const filePath = input.file_path as string | undefined;
    const full = Boolean(input.full);
    const wantChain = Boolean(input.resolve_chain);

    if (!name) return { content: 'name is required.', isError: true };

    if (filePath) {
      const result = readSkillFile(name, filePath);
      if (result.error) return { content: result.error, isError: true };
      return { content: result.content, isError: false };
    }

    if (full) {
      const view = viewSkillTier3(name);
      if (!view) return { content: `Skill '${name}' not found.`, isError: true };
      let body = view.body;
      let chainNote = '';
      if (wantChain) {
        const resolution = resolveChain(body, (n) => {
          if (n === name) return null;
          const inner = findSkillByName(n);
          return inner ? inner.body : null;
        }, name);
        body = resolution.body;
        const notes: string[] = [];
        if (resolution.expandedRefs.length) notes.push(`expanded: ${resolution.expandedRefs.join(', ')}`);
        if (resolution.missingRefs.length) notes.push(`missing: ${resolution.missingRefs.join(', ')}`);
        if (resolution.cyclesDetected.length) notes.push(`cycles: ${resolution.cyclesDetected.join(', ')}`);
        if (resolution.depthExceeded.length) notes.push(`depth-exceeded: ${resolution.depthExceeded.join(', ')}`);
        if (notes.length) chainNote = `\n\n[chain: ${notes.join('; ')}]`;
      }
      const rendered = serializeFrontmatter(view.frontmatter, body);
      const filesNote = view.files.length
        ? `\n\n[Supporting files: ${view.files.join(', ')}]`
        : '';
      const sourceNote = `\n\n[Source: ${view.source}]`;
      return {
        content: rendered + filesNote + sourceNote + chainNote,
        isError: false,
      };
    }

    const view = viewSkillTier2(name);
    if (!view) return { content: `Skill '${name}' not found.`, isError: true };
    const truncatedNote = view.truncated
      ? `\n\n[Body truncated to first 1000 chars; use skill_view full=true or skill_open for complete body.]`
      : '';
    const filesNote = view.files.length
      ? `\n\n[Supporting files: ${view.files.join(', ')}]`
      : '';
    const sourceNote = `\n\n[Source: ${view.source}]`;
    const rendered = serializeFrontmatter(view.frontmatter, view.preview);
    return {
      content: rendered + truncatedNote + filesNote + sourceNote,
      isError: false,
    };
  },
});
