// buildTool factory (P-08): wraps execution with timeout + error catching + logging

import { log } from '../utils/logger';
import type { ToolDefinition, ToolResult, ToolOptions } from './types';

const DEFAULT_TIMEOUT_MS = 30_000;

export function buildTool(
  def: Omit<ToolDefinition, 'execute'> & {
    execute(input: Record<string, unknown>): Promise<ToolResult>;
  },
  options: ToolOptions = {}
): ToolDefinition {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    readonly: def.readonly,
    category: def.category,

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const start = performance.now();

      try {
        const result = await Promise.race([
          def.execute(input),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Tool '${def.name}' timed out after ${timeoutMs}ms`)), timeoutMs)
          ),
        ]);

        const durationMs = Math.round(performance.now() - start);
        log.debug(`Tool ${def.name} completed`, { durationMs, isError: result.isError });

        return result;
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        const message = err instanceof Error ? err.message : String(err);

        log.error(`Tool ${def.name} failed`, { durationMs, error: message });

        return { content: `Error: ${message}`, isError: true };
      }
    },
  };
}
