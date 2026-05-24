// Save Memory tool: lets the AI persist memories via the MemoryStore

import { buildTool } from '../build-tool';
import { MemoryStore } from '../../memory/store';
import type { MemoryType, Memory } from '../../memory/types';
import type { ToolDefinition } from '../types';

const VALID_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

const THREAT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, label: 'prompt injection' },
  { pattern: /you\s+are\s+now/i, label: 'prompt injection' },
  { pattern: /disregard\s+(all\s+)?(rules|instructions|guidelines)/i, label: 'prompt injection' },
  { pattern: /forget\s+(all\s+)?previous/i, label: 'prompt injection' },
  { pattern: /new\s+instructions?\s*:/i, label: 'prompt injection' },
  { pattern: /curl.*\$\{?(KEY|TOKEN|SECRET|PASSWORD|API_KEY)/i, label: 'exfiltration' },
  { pattern: /base64.*\.?env/i, label: 'exfiltration' },
  { pattern: /wget.*\$\{?(KEY|TOKEN|SECRET)/i, label: 'exfiltration' },
];

// Zero-width and directional override Unicode ranges
const INVISIBLE_UNICODE = /[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/;

function scanForThreats(content: string): string | null {
  for (const { pattern, label } of THREAT_PATTERNS) {
    if (pattern.test(content)) return label;
  }
  if (INVISIBLE_UNICODE.test(content)) return 'invisible unicode characters';
  return null;
}

// Lazily initialized store — config is injected via init()
let store: MemoryStore | null = null;

export function initMemoryTool(dataDir: string, maxMemoriesInPrompt = 5): void {
  store = new MemoryStore({ dataDir, maxMemoriesInPrompt });
}

export const saveMemoryTool: ToolDefinition = buildTool({
  name: 'save_memory',
  description: 'Save a persistent memory that will be available in future sessions. Use this to remember user preferences, project context, feedback, or reference information.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Unique name for this memory (used as filename stem)' },
      description: { type: 'string', description: 'One-line description for relevance matching' },
      type: { type: 'string', enum: VALID_TYPES, description: 'Memory category: user, feedback, project, or reference' },
      content: { type: 'string', description: 'The memory content (markdown)' }
    },
    required: ['name', 'description', 'type', 'content']
  },
  readonly: false,
  category: 'system',

  async execute(input) {
    const name = input.name as string;
    const description = input.description as string;
    const type = input.type as string;
    const content = input.content as string;

    if (!name || !description || !type || !content) {
      return { content: 'Missing required parameters: name, description, type, content', isError: true };
    }

    if (!VALID_TYPES.includes(type as MemoryType)) {
      return { content: `Invalid type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`, isError: true };
    }

    if (!store) {
      return { content: 'MemoryStore not initialized. Call initMemoryTool() first.', isError: true };
    }

    const threat = scanForThreats(content) || scanForThreats(name) || scanForThreats(description);
    if (threat) {
      return { content: `Memory blocked: detected ${threat} in content. This memory will not be saved.`, isError: true };
    }

    const now = Date.now();
    const memory: Memory = {
      name,
      description,
      type: type as MemoryType,
      content,
      createdAt: now,
      updatedAt: now
    };

    // If a memory with this name exists, preserve its createdAt
    const existing = store.get(name);
    if (existing) {
      memory.createdAt = existing.createdAt;
    }

    store.save(memory);

    return {
      content: `Memory saved: "${name}" (${type})${existing ? ' [updated]' : ' [new]'}`,
      isError: false
    };
  }
});
