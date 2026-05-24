// Tool system types (P-08)

export type ToolCategory = 'filesystem' | 'search' | 'system' | 'web';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema for OpenAI function calling
  readonly: boolean; // true = can run concurrently (P-07)
  category: ToolCategory;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface ToolOptions {
  timeoutMs?: number; // default 30_000
}
