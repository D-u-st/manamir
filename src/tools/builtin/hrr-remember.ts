// hrr_remember tool: bind role/filler facts into a labeled HRR bundle
//
// Wraps HRRMemory.store(facts, label?) so the AI can persist composite facts
// for later compositional recall via hrr_recall. Persists to disk after each
// call (await save()) so a crash mid-conversation doesn't lose the binding.

import { buildTool } from '../build-tool';
import { HRRMemory } from '../../memory/hrr';
import type { ToolDefinition } from '../types';

let memory: HRRMemory | null = null;

/**
 * Initialize (or replace) the singleton HRRMemory instance shared by both
 * hrr_remember and hrr_recall. Safe to call multiple times — typically called
 * once at startup from the entry point.
 */
export function initHrrTool(opts: { dim?: number; storePath?: string } = {}): HRRMemory {
  memory = new HRRMemory({ dim: opts.dim ?? 512, storePath: opts.storePath });
  return memory;
}

/** Internal accessor — exported for the recall tool to share state. */
export function getHrrMemory(): HRRMemory | null {
  return memory;
}

interface FactInput {
  role: string;
  filler: string;
}

function normalizeFacts(raw: unknown): FactInput[] | string {
  if (!Array.isArray(raw)) return 'facts must be an array';
  if (raw.length === 0) return 'facts must contain at least one {role, filler} pair';
  const out: FactInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') return `facts[${i}] must be an object`;
    const role = item.role;
    const filler = item.filler;
    if (typeof role !== 'string' || !role.trim()) return `facts[${i}].role must be a non-empty string`;
    if (typeof filler !== 'string' || !filler.trim()) return `facts[${i}].filler must be a non-empty string`;
    out.push({ role, filler });
  }
  return out;
}

export const hrrRememberTool: ToolDefinition = buildTool({
  name: 'hrr_remember',
  description:
    'Bind a set of role/filler facts into a single algebraic memory bundle. ' +
    'Use this to remember structured facts you can later query compositionally with hrr_recall ' +
    '(e.g. {role: "name", filler: "xiaoming"}, {role: "city", filler: "shanghai"}). ' +
    'If you omit `label`, a UUID is generated and returned — keep it for later recall.',
  parameters: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description:
          'Optional bundle label (acts as a name handle for later recall). If omitted, a UUID is generated.',
      },
      facts: {
        type: 'array',
        description: 'Array of {role, filler} pairs to bind and bundle together.',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', description: 'The role/key (e.g. "name", "color")' },
            filler: { type: 'string', description: 'The value bound to the role (e.g. "xiaoming", "red")' },
          },
          required: ['role', 'filler'],
        },
      },
    },
    required: ['facts'],
  },
  readonly: false,
  category: 'system',

  async execute(input) {
    if (!memory) {
      return {
        content: 'HRR memory not initialized. Call initHrrTool() first.',
        isError: true,
      };
    }

    const labelInput = input.label;
    const label = typeof labelInput === 'string' && labelInput.trim().length > 0 ? labelInput : undefined;

    const factsResult = normalizeFacts(input.facts);
    if (typeof factsResult === 'string') {
      return { content: `Invalid input: ${factsResult}`, isError: true };
    }

    const finalLabel = memory.store(factsResult, label);

    try {
      await memory.save();
    } catch (err) {
      // Save failure is non-fatal for the in-memory result, but surface it.
      return {
        content: JSON.stringify({
          label: finalLabel,
          factsStored: factsResult.length,
          warning: `In-memory store succeeded, but persistence failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
        isError: false,
      };
    }

    return {
      content: JSON.stringify({ label: finalLabel, factsStored: factsResult.length }),
      isError: false,
    };
  },
});
