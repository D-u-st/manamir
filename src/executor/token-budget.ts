// Token counting and budgeting for DeepSeek API calls.
// Uses a simple characters/4 heuristic — fast, no dependencies.

/** DeepSeek chat has 64K context; leave headroom for output + tool defs */
export const MAX_CONTEXT_TOKENS = 30_000;

interface Message {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
}

/** Estimate token count for a single string */
export function estimateStringTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Estimate total tokens across an array of chat messages */
export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    // Role overhead (~4 tokens per message for role/formatting)
    total += 4;
    if (msg.content) {
      total += estimateStringTokens(msg.content);
    }
    if (msg.tool_calls) {
      total += estimateStringTokens(JSON.stringify(msg.tool_calls));
    }
  }
  return total;
}

/** Check whether the messages exceed the token budget */
export function isOverBudget(messages: Message[], maxTokens: number = MAX_CONTEXT_TOKENS): boolean {
  return estimateTokens(messages) > maxTokens;
}
