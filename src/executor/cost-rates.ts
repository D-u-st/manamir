// Per-model cost rates ($ per 1M tokens). Add new models as needed.
//
// Rates are stored in dollars per million tokens because:
//   1. That matches every public pricing page (DeepSeek, OpenAI, Anthropic)
//   2. We avoid floating-point dust when summing per-call charges
//
// Lookup is prefix-based (longest-key wins) so e.g. "deepseek-chat-v3" picks
// up the "deepseek-chat" rate.

export interface ModelRate {
  /** USD per 1M input tokens */
  inputPerMillion: number;
  /** USD per 1M output tokens */
  outputPerMillion: number;
  /** Optional extra per-call charge (e.g. tool-use surcharge). 0 default. */
  perCall?: number;
}

export const MODEL_RATES: Record<string, ModelRate> = {
  'deepseek-chat': { inputPerMillion: 0.27, outputPerMillion: 1.10 },
  'deepseek-reasoner': { inputPerMillion: 0.55, outputPerMillion: 2.19 },
  'claude-sonnet-4-6': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-sonnet-4-7': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-sonnet': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-opus-4-7': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-opus-4-6': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-opus': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'gpt-4o': { inputPerMillion: 2.50, outputPerMillion: 10.00 },
  'gpt-4': { inputPerMillion: 30.00, outputPerMillion: 60.00 },
  'gpt-3.5': { inputPerMillion: 0.50, outputPerMillion: 1.50 },
  'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00 },
  'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.30 },
  'o1': { inputPerMillion: 15.00, outputPerMillion: 60.00 },
  'o3': { inputPerMillion: 60.00, outputPerMillion: 240.00 }
};

/** Fallback when no entry matches. */
export const DEFAULT_RATE: ModelRate = {
  inputPerMillion: 1.00,
  outputPerMillion: 3.00
};

/** USD-to-CNY rough multiplier for display only. */
export const USD_TO_CNY = 7.25;

/**
 * Look up the rate for a model name. Exact match wins, then longest-prefix
 * match, then DEFAULT_RATE.
 */
export function getRate(model: string): ModelRate {
  if (MODEL_RATES[model]) return MODEL_RATES[model];
  let best: string | null = null;
  for (const key of Object.keys(MODEL_RATES)) {
    if (model.startsWith(key) || model.includes(key)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? MODEL_RATES[best] : DEFAULT_RATE;
}

/**
 * Compute USD cost for a single API call. Returns 0 if both token counts are
 * zero or negative.
 */
export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  if (inputTokens <= 0 && outputTokens <= 0) return 0;
  const rate = getRate(model);
  const inUsd = (Math.max(0, inputTokens) / 1_000_000) * rate.inputPerMillion;
  const outUsd = (Math.max(0, outputTokens) / 1_000_000) * rate.outputPerMillion;
  return inUsd + outUsd + (rate.perCall ?? 0);
}
