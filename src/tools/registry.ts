// Tool Registry: register, lookup, and export tools for OpenAI function calling

import type { ToolDefinition, ToolCategory } from './types';

const tools = new Map<string, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  if (tools.has(def.name)) {
    throw new Error(`Tool '${def.name}' is already registered`);
  }
  tools.set(def.name, def);
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

export function getAllTools(): ToolDefinition[] {
  return Array.from(tools.values());
}

/** Essential tools: always included on first turn to minimize token usage */
const ESSENTIAL_TOOL_NAMES = ['bash', 'read'];

export function getToolsByCategory(category: ToolCategory): ToolDefinition[] {
  return getAllTools().filter((t) => t.category === category);
}

export function getEssentialTools(): ToolDefinition[] {
  return ESSENTIAL_TOOL_NAMES
    .map((name) => tools.get(name))
    .filter((t): t is ToolDefinition => t !== undefined);
}

type FunctionDef = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/**
 * Export tools as OpenAI-compatible function definitions.
 * Format: [{ type: "function", function: { name, description, parameters } }]
 */
export function toFunctionDefinitions(): FunctionDef[] {
  return getAllTools().map(toFuncDef);
}

/** Export only the specified tools as function definitions */
export function toFunctionDefinitionsFiltered(names: string[]): FunctionDef[] {
  const nameSet = new Set(names);
  return getAllTools()
    .filter((t) => nameSet.has(t.name))
    .map(toFuncDef);
}

function toFuncDef(tool: ToolDefinition): FunctionDef {
  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
