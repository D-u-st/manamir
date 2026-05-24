// Context Compressor — graduated pressure + structured summarization
// Replaces the naive message-preprocessor with a production-grade compression engine.
// No Bun APIs. LLM summary uses fetch to the same OpenAI-compatible endpoint.

import { createHash } from 'crypto';
import { estimateStringTokens, estimateTokens, MAX_CONTEXT_TOKENS } from './token-budget';
import { sanitizeMessages } from './message-sanitizer';
import { log } from '../utils/logger';
import type { TodoTracker } from './todo-tracker';

// ── Types ──

interface Message {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface ToolCallInfo {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface CompressorConfig {
  maxContextTokens: number;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface CompressionResult {
  messages: Message[];
  level: CompressionLevel;
  stats: CompressionStats;
}

export interface CompressionStats {
  originalTokens: number;
  compressedTokens: number;
  originalCount: number;
  compressedCount: number;
  ratio: number;
  level: CompressionLevel;
  toolResultsPruned: number;
  duplicatesRemoved: number;
  argsTruncated: number;
  summaryGenerated: boolean;
}

export type CompressionLevel = 'none' | 'prune_only' | 'prune_and_protect' | 'full' | 'emergency';

// Graduated pressure thresholds as fraction of maxContextTokens.
// Lower defaults — DeepSeek-chat has 64K
// context, so we want to start pruning earlier. Override via env vars.
const THRESHOLD_PRUNE = Number(process.env.COMPRESS_THRESHOLD_PRUNE) || 0.30;
const THRESHOLD_PROTECT = Number(process.env.COMPRESS_THRESHOLD_PROTECT) || 0.50;
const THRESHOLD_FULL = Number(process.env.COMPRESS_THRESHOLD_FULL) || 0.70;
const THRESHOLD_EMERGENCY = Number(process.env.COMPRESS_THRESHOLD_EMERGENCY) || 0.85;

// Tail budget: how many tokens to allocate to the protected tail
const TAIL_BUDGET_RATIO = 0.60;
const MIN_TAIL_MESSAGES = 6;

// Summary budget constraints
const SUMMARY_BUDGET_RATIO = 0.20;
const SUMMARY_MAX_TOKENS = 12_000;
const SUMMARY_MIN_TOKENS = 2_000;

// Anti-thrashing: if 2 consecutive compressions save <10%, stop
const ANTI_THRASH_MIN_SAVINGS = 0.10;

// Failure cooldown: 600s after failed LLM summary
const SUMMARY_FAILURE_COOLDOWN_MS = 600_000;

// ── State ──

let lastSummaryFailureTime = 0;
let previousCompressionRatio = 1.0;
let consecutiveLowSavings = 0;
let cachedSummary: string | null = null;

export function resetCompressorState(): void {
  lastSummaryFailureTime = 0;
  previousCompressionRatio = 1.0;
  consecutiveLowSavings = 0;
  cachedSummary = null;
}

// ── Step 1: Tool Output Pruning ──

function smartToolSummary(toolName: string, args: Record<string, unknown>, result: string): string {
  const resultLen = result.length;
  const lines = result.split('\n').length;

  switch (toolName) {
    case 'bash': {
      const command = String(args.command || '').slice(0, 80);
      const exitMatch = result.match(/exit code[: ]*(\d+)/i);
      const exitCode = exitMatch ? exitMatch[1] : (result.includes('Error') ? '1' : '0');
      return `[bash] ran '${command}' → exit ${exitCode}, ${lines} lines`;
    }
    case 'read': {
      const filePath = String(args.file_path || args.path || '');
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      const offset = args.offset ? ` from line ${args.offset}` : '';
      return `[read] ${fileName}${offset} (${resultLen} chars)`;
    }
    case 'write': {
      const filePath = String(args.file_path || args.path || '');
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      return `[write] wrote to ${fileName} (${lines} lines)`;
    }
    case 'glob': {
      const pattern = String(args.pattern || '');
      const matchCount = result.trim().split('\n').filter(Boolean).length;
      return `[glob] pattern='${pattern}' (${matchCount} matches)`;
    }
    case 'grep': {
      const pattern = String(args.pattern || '');
      const matchCount = result.trim().split('\n').filter(Boolean).length;
      return `[grep] pattern='${pattern}' (${matchCount} matches)`;
    }
    case 'web_search': {
      const query = String(args.query || '');
      return `[web_search] query='${query}' (${resultLen} chars)`;
    }
    default: {
      const argPreview = Object.entries(args)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`)
        .join(', ');
      return `[${toolName}] ${argPreview} (${resultLen} chars result)`;
    }
  }
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function pruneToolOutputs(messages: Message[]): {
  messages: Message[];
  pruned: number;
  deduped: number;
  argsTruncated: number;
} {
  let pruned = 0;
  let deduped = 0;
  let argsTruncated = 0;

  // Build a map of tool_call_id → tool name + args from assistant messages
  const toolCallMap = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as ToolCallInfo[]) {
        if (!tc?.function?.name || !tc?.id) continue;
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}');
        } catch { /* ignore */ }
        toolCallMap.set(tc.id, { name: tc.function.name, args: parsedArgs });
      }
    }
  }

  // Pre-build hash → lastIndex map by walking forward to find the NEWEST (last) occurrence
  // of each tool-result hash. The newest occurrence is kept verbatim; older duplicates are
  // replaced with a reference marker.
  const newestHashIndex = new Map<string, number>(); // hash → index of newest occurrence

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && msg.content) {
      const hash = md5(msg.content);
      newestHashIndex.set(hash, i); // overwrites — final value is the latest index
    }
  }

  // Single pass: process all messages, dedup any tool result that is NOT the newest of its hash.
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Truncate large tool_call arguments
    if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      const truncatedCalls = (msg.tool_calls as ToolCallInfo[]).map(tc => {
        if (!tc?.function?.arguments) return tc;
        if (tc.function.arguments.length > 500) {
          argsTruncated++;
          return {
            ...tc,
            function: {
              ...tc.function,
              arguments: tc.function.arguments.slice(0, 200) + '...[truncated]'
            }
          };
        }
        return tc;
      });

      if (argsTruncated > 0) {
        result.push({ ...msg, tool_calls: truncatedCalls });
      } else {
        result.push(msg);
      }
      continue;
    }

    // Process tool results
    if (msg.role === 'tool' && msg.content) {
      const hash = md5(msg.content);
      const newestIndex = newestHashIndex.get(hash);

      // Deduplicate: if this isn't the newest occurrence of this hash, replace with marker.
      // (Newest occurrence has newestIndex === i and is kept as-is.)
      if (newestIndex !== undefined && newestIndex !== i) {
        deduped++;
        result.push({
          ...msg,
          content: '[Duplicate — same as more recent call]'
        });
        continue;
      }

      // Smart summary for old tool results (not the most recent 6 tool results)
      const toolInfo = msg.tool_call_id ? toolCallMap.get(msg.tool_call_id) : undefined;
      if (toolInfo && estimateStringTokens(msg.content) > 100) {
        pruned++;
        result.push({
          ...msg,
          content: smartToolSummary(toolInfo.name, toolInfo.args, msg.content)
        });
        continue;
      }
    }

    result.push(msg);
  }

  return { messages: result, pruned, deduped, argsTruncated };
}

// ── Step 2: Protect Head ──

function protectHead(messages: Message[]): { head: Message[]; rest: Message[] } {
  const head: Message[] = [];
  let restStart = 0;

  // Collect system messages from the start
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'system') {
      head.push(messages[i]);
      restStart = i + 1;
    } else {
      break;
    }
  }

  // Protect first 3 conversation messages after system
  const firstConvo = messages.slice(restStart, restStart + 3);
  head.push(...firstConvo);
  restStart += firstConvo.length;

  return { head, rest: messages.slice(restStart) };
}

// ── Step 3: Protect Tail by Token Budget ──

function protectTail(
  messages: Message[],
  tailBudgetTokens: number
): { tail: Message[]; middle: Message[] } {
  let accumulated = 0;
  let tailStart = messages.length;

  // Walk backward accumulating tokens
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = 4 + estimateStringTokens(messages[i].content || '') +
      (messages[i].tool_calls ? estimateStringTokens(JSON.stringify(messages[i].tool_calls)) : 0);

    if (accumulated + msgTokens > tailBudgetTokens && (messages.length - tailStart) >= MIN_TAIL_MESSAGES) {
      break;
    }

    accumulated += msgTokens;
    tailStart = i;
  }

  // Enforce minimum floor
  const maxTailStart = Math.max(0, messages.length - MIN_TAIL_MESSAGES);
  tailStart = Math.min(tailStart, maxTailStart);

  return {
    tail: messages.slice(tailStart),
    middle: messages.slice(0, tailStart)
  };
}

// ── Step 4: Summarize Middle (LLM or fallback) ──

const SUMMARIZER_SYSTEM_PROMPT = `You are creating a context checkpoint. Your output will be used by a DIFFERENT assistant to continue this conversation. Do NOT respond to questions — only output the summary.

Format your output as follows:

## Goal
What the user is trying to accomplish

## Completed Actions
What has been done so far (tools used, files modified, commands run)

## Active State
Current state of the system/files/environment

## In Progress
What was being worked on when this checkpoint was created

## Blocked
Any known blockers or errors encountered

## Key Decisions
Important decisions made during the conversation

## Resolved Questions
Questions that were asked and answered

## Pending
Open questions or next steps`;

function buildSummarizerPrompt(middleMessages: Message[]): string {
  const parts: string[] = [];

  for (const msg of middleMessages) {
    if (msg.role === 'user' && msg.content) {
      parts.push(`USER: ${msg.content.slice(0, 500)}`);
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        const names = (msg.tool_calls as ToolCallInfo[])
          .map(tc => tc?.function?.name || '?')
          .join(', ');
        parts.push(`ASSISTANT: [used tools: ${names}]`);
      }
      if (msg.content) {
        parts.push(`ASSISTANT: ${msg.content.slice(0, 300)}`);
      }
    } else if (msg.role === 'tool' && msg.content) {
      parts.push(`TOOL RESULT: ${msg.content.slice(0, 200)}`);
    }
  }

  return `Summarize the following conversation segment:\n\n${parts.join('\n')}`;
}

async function llmSummarize(
  middleMessages: Message[],
  maxSummaryTokens: number,
  config: CompressorConfig
): Promise<string | null> {
  if (!config.apiKey || !config.baseUrl || !config.model) return null;

  // Check failure cooldown
  if (Date.now() - lastSummaryFailureTime < SUMMARY_FAILURE_COOLDOWN_MS) {
    log.info('ContextCompressor: summary in cooldown, skipping LLM');
    return null;
  }

  const userPrompt = buildSummarizerPrompt(middleMessages);
  const summaryMaxTokens = Math.min(maxSummaryTokens, 2048);

  try {
    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: summaryMaxTokens,
        temperature: 0.3,
        stream: false
      }),
      signal: AbortSignal.timeout(30_000)
    });

    if (!response.ok) {
      throw new Error(`Summary API error ${response.status}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content || content.length < 50) {
      throw new Error('Summary too short or empty');
    }

    return content;
  } catch (err) {
    log.warn('ContextCompressor: LLM summary failed, using fallback', { error: String(err) });
    lastSummaryFailureTime = Date.now();
    return null;
  }
}

function fallbackSummarize(middleMessages: Message[]): string {
  const parts: string[] = [];

  for (const msg of middleMessages) {
    if (msg.role === 'user' && msg.content) {
      const preview = msg.content.slice(0, 80).replace(/\n/g, ' ');
      parts.push(`- User: "${preview}"`);
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        const names = (msg.tool_calls as ToolCallInfo[])
          .map(tc => tc?.function?.name || '?')
          .join(', ');
        parts.push(`- Used: ${names}`);
      } else if (msg.content) {
        const preview = msg.content.slice(0, 60).replace(/\n/g, ' ');
        parts.push(`- AI: "${preview}"`);
      }
    }
  }

