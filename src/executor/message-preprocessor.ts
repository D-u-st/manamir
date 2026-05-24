// Message preprocessing pipeline — thin wrapper over context-compressor.
// Kept for backward compatibility. New code should use context-compressor directly.

import { compressSync } from './context-compressor';
import { MAX_CONTEXT_TOKENS } from './token-budget';

interface Message {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/**
 * Full preprocessing pipeline. Call this before sending messages to the API.
 * Returns a new array — does not mutate the input.
 *
 * Delegates to context-compressor's synchronous mode (no LLM summary).
 */
export function preprocessMessages(messages: Message[]): Message[] {
  const result = compressSync(messages, MAX_CONTEXT_TOKENS);
  return result.messages;
}
