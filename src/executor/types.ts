// Stream JSON event types from `claude --print --output-format stream-json`
// NDJSON: one JSON object per line

export interface StreamEventInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools?: string[];
}

export interface StreamEventText {
  type: 'assistant';
  subtype: 'text';
  text: string;
}

export interface StreamEventToolUse {
  type: 'assistant';
  subtype: 'tool_use';
  tool: string;
  input: Record<string, unknown>;
}

export interface StreamEventToolResult {
  type: 'tool';
  subtype: 'result';
  tool: string;
  content: string;
  is_error?: boolean;
}

export interface StreamEventResult {
  type: 'result';
  subtype: 'success' | 'error';
  result: string;
  session_id: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  is_error?: boolean;
}

export type StreamEvent =
  | StreamEventInit
  | StreamEventText
  | StreamEventToolUse
  | StreamEventToolResult
  | StreamEventResult;

// OpenAI-compatible function tool definition
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// Callback to execute a tool by name
export type ToolExecutorFn = (
  name: string,
  args: Record<string, unknown>
) => Promise<{ content: string; isError: boolean }>;

// Executor callback events
//
// `toolCallId` is the executor-issued identifier for a single tool invocation
// (e.g. OpenAI/DeepSeek's `tool_calls[i].id`). When the executor emits parallel
// tool_calls of the same tool name in one turn, observers that match purely by
// name + arrival order can mis-pair use/result events under any race. The id
// makes that pairing deterministic.
//
// The id is OPTIONAL on both signatures so backends that don't natively
// produce one (e.g. AuthExecutor / Claude CLI streams) and existing observers
// that don't need it remain source-compatible. Observers should fall back to
// FIFO-by-tool-name when id is undefined.
export interface ExecutorCallbacks {
  onText?: (text: string) => void;         // streaming text chunk
  onThinking?: (text: string) => void;     // DeepSeek R1 reasoning
  onToolUse?: (tool: string, input: Record<string, unknown>, toolCallId?: string) => void;
  onToolResult?: (tool: string, content: string, isError: boolean, toolCallId?: string) => void;
  onComplete?: (result: StreamEventResult) => void;
  onError?: (error: Error) => void;
}