  return parts.join('\n');
}

// ── Step 5: Iterative Update + Anti-thrashing ──

// Cap on merged summary size to prevent unbounded growth across many compactions.
// Roughly 4 chars per token.
const MERGED_SUMMARY_MAX_TOKENS = 4_000;
const MERGED_SUMMARY_MAX_CHARS = MERGED_SUMMARY_MAX_TOKENS * 4;

function mergeWithExistingSummary(existingSummary: string | null, newSummary: string): string {
  if (!existingSummary) {
    // Even on first summary, never exceed the cap.
    return newSummary.length > MERGED_SUMMARY_MAX_CHARS
      ? newSummary.slice(-MERGED_SUMMARY_MAX_CHARS)
      : newSummary;
  }

  const candidate = `${existingSummary}\n\n--- Updated ---\n${newSummary}`;

  // Fast path: under the cap, keep the merged form.
  if (candidate.length <= MERGED_SUMMARY_MAX_CHARS) {
    return candidate;
  }

  // The new summary alone is bigger than the cap → keep newest tail.
  if (newSummary.length >= MERGED_SUMMARY_MAX_CHARS) {
    return newSummary.slice(-MERGED_SUMMARY_MAX_CHARS);
  }

  // Otherwise: drop the oldest portion of the existing summary so that
  // existing_kept + separator + newSummary fits within the cap. Always keep
  // the newest content (which lives at the end of the merged string).
  const separator = '\n\n--- Updated ---\n';
  const budgetForExisting = MERGED_SUMMARY_MAX_CHARS - separator.length - newSummary.length;
  if (budgetForExisting <= 0) {
    return newSummary;
  }
  const truncatedExisting = existingSummary.length > budgetForExisting
    ? '[…older summary truncated…]\n' + existingSummary.slice(-(budgetForExisting - 32))
    : existingSummary;

  return `${truncatedExisting}${separator}${newSummary}`;
}

// ── Todo harvesting helpers ──
//
// When messages get summarized away, any todos mentioned in those messages
// would be lost. We extract them into the optional TodoTracker BEFORE
// summarizing, then re-inject the open ones into the compaction marker so the
// continuation agent still sees them.

function harvestTodos(droppedMessages: Message[], tracker?: TodoTracker): void {
  if (!tracker) return;
  for (const msg of droppedMessages) {
    if (typeof msg.content === 'string' && msg.content.length > 0) {
      // Use turn=0 — the compressor doesn't track turn numbers; the tracker
      // only uses turn for id generation, not behavior.
      tracker.extractFromMessage(msg.content, 0);
    }
  }
}

function appendTodos(summary: string, tracker?: TodoTracker): string {
  if (!tracker) return summary;
  const block = tracker.formatForInjection();
  if (block.length === 0) return summary;
  return `${summary}\n\n${block}`;
}

// ── Public API ──

export function shouldCompress(messages: Message[], maxContextTokens: number = MAX_CONTEXT_TOKENS): CompressionLevel {
  const tokens = estimateTokens(messages);
  const ratio = tokens / maxContextTokens;

  if (ratio >= THRESHOLD_EMERGENCY) return 'emergency';
  if (ratio >= THRESHOLD_FULL) return 'full';
  if (ratio >= THRESHOLD_PROTECT) return 'prune_and_protect';
  if (ratio >= THRESHOLD_PRUNE) return 'prune_only';
  return 'none';
}

export async function compress(
  messages: Message[],
  config: CompressorConfig,
  todoTracker?: TodoTracker
): Promise<CompressionResult> {
  const maxTokens = config.maxContextTokens || MAX_CONTEXT_TOKENS;
  const level = shouldCompress(messages, maxTokens);

  if (level === 'none') {
    return {
      messages: [...messages],
      level: 'none',
      stats: buildStats(messages, messages, 'none', 0, 0, 0, false)
    };
  }

  // Anti-thrashing check
  if (consecutiveLowSavings >= 2) {
    log.info('ContextCompressor: anti-thrashing triggered, skipping compression');
    consecutiveLowSavings = 0; // Reset so it can try again later
    return {
      messages: [...messages],
      level: 'none',
      stats: buildStats(messages, messages, 'none', 0, 0, 0, false)
    };
  }

  let result: Message[];
  let pruned = 0;
  let deduped = 0;
  let argsTrunc = 0;
  let summaryGenerated = false;

  // Step 1: Tool output pruning (all levels)
  const pruneResult = pruneToolOutputs(messages);
  result = pruneResult.messages;
  pruned = pruneResult.pruned;
  deduped = pruneResult.deduped;
  argsTrunc = pruneResult.argsTruncated;

  if (level === 'prune_only') {
    return {
      messages: result,
      level,
      stats: buildStats(messages, result, level, pruned, deduped, argsTrunc, false)
    };
  }

  // Step 2 + 3: Protect head and tail
  const { head, rest } = protectHead(result);
  const tailBudget = Math.floor(maxTokens * TAIL_BUDGET_RATIO);
  const { tail, middle } = protectTail(rest, tailBudget);

  if (middle.length === 0) {
    result = sanitizeMessages([...head, ...tail]);
    return {
      messages: result,
      level,
      stats: buildStats(messages, result, level, pruned, deduped, argsTrunc, false)
    };
  }

  // Emergency mode: more aggressive tail protection
  if (level === 'emergency') {
    const emergencyTailBudget = Math.floor(maxTokens * 0.75);
    const emergencyResult = protectTail(rest, emergencyTailBudget);

    if (emergencyResult.middle.length > 0) {
      // Harvest todos from messages we're about to drop, so the agent doesn't
      // forget them after compaction.
      harvestTodos(emergencyResult.middle, todoTracker);
      const baseSummary = fallbackSummarize(emergencyResult.middle);
      const summaryText = appendTodos(baseSummary, todoTracker);
      const summaryMsg: Message = {
        role: 'system',
        content: `[CONTEXT COMPACTION — REFERENCE ONLY]\n${summaryText}`
      };
      result = sanitizeMessages([...head, summaryMsg, ...emergencyResult.tail]);
    } else {
      result = sanitizeMessages([...head, ...emergencyResult.tail]);
    }

    return {
      messages: result,
      level,
      stats: buildStats(messages, result, level, pruned, deduped, argsTrunc, true)
    };
  }

  // Harvest todos from middle messages BEFORE summarization so they survive
  // compaction even if the LLM summary drops them.
  harvestTodos(middle, todoTracker);

  // Step 4: Summarize middle
  let summaryText: string | null = null;

  if (level === 'full') {
    // Calculate summary token budget
    const middleTokens = estimateTokens(middle);
    const summaryBudget = Math.max(
      SUMMARY_MIN_TOKENS,
      Math.min(
        SUMMARY_MAX_TOKENS,
        Math.floor(middleTokens * SUMMARY_BUDGET_RATIO)
      )
    );

    // Try LLM summary
    summaryText = await llmSummarize(middle, summaryBudget, config);
    summaryGenerated = summaryText !== null;
  }

  // Fallback if LLM failed or level is prune_and_protect
  if (!summaryText) {
    summaryText = fallbackSummarize(middle);
  }

  // Step 5: Iterative update — merge with previous summary if exists
  summaryText = mergeWithExistingSummary(cachedSummary, summaryText);
  cachedSummary = summaryText;

  // Enforce summary token budget
  const summaryTokens = estimateStringTokens(summaryText);
  if (summaryTokens > SUMMARY_MAX_TOKENS) {
    const maxChars = SUMMARY_MAX_TOKENS * 4;
    summaryText = summaryText.slice(0, maxChars) + '\n[summary truncated]';
  }

  // Append open todos so the post-compaction agent doesn't forget commitments.
  const summaryWithTodos = appendTodos(summaryText, todoTracker);

  const summaryMsg: Message = {
    role: 'system',
    content: `[CONTEXT COMPACTION — REFERENCE ONLY]\n${summaryWithTodos}`
  };

  result = sanitizeMessages([...head, summaryMsg, ...tail]);

  // Anti-thrashing tracking
  const originalTokens = estimateTokens(messages);
  const compressedTokens = estimateTokens(result);
  const savings = 1 - (compressedTokens / originalTokens);

  if (savings < ANTI_THRASH_MIN_SAVINGS) {
    consecutiveLowSavings++;
  } else {
    consecutiveLowSavings = 0;
  }
  previousCompressionRatio = compressedTokens / originalTokens;

  return {
    messages: result,
    level,
    stats: buildStats(messages, result, level, pruned, deduped, argsTrunc, summaryGenerated)
  };
}

/**
 * Synchronous compression — no LLM summary, only steps 1-3 + fallback summary.
 * Use this when you can't await (or as a fallback).
 */
export function compressSync(
  messages: Message[],
  maxContextTokens: number = MAX_CONTEXT_TOKENS
): CompressionResult {
  const level = shouldCompress(messages, maxContextTokens);

  if (level === 'none') {
    return {
      messages: [...messages],
      level: 'none',
      stats: buildStats(messages, messages, 'none', 0, 0, 0, false)
    };
  }

  // Step 1: Prune
  const pruneResult = pruneToolOutputs(messages);
  let result = pruneResult.messages;

  if (level === 'prune_only') {
    return {
      messages: result,
      level,
      stats: buildStats(messages, result, level, pruneResult.pruned, pruneResult.deduped, pruneResult.argsTruncated, false)
    };
  }

  // Step 2 + 3: Head/Tail protection
  const { head, rest } = protectHead(result);
  const keepRecent = level === 'emergency' ? 4 : MIN_TAIL_MESSAGES;
  const tailBudget = level === 'emergency'
    ? Math.floor(maxContextTokens * 0.75)
    : Math.floor(maxContextTokens * TAIL_BUDGET_RATIO);
  const { tail, middle } = protectTail(rest, tailBudget);

  if (middle.length === 0) {
    result = sanitizeMessages([...head, ...tail]);
  } else {
    const summaryText = fallbackSummarize(middle);
    const mergedSummary = mergeWithExistingSummary(cachedSummary, summaryText);
    cachedSummary = mergedSummary;

    const summaryMsg: Message = {
      role: 'system',
      content: `[CONTEXT COMPACTION — REFERENCE ONLY]\n${mergedSummary}`
    };
    result = sanitizeMessages([...head, summaryMsg, ...tail]);
  }

  return {
    messages: result,
    level,
    stats: buildStats(messages, result, level, pruneResult.pruned, pruneResult.deduped, pruneResult.argsTruncated, false)
  };
}

/**
 * Force compression at a specific level (for error recovery, e.g. after 413).
 */
export function forceCompress(
  messages: Message[],
  targetLevel: CompressionLevel,
  maxContextTokens: number = MAX_CONTEXT_TOKENS
): CompressionResult {
  if (targetLevel === 'none') {
    return { messages: [...messages], level: 'none', stats: buildStats(messages, messages, 'none', 0, 0, 0, false) };
  }

  // Step 1: always prune
  const pruneResult = pruneToolOutputs(messages);
  let result = pruneResult.messages;

  if (targetLevel === 'prune_only') {
    return {
      messages: result,
      level: targetLevel,
      stats: buildStats(messages, result, targetLevel, pruneResult.pruned, pruneResult.deduped, pruneResult.argsTruncated, false)
    };
  }

  const { head, rest } = protectHead(result);
  const tailRatio = targetLevel === 'emergency' ? 0.75 : TAIL_BUDGET_RATIO;
  const tailBudget = Math.floor(maxContextTokens * tailRatio);
  const { tail, middle } = protectTail(rest, tailBudget);

  if (middle.length === 0) {
    result = [...head, ...tail];
  } else {
    const summaryText = fallbackSummarize(middle);
    const summaryMsg: Message = {
      role: 'system',
      content: `[CONTEXT COMPACTION — REFERENCE ONLY]\n${summaryText}`
    };
    result = [...head, summaryMsg, ...tail];
  }

  // If still over budget after full compression, keep shrinking tail
  let shrinkAttempts = 0;
  while (estimateTokens(result) > maxContextTokens && shrinkAttempts < 5) {
    const tailShrink = Math.max(4, tail.length - 4);
    const shrunkTail = tail.slice(-tailShrink);
    const shrunkMiddle = [...middle, ...tail.slice(0, tail.length - tailShrink)];
    const summaryText = fallbackSummarize(shrunkMiddle);
    const summaryMsg: Message = {
      role: 'system',
      content: `[CONTEXT COMPACTION — REFERENCE ONLY]\n${summaryText}`
    };
    result = [...head, summaryMsg, ...shrunkTail];
    shrinkAttempts++;
  }

  result = sanitizeMessages(result);

  return {
    messages: result,
    level: targetLevel,
    stats: buildStats(messages, result, targetLevel, pruneResult.pruned, pruneResult.deduped, pruneResult.argsTruncated, false)
  };
}

function buildStats(
  original: Message[],
  compressed: Message[],
  level: CompressionLevel,
  toolResultsPruned: number,
  duplicatesRemoved: number,
  argsTruncated: number,
  summaryGenerated: boolean
): CompressionStats {
  const originalTokens = estimateTokens(original);
  const compressedTokens = estimateTokens(compressed);
  return {
    originalTokens,
    compressedTokens,
    originalCount: original.length,
    compressedCount: compressed.length,
    ratio: originalTokens > 0 ? compressedTokens / originalTokens : 1,
    level,
    toolResultsPruned,
    duplicatesRemoved,
    argsTruncated,
    summaryGenerated
  };
}
