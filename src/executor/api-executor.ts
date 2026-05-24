// API Executor — OpenAI-compatible API (DeepSeek, OpenAI, etc.)
// Agent loop: streams SSE, detects tool_calls, executes tools, loops until done.

import { EventEmitter } from 'events';
import { log } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { shouldCompress, compress, compressSync, forceCompress, type CompressionLevel, type CompressorConfig } from './context-compressor';
import { estimateTokens } from './token-budget';
import { LoopDetector } from '../autonomous/loop-detector';
import { getTool } from '../tools/registry';
import { toFunctionDefinitionsFiltered } from '../tools/registry';
import type { StreamEventResult, ExecutorCallbacks, ToolDefinition, ToolExecutorFn } from './types';
import { getModelProfile, type ModelProfile } from './model-profiles';
import { classifyApiError, FailoverReason } from './error-classifier';
import { applyPerToolBudget } from './result-budget';
import { sanitizeToolResult } from './result-sanitizer';
import { redactCredentials } from '../security/redact';
import { ThinkFilter } from './think-filter';
import { chooseRoute, getCheapModel } from './cheap-router';
import { CredentialPool, type Credential } from './credential-pool';
import { RateLimitTracker } from './rate-limit-tracker';
import { recordGlobalCost } from '../utils/cost-tracker';
import { injectSelfReviewsForTask } from '../autonomous/self-review';
import { listSkillsTier1 } from '../skills/registry';
import { recommendSkillsForTask, formatSkillRecommendations } from '../skills/recommender';
import {
  shouldEnterPlanMode,
  consumePlanModeOverride,
  formatPlanModePrompt,
  type PlanModeDecision,
} from './plan-mode-detector';
// v2.6.0 anti-stuck additions
import { StreamWatchdog, StreamStalledError } from './stream-watchdog';
import { TokenBudget } from './max-tokens';
import { RollingHashDetector } from './rolling-hash';
import { ShortSentenceDetector } from './short-sentence-detector';

export interface ApiExecutorOptions {
  apiKey: string;
  baseUrl: string;           // e.g. https://api.deepseek.com
  model: string;             // e.g. deepseek-chat
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  systemPrompt?: string;
  maxTurns?: number;         // agent loop turn limit (default 20)
  credentialPool?: Credential[]; // optional pool: when set, rotates on auth/rate/billing failures
}

// OpenAI chat message types
interface SystemMessage {
  role: 'system';
  content: string;
}

interface UserMessage {
  role: 'user';
  content: string;
}

interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

interface ToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// Accumulated tool call from streaming deltas
interface ToolCallAccumulator {
  index: number;
  id: string;
  functionName: string;
  argumentChunks: string;
}

// Result of parsing one SSE stream
interface StreamParseResult {
  content: string;
  toolCalls: ToolCall[];
  reasoning: string;
  usage: { promptTokens: number; completionTokens: number; cacheHitTokens?: number } | null;
  /** OpenAI/DeepSeek finish_reason from final chunk: stop|length|tool_calls|content_filter|... */
  finishReason?: string;
  /** True when our own watchdog/rolling-hash forced abort (vs server completed normally). */
  abortedByGuard?: 'stall' | 'cascade' | 'ngram-repeat' | 'dsml-leak' | 'short-sentence-repeat';
}

/**
 * Tag families that count as "auxiliary system injections" — selfReview lessons,
 * skill recommendations, plan-mode hints. Two code paths reference this list
 * (injectAuxiliaryContext deletes them, buildMessages preserves them). Keeping
 * a single source of truth so adding a new aux block type only updates here.
 */
const AUXILIARY_PREFIXES = [
  '<past-lessons',
  '<past-selfReviews',
  '<skill-suggestions',
  '<plan-mode'
] as const;

function isAuxiliarySystemContent(content: string): boolean {
  for (const p of AUXILIARY_PREFIXES) {
    if (content.startsWith(p)) return true;
  }
  return false;
}

/** Map a classifier reason to the credential-pool rotation reason, or null. */
function mapToRotateReason(reason: FailoverReason): 'rate_limit' | 'billing' | 'auth' | null {
  if (reason === FailoverReason.RateLimit) return 'rate_limit';
  if (reason === FailoverReason.Billing) return 'billing';
  if (reason === FailoverReason.Auth) return 'auth';
  return null;
}

export class ApiExecutor extends EventEmitter {
  private abortController: AbortController | null = null;
  private conversationHistory: ChatMessage[] = [];
  private tools: ToolDefinition[] = [];
  private toolExecutor: ToolExecutorFn | null = null;
  private maxTurns: number;
  private profile: ModelProfile;

  // Smart tool loading (P-09): track which tools the model has actually used
  private usedToolNames: Set<string> = new Set();

  // Essential tool names — from profile or default
  private essentialTools: string[];

  // Credential pool: when configured, rotates apiKey/baseUrl/model on
  // auth/billing/rate-limit failures. When null, single-credential mode.
  private credentialPool: CredentialPool | null = null;

  // Rate-limit header tracking — feeds shouldSleepBeforeNext() before each request.
  private rateLimitTracker = new RateLimitTracker();

  // Loop detection + early termination
  private loopDetector = new LoopDetector({ warningThreshold: 3, criticalThreshold: 5 });
  private consecutiveErrors = 0;
  private lastToolCallSig = ''; // signature of previous tool call for duplicate detection
  private duplicateCallCount = 0; // DS1 trust calibration: 0->1 inject correction, ->2 abort
  // v2.7.0 V2: web_search per-turn use counter + hard cap
  private webSearchCount = 0;
  private static readonly WEB_SEARCH_MAX_USES = 8;

  // v2.7.0 V1 Phase C1: Factual verifier trigger detection (heuristic + log).
  // Phase C2 injected actual verifier-spawn fn from outside (avoids circular
  // import with sub-agent.ts which already imports api-executor).
  // Phase C3 added FAIL → inject correction + 1 retry turn (this state).
  private factualVerifierHook?: (
    userMsg: string,
    assistantMsg: string,
    toolsUsed: string[],
    triggerReason: string
  ) => Promise<{ verdict: 'PASS' | 'FAIL'; reason?: string; fix?: string }>;
  private factualVerifierRetries = 0; // Phase C3: cap at FACTUAL_VERIFIER_MAX_RETRIES
  private static readonly FACTUAL_VERIFIER_MAX_RETRIES = 1;
  private continueInjections = 0; // "continue now" injections this execution
  private fakeAnswerInjections = 0; // RFC-003 改动 B: tool-failure-then-fabricate injections this execution
  private lastToolFailedSignal = false; // RFC-003 改动 B: did previous tool turn return 4xx/5xx?

  // v2.6.0 anti-stuck state
  private tokenBudget: TokenBudget;
  // Recovery hint to inject into NEXT request's system prompt only (cleared after use).
  // Set when stream-watchdog soft-aborts or rolling-hash detects repeat — gives
  // the model a one-shot reminder to avoid the failure mode.
  private pendingRecoveryHint: string | null = null;
  // v2.6.1: cap missing-tool expansions per execution to break the
  // "model asks for X → expand → still asks → expand" infinite loop seen
  // in production 2026-04-21 (web_fetch added but tool list still showed 2).
  private toolExpansions = 0;

  constructor(private options: ApiExecutorOptions) {
    super();
    this.profile = getModelProfile(options.model);
    this.maxTurns = options.maxTurns ?? this.profile.maxTurns;
    this.essentialTools = this.profile.firstTurnToolsOnly ?? [];
    this.tokenBudget = new TokenBudget(options.model, options.maxTokens);
    if (options.credentialPool && options.credentialPool.length > 0) {
      this.credentialPool = new CredentialPool(options.credentialPool);
      // Adopt the first credential as the live one so getter behaviour matches.
      this.applyCredential(this.credentialPool.current());
    }
  }

  /** Swap the live apiKey/baseUrl/model triple. Used by the credential pool. */
  private applyCredential(cred: Credential): void {
    this.options.apiKey = cred.apiKey;
    this.options.baseUrl = cred.baseUrl;
    this.options.model = cred.model;
    this.profile = getModelProfile(cred.model);
    // Token budget rebuilt with new model — different APIs have different caps.
    this.tokenBudget = new TokenBudget(cred.model, this.options.maxTokens);
  }

  /** Expose tracker so /status etc. can read the latest snapshot. */
  getRateLimitTracker(): RateLimitTracker {
    return this.rateLimitTracker;
  }

  /** Expose pool for diagnostics. */
  getCredentialPool(): CredentialPool | null {
    return this.credentialPool;
  }

  /** Register tools and executor for the agent loop */
  setTools(tools: ToolDefinition[], executor: ToolExecutorFn): void {
    this.tools = tools;
    this.toolExecutor = executor;
  }

  /**
   * V1 Phase C1: register factual verifier hook. Outer layer (SessionManager
   * or initializer) injects a function that spawns a SubAgent with the
   * 'factual-verifier' role to audit DS chat output. Avoids circular import
   * (sub-agent.ts → api-executor.ts) by passing the spawner from outside.
   */
  setFactualVerifierHook(
    fn: (
      userMsg: string,
      assistantMsg: string,
      toolsUsed: string[],
      triggerReason: string
    ) => Promise<{ verdict: 'PASS' | 'FAIL'; reason?: string; fix?: string }>
  ): void {
    this.factualVerifierHook = fn;
  }

  /**
   * V1 Phase C1: heuristic to detect "high-risk" turn that warrants factual
   * verification. Triggers when DS output contains pattern likely to be
   * hallucinated or violates V0/V2/V2c rules. Returns trigger=false for
   * normal turns to avoid spawning verifier on every message.
   */
  private factualVerifierTrigger(
    content: string,
    toolsUsed: string[]
  ): { trigger: boolean; reason?: string } {
    const toolSet = new Set(toolsUsed);
    const hasWebTool = toolSet.has('web_search') || toolSet.has('web_fetch');

    // (1) URL but no web tool — likely fabricated link
    if (!hasWebTool && /https?:\/\/[^\s)<>"]+/i.test(content)) {
      return { trigger: true, reason: 'url-without-web-tool' };
    }

    // (2) Forbidden surrender phrases (pitfalls #75) — DS denying tools it has
    const forbiddenPatterns = [
      /我无法直接访问外部网站/,
      /我无法浏览网页/,
      /我的工具集有限/,
      /我的知识截止/,
      /建议你自行(在浏览器中)?搜索/,
      /由于我无法直接浏览网页/,
      /I cannot access (external|the) (websites?|internet)/i,
      /I cannot browse the web/i,
    ];
    for (const pat of forbiddenPatterns) {
      if (pat.test(content)) {
        return { trigger: true, reason: 'forbidden-surrender-phrase' };
      }
    }

    // (3) Version-number claim but no web tool used
    if (
      !hasWebTool &&
      /\bv?\d+\.\d+(\.\d+)?\b/.test(content) &&
      content.length > 100
    ) {
      return { trigger: true, reason: 'version-without-web-tool' };
    }

    // (4) Long answer with zero tools used = high hallucination risk
    if (content.length > 800 && toolsUsed.length === 0) {
      return { trigger: true, reason: 'long-answer-no-tools' };
    }

    // (5) V1d (2026-04-23): bash cascade ≥3 + no web tool + content has external
    // entity keywords (github/repo/version/url/404/...) → DS used bash to query
    // an external thing (GitHub API / curl <site>) instead of web_search.
    // Observed 2026-04-23: 7 bash curls to GitHub API for "is there X repo".
    if (
      !hasWebTool &&
      toolsUsed.filter((t) => t === 'bash').length >= 3
    ) {
      const externalKeywords =
        /github|gitlab|npm|pypi|pip|官网|项目|仓库|repo|repository|version|版本|网站|website|发布|release|\burl\b|404|https?:\/\//i;
      if (externalKeywords.test(content)) {
        return { trigger: true, reason: 'bash-cascade-no-web-external' };
      }
    }

    return { trigger: false };
  }

  async execute(prompt: string, callbacks?: ExecutorCallbacks): Promise<StreamEventResult> {
    return withRetry(
      () => this._executeAgentLoop(prompt, callbacks),
      {
        maxRetries: 2,
        baseDelayMs: 2000,
        shouldRetry: (err) => {
          const classified = classifyApiError(err, undefined, this.options.model);
          log.info('ApiExecutor: error classified', {
            reason: classified.reason,
            retryable: classified.retryable,
            shouldCompress: classified.shouldCompress,
            shouldFallback: classified.shouldFallback
          });
          return classified.retryable;
        }
      }
    );
  }

  private async _executeAgentLoop(prompt: string, callbacks?: ExecutorCallbacks): Promise<StreamEventResult> {
    this.abortController = new AbortController();
    const startTime = Date.now();

    // Reset per-execution state
    this.usedToolNames.clear();
    this.toolExpansions = 0;
    this.consecutiveErrors = 0;
    this.lastToolCallSig = '';
    this.duplicateCallCount = 0;
    this.webSearchCount = 0; // v2.7.0 V2 reset
    this.factualVerifierRetries = 0; // v2.7.0 V1 Phase C3 reset
    this.continueInjections = 0;
    // RFC-003 改动 B: reset fake-answer guard state per execution.
    this.fakeAnswerInjections = 0;
    this.lastToolFailedSignal = false;
    this.loopDetector.reset();

    // Cheap model routing: swap model for simple messages
    const route = chooseRoute(prompt);
    const cheapModel = getCheapModel();
    const originalModel = this.options.model;
    if (route === 'cheap' && cheapModel) {
      log.info('ApiExecutor: routing to cheap model', { cheapModel, originalModel });
      this.options.model = cheapModel;
    }

    let turns = 0;
    let finalContent = '';

    // Preflight: if existing history (without the new user msg) is already over
    // threshold, compress before we add anything for this turn. We deliberately
    // run preflight BEFORE injecting the auxiliary system messages (selfReview
    // lessons, skill suggestions, plan-mode hint) so the new injections are
    // never compressed away on their first appearance.
    const preflightMessages = this.buildMessages();
    const preflightLevel = shouldCompress(preflightMessages);
    if (preflightLevel !== 'none') {
      log.info('ApiExecutor: preflight compression triggered', { level: preflightLevel });
      const preflight = compressSync(preflightMessages);
      // Keep ALL messages from preflight (including any compressor-generated system summary).
      // The original live system prompt is rebuilt fresh in buildMessages() and de-duplicated
      // there, so it's safe to retain compaction-marker system messages here.
      this.conversationHistory = preflight.messages as ChatMessage[];
    }

    // --- Auxiliary injections (Tier A-2: close SelfReview + SkillSynth loops) ---
    // 1. SelfReview: past lessons matching the new prompt
    // 2. SkillSynth: skill recommendations matching the new prompt
    // 3. Plan-mode auto-trigger for complex tasks
    //
    // All three go in BEFORE the user message so the model sees them as
    // standing context for this turn. They are added directly to history (not
    // dropped on subsequent turns) so multi-turn follow-ups still benefit.
    this.injectAuxiliaryContext(prompt);

    // Add user message to history (after auxiliary system messages)
    this.conversationHistory.push({ role: 'user', content: prompt });

    try {
      while (turns < this.maxTurns) {
        // Build full messages array, then apply graduated compression
        const rawMessages = this.buildMessages();
        const compressorConfig: CompressorConfig = {
          maxContextTokens: 30_000,
          apiKey: this.options.apiKey,
          baseUrl: this.options.baseUrl,
          model: this.options.model
        };
        const level = shouldCompress(rawMessages);
        let messages: ReturnType<typeof compressSync>['messages'];

        if (level === 'full') {
          const result = await compress(rawMessages, compressorConfig);
          messages = result.messages;
          log.info('ApiExecutor: compression (async)', {
            level: result.level,
            msgs: `${result.stats.originalCount} → ${result.stats.compressedCount}`,
            tokens: `${result.stats.originalTokens} → ${result.stats.compressedTokens}`,
            pruned: result.stats.toolResultsPruned,
            deduped: result.stats.duplicatesRemoved,
            summary: result.stats.summaryGenerated
          });
        } else {
          const result = compressSync(rawMessages);
          messages = result.messages;
          if (result.level !== 'none') {
            log.info('ApiExecutor: compression (sync)', {
              level: result.level,
              msgs: `${result.stats.originalCount} → ${result.stats.compressedCount}`,
              tokens: `${result.stats.originalTokens} → ${result.stats.compressedTokens}`,
              pruned: result.stats.toolResultsPruned
            });
          }
        }

        // Build request body. frequency_penalty/presence_penalty mitigate
        // DeepSeek-chat's tendency to loop on opening sentences ("好的，我来为你...")
        // when prompts are ambiguous or the prior turn ended in a self-reset.
        // v2.6.0: max_tokens from per-model TokenBudget (auto-bumps after
        // consecutive `length` stops, capped at sessionCeiling).
        const body: Record<string, unknown> = {
          model: this.options.model,
          messages,
          max_tokens: this.tokenBudget.cap,
          temperature: this.options.temperature ?? 0.7,
          frequency_penalty: 0.4,
          presence_penalty: 0.2,
          stream: true,
          // OpenAI-compatible streams only emit `usage` if we ask. DeepSeek
          // ignores the field cleanly when it's unsupported, so it's safe
          // to send unconditionally.
          stream_options: { include_usage: true }
        };

        // Smart tool loading (P-09): first turn sends only essential tools (if profile restricts),
        // subsequent turns add tools the model has actually used.
        // Last turn: NO tools — force the model to produce a text summary.
        if (this.tools.length > 0 && turns < this.maxTurns - 1) {
          if (this.essentialTools.length === 0) {
            // Profile allows all tools (e.g. Claude) — send everything
            body.tools = toFunctionDefinitionsFiltered(this.tools.map(t => t.function.name));
          } else {
            // v2.6.1 fix: when turn 0 expanded with missingTools (continue
            // without bumping turns), usedToolNames was ignored → infinite
            // loop because model kept requesting the same missing tool that
            // was added but never sent. Now we always merge usedToolNames.
            const activeToolNames = turns === 0 && this.usedToolNames.size === 0
              ? this.essentialTools
              : [...new Set([...this.essentialTools, ...this.usedToolNames])];
            body.tools = toFunctionDefinitionsFiltered(activeToolNames);
          }
        }
        // On the last allowed turn, tools are omitted so model MUST give text

        const activeToolCount = (body.tools as unknown[] | undefined)?.length ?? 0;
        log.info('ApiExecutor: calling API', {
          model: this.options.model,
          turn: turns + 1,
          maxTurns: this.maxTurns,
          historyLength: this.conversationHistory.length,
          toolCount: activeToolCount,
          totalRegistered: this.tools.length
        });

        // Proactive rate-limit sleep based on previously observed headers.
        const sleepMs = this.rateLimitTracker.shouldSleepBeforeNext();
        if (sleepMs > 0) {
          log.warn('ApiExecutor: pre-request sleeping for rate-limit', { sleepMs });
          await new Promise((r) => setTimeout(r, sleepMs));
        }

        const response = await fetch(`${this.options.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.options.apiKey}`,
            'Accept': 'text/event-stream'
          },
          body: JSON.stringify(body),
          signal: this.abortController.signal
        });

        // Always update the tracker — even error responses carry useful headers.
        this.rateLimitTracker.update(response.headers);

        if (!response.ok) {
          const errorText = await response.text();
          const status = response.status;
          // 413 or context overflow → force emergency compression and retry this turn
          if (status === 413 || status === 400) {
            const classified = classifyApiError(new Error(`API error ${status}: ${errorText}`));
            if (classified.shouldCompress) {
              log.warn('ApiExecutor: context overflow detected, forcing emergency compression');
              const emergency = forceCompress(rawMessages, 'emergency');
              messages = emergency.messages;
              // Don't increment turns — retry with compressed context
              continue;
            }
          }

          // Credential rotation: if a pool is configured AND the failure looks
          // like an auth/billing/rate-limit issue, rotate to the next key and
          // retry this same turn (without consuming a turn slot).
          if (this.credentialPool) {
            const classified = classifyApiError(
              new Error(`API error ${status}: ${errorText}`),
              undefined,
              this.options.model
            );
            const rotateReason = mapToRotateReason(classified.reason);
            if (rotateReason) {
              const next = this.credentialPool.rotateOnFailure(rotateReason);
              if (next) {
                log.warn('ApiExecutor: rotated credential after API failure', {
                  reason: rotateReason,
                  newLabel: next.label
                });
                this.applyCredential(next);
                continue; // retry this turn with the new credential
              }
              log.error('ApiExecutor: credential pool exhausted after rotation attempt', {
                reason: rotateReason
              });
            }
          }

          throw new Error(`API error ${status}: ${redactCredentials(errorText)}`);
        }

        // Parse SSE stream — collects text content and tool calls
        const parsed = await this.parseSSEStream(response, callbacks);

        // Record cost as soon as we have token counts. We attribute against
        // the model that actually served the request (which may differ from
        // the executor's default if the cheap router swapped it).
        if (parsed.usage) {
          recordGlobalCost({
            model: this.options.model,
            promptTokens: parsed.usage.promptTokens,
            completionTokens: parsed.usage.completionTokens
          });
          // RFC-001 monitoring: log cache hit ratio so we can verify prefix
          // cache is actually working in production. Only log when we have a
          // meaningful prompt size; tiny calls dominate noise.
          if (parsed.usage.promptTokens >= 500) {
            const hit = parsed.usage.cacheHitTokens ?? 0;
            const ratio = hit / parsed.usage.promptTokens;
            log.info('Cache hit', {
              promptTokens: parsed.usage.promptTokens,
              cacheHitTokens: hit,
              ratio: ratio.toFixed(2),
            });
          }
        }

        // Successful response → clear cooling on the active credential.
        if (this.credentialPool) {
          this.credentialPool.reset();
        }

        // v2.6.0: feed finish_reason to TokenBudget for adaptive cap.
        // After 2 consecutive `length` stops, the cap auto-bumps for next turn.
        this.tokenBudget.observeStopReason(parsed.finishReason);

        // v2.6.0: if the stream was aborted by our guards (cascade / N-gram /
        // stall), stage a one-shot recovery hint so the NEXT request's system
        // prompt nudges the model away from the failure mode.
        if (parsed.abortedByGuard) {
          const reason = parsed.abortedByGuard;
          this.pendingRecoveryHint = reason === 'cascade'
            ? '[Recovery] 上一轮被中断，因为检测到重复的"让我..."/"Let me..."类空话。本轮请直接调用工具或给出最终结果，不要再说"我来/让我/I will/Let me..."。'
            : reason === 'ngram-repeat'
              ? '[Recovery] 上一轮被中断，因为检测到内容大段重复。本轮请直接给出新内容，避免重复之前已说过的段落/JSON/代码块。'
              : reason === 'dsml-leak'
                ? '[Recovery] 上一轮被中断，因为检测到 DeepSeek 内部协议 token 泄漏到 content（<｜DSML｜...｜>）。本轮请使用标准 tool_calls 字段调用工具，不要把工具调用塞进 content text。'
                : reason === 'short-sentence-repeat'
                  ? '[Recovery] 上一轮被中断，因为开场白短句被重复说了多次（如"我来帮你...。我来帮你...。"）。本轮请直接调用工具或给出答案，开场白只说一次。'
                  : '[Recovery] 上一轮因长时间无响应被中断。本轮请简短回应，避免长时间生成。';
          log.info('ApiExecutor: staging recovery hint for next turn', {
            reason,
            hintLen: this.pendingRecoveryHint.length,
          });
        }

        // Last turn safety: if model returned tool_calls despite tools being omitted, ignore them
        if (turns >= this.maxTurns - 1 && parsed.toolCalls.length > 0) {
          log.warn('ApiExecutor: model returned tools on final turn, ignoring');
          parsed.toolCalls = [];
        }

        // If the model produced tool calls, execute them and loop
        if (parsed.toolCalls.length > 0) {
          // v2.6.1 fix: activeNames must mirror the tool set actually sent
          // (which now always merges usedToolNames). Without this, after
          // expansion we'd think the tool is "still missing" and loop again.
          const activeNames = turns === 0 && this.usedToolNames.size === 0
            ? new Set(this.essentialTools)
            : new Set([...this.essentialTools, ...this.usedToolNames]);
          const missingTools = parsed.toolCalls
            .map((tc) => tc.function.name)
            .filter((name) => !activeNames.has(name) && getTool(name) !== undefined);
          if (missingTools.length > 0) {
            // v2.6.1 hard cap: at most 3 expansions per execution. If after 3
            // we still see missing, the model is asking for something we
            // genuinely don't have or in a true loop — fall through to
            // execute whatever IS available (likely fails gracefully).
            const wasNew = missingTools.some((n) => !this.usedToolNames.has(n));
            if (wasNew && this.toolExpansions < 3) {
              for (const name of missingTools) {
                this.usedToolNames.add(name);
              }
              this.toolExpansions++;
              log.info('ApiExecutor: model requested missing tools, expanding and retrying', {
                missingTools,
                expansionsUsed: this.toolExpansions,
              });
              continue;
            }
            // Cap reached or no new tools — log and fall through to normal execution.
            // The model will get tool_result errors for the unknown tools and adapt.
            log.warn('ApiExecutor: missing-tool expansion cap reached, executing anyway', {
              missingTools,
              expansionsUsed: this.toolExpansions,
            });
          }

          // DS1 Trust calibration: escalating duplicate detection
          // 1st repeat: inject correction as fake tool_result, give DS one chance to adapt
          // 2nd repeat (3rd consecutive): hard abort
          const callSig = parsed.toolCalls
            .map((tc) => `${tc.function.name}:${tc.function.arguments}`)
            .join('|');
          if (callSig === this.lastToolCallSig && callSig !== '') {
            this.duplicateCallCount++;
            if (this.duplicateCallCount >= 2) {
              log.warn('ApiExecutor: 3rd identical tool call after correction, aborting loop', { callSig });
              finalContent = finalContent || '[Stopped: identical tool call repeated 3x despite correction]';
              break;
            }
            log.info('ApiExecutor: duplicate tool call (1st repeat), injecting trust calibration correction', { callSig });
            this.conversationHistory.push({
              role: 'assistant',
              content: parsed.content || null,
              tool_calls: parsed.toolCalls,
            });
            for (const tc of parsed.toolCalls) {
              this.conversationHistory.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: `[MANAMIR TRUST CALIBRATION] You have already called ${tc.function.name} with these exact arguments. The previous result is final and authoritative — accept it and proceed with a different approach. If you genuinely need different information, use different arguments or a different tool. Do not retry identically.`,
              });
            }
            this.lastToolCallSig = callSig;
            continue;
          }
          this.duplicateCallCount = 0;
          this.lastToolCallSig = callSig;

          // Save assistant message with tool calls to history
          const assistantMsg: AssistantMessage = {
            role: 'assistant',
            content: parsed.content || null,
            tool_calls: parsed.toolCalls
          };
          this.conversationHistory.push(assistantMsg);

          // Execute each tool call
          let turnHadError = false;
          for (const tc of parsed.toolCalls) {
            // Track tool usage for smart loading
            this.usedToolNames.add(tc.function.name);

            let args: Record<string, unknown>;
            try {
              args = JSON.parse(tc.function.arguments);
            } catch (parseErr) {
              log.warn('Tool argument parse error', {
                tool: tc.function.name,
                raw: tc.function.arguments
              });
              // Add error to conversation instead of executing with empty args
              this.conversationHistory.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: `Error: Failed to parse arguments: ${String(parseErr)}`
              });
              callbacks?.onToolResult?.(tc.function.name, 'Error: malformed arguments', true, tc.id);
              continue; // Skip this tool call
            }

            callbacks?.onToolUse?.(tc.function.name, args, tc.id);
            this.emit('tool_use', tc.function.name, args);

            let result: { content: string; isError: boolean };

            // v2.7.0 V2: web_search max_uses=8 per turn.
            // Prevents cascade searching; forces synthesis after 8 calls.
            if (tc.function.name === 'web_search') {
              this.webSearchCount++;
              if (this.webSearchCount > ApiExecutor.WEB_SEARCH_MAX_USES) {
                log.warn('ApiExecutor: web_search max_uses exceeded, blocking call', {
                  count: this.webSearchCount,
                  max: ApiExecutor.WEB_SEARCH_MAX_USES,
                });
                result = {
                  content: `Error: web_search has been called ${this.webSearchCount} times this turn, exceeding max_uses=${ApiExecutor.WEB_SEARCH_MAX_USES}. You MUST synthesize your answer from the search results already gathered. Do NOT call web_search again this turn. If you cannot answer from existing results, tell the user honestly that the searches didn't find conclusive info.`,
                  isError: true,
                };
                callbacks?.onToolResult?.(tc.function.name, result.content, result.isError, tc.id);
                this.emit('tool_result', tc.function.name, result.content, result.isError);
                // Still need to append tool result so the conversation stays coherent
                this.conversationHistory.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: result.content,
                });
                turnHadError = true;
                continue; // Skip the real dispatch path
              }
            }

            if (this.toolExecutor) {
              try {
                result = await this.toolExecutor(tc.function.name, args);
              } catch (err) {
                result = {
                  content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
                  isError: true
                };
              }
            } else {
              result = { content: 'No tool executor registered', isError: true };
            }

            if (result.isError) turnHadError = true;

            // Redact credentials from tool output
            result.content = redactCredentials(result.content);

            // Apply per-tool result budget
            const budgeted = applyPerToolBudget(result.content, tc.function.name);
            result.content = budgeted.content;

            // Sanitize result (strip ANSI / control chars / pathological
            // tokens) before sending back to LLM. Default ON, opt-out via
            // MANAMIR_TOOL_SANITIZE=false. Runs AFTER per-tool budget so
            // we don't waste work sanitizing content that's about to be
            // spilled to disk anyway.
            result.content = sanitizeToolResult(result.content, tc.function.name);

            callbacks?.onToolResult?.(tc.function.name, result.content, result.isError, tc.id);
            this.emit('tool_result', tc.function.name, result.content, result.isError);

            // Append tool result message to history
            const toolMsg: ToolMessage = {
              role: 'tool',
              tool_call_id: tc.id,
              content: result.content
            };
            this.conversationHistory.push(toolMsg);
          }

          // RFC-003 改动 B: remember if any tool in this turn failed, so the
          // NEXT turn (if it produces a final answer instead of calling another
          // tool) can be checked for "AI fabricated answer despite tool failure".
          this.lastToolFailedSignal = turnHadError;

          // Consecutive error tracking. v2.6.0: instead of hard abort with
          // a placeholder string, inject a "summarize what you tried + the
          // errors" prompt and give the model one more turn to produce a
          // coherent final response. If THAT turn also fails, then truly stop.
          this.consecutiveErrors = turnHadError ? this.consecutiveErrors + 1 : 0;
          if (this.consecutiveErrors === 3) {
            log.warn('ApiExecutor: 3 consecutive error turns — requesting summary instead of abort');
            this.conversationHistory.push({
              role: 'user',
              content: '[System: The previous tool calls have failed 3 times in a row. Stop calling tools. In your next reply, briefly summarize: (1) what you were trying to accomplish, (2) which tools failed and why, (3) what the user could do (different inputs, manual workaround, etc.). Output ONLY this summary — no further tool calls.]'
            });
            // Don't break — let the next turn produce the summary.
            // Bump consecutiveErrors so a 4th failure does abort.
            turns++;
            continue;
          }
          if (this.consecutiveErrors >= 4) {
            log.error('ApiExecutor: 4+ consecutive errors despite summary request, aborting', {
              consecutiveErrors: this.consecutiveErrors
            });
            finalContent = finalContent || '[Stopped: tool errors persisted after summary request]';
            break;
          }

          // Loop detection via LoopDetector
          const turnSummary = parsed.toolCalls
            .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
            .join('; ');
          const loopLevel = this.loopDetector.record(turnSummary);
          if (loopLevel === 'critical') {
            log.error('ApiExecutor: loop detector CRITICAL, aborting');
            finalContent = '[Stopped: repetitive loop detected]';
            break;
          }
          if (loopLevel === 'warning') {
            // Append a hint to the last tool result to nudge the model
            const lastMsg = this.conversationHistory[this.conversationHistory.length - 1];
            if (lastMsg.role === 'tool') {
              lastMsg.content += '\n[SYSTEM: Warning — you appear to be repeating similar actions. Try a different approach or provide a final answer.]';
            }
          }

          turns++;
          continue;
        }

        // No tool calls — check for empty-promise responses before accepting as final.
        // RFC-003: kept threshold at 2 (3 attempts total) — pattern fix alone (Chinese
        // search verbs added to looksLikeEmptyPromise) solves the "让我搜索" cascade.
        if (this.continueInjections < 2 && this.looksLikeEmptyPromise(parsed.content)) {
          this.continueInjections++;
          log.info('ApiExecutor: empty promise detected, injecting continue', {
            injection: this.continueInjections,
            snippet: parsed.content.slice(0, 80)
          });
          this.conversationHistory.push({
            role: 'assistant',
            content: parsed.content,
            tool_calls: undefined
          });
          this.conversationHistory.push({
            role: 'user',
            content: '[System: You said you would do something — do it now using your tools. Don\'t just describe what you plan to do.]'
          });
          turns++;
          continue;
        }

        // RFC-003 改动 B: detect "tool failed → AI fabricated answer" pattern.
        // Bug case: web_fetch returns 401, AI responds "根据系统配置..." without
        // citing the tool result. Inject correction nudging AI to either retry
        // with a different tool or admit failure honestly.
        if (
          this.fakeAnswerInjections < 2 &&
          this.lastToolFailedSignal &&
          this.looksLikeFabricatedAfterToolFail(parsed.content)
        ) {
          this.fakeAnswerInjections++;
          log.info('ApiExecutor: fake answer after tool failure detected, injecting recovery', {
            injection: this.fakeAnswerInjections,
            snippet: parsed.content.slice(0, 100)
          });
          this.conversationHistory.push({
            role: 'assistant',
            content: parsed.content,
            tool_calls: undefined
          });
          this.conversationHistory.push({
            role: 'user',
            content: '[System: The previous tool call FAILED. Do NOT fabricate an answer from your training knowledge. Either: (a) call a different tool (e.g., web_search instead of web_fetch for API endpoints, or grep instead of read for blocked .env), or (b) tell the user honestly that the tool failed and explain why you cannot answer. Citing or quoting the tool error is fine.]'
          });
          // Reset the signal so we don't keep nudging on the same failure
          this.lastToolFailedSignal = false;
          turns++;
          continue;
        }

        finalContent = parsed.content;

        // V1 Phase C3 (2026-04-23): inline factual-verifier check BEFORE
        // committing this final answer. If verifier FAILs, inject correction
        // + skip break + let loop re-generate. Capped at MAX_RETRIES to avoid
        // infinite verify-fix-verify-fix loops.
        if (
          finalContent.length > 0 &&
          this.factualVerifierHook &&
          this.factualVerifierRetries < ApiExecutor.FACTUAL_VERIFIER_MAX_RETRIES
        ) {
          const verifierCheck = this.factualVerifierTrigger(
            finalContent,
            Array.from(this.usedToolNames)
          );
          if (verifierCheck.trigger) {
            log.warn('ApiExecutor: factual-verifier trigger fired', {
              reason: verifierCheck.reason,
              contentLen: finalContent.length,
              toolsUsed: Array.from(this.usedToolNames),
              retries: this.factualVerifierRetries,
            });
            try {
              const verdict = await this.factualVerifierHook(
                prompt,
                finalContent,
                Array.from(this.usedToolNames),
                verifierCheck.reason!
              );
              log.info('ApiExecutor: factual-verifier verdict', {
                verdict: verdict.verdict,
                reason: verdict.reason,
                fix: verdict.fix,
              });
              if (verdict.verdict === 'FAIL') {
                // Push the FAIL'd answer to history (so DS sees what it just said)
                this.conversationHistory.push({
                  role: 'assistant',
                  content: finalContent,
                  tool_calls: undefined,
                });
                // Inject correction message + retry one more turn
                this.conversationHistory.push({
                  role: 'user',
                  content: `[Verifier flagged: ${verdict.reason ?? 'factual issue detected in your previous answer'}. ${verdict.fix ?? 'Please redo the answer using web_search for external facts and include [Source: <url>] citations.'}]`,
                });
                this.factualVerifierRetries++;
                log.info('ApiExecutor: verifier FAIL → injecting correction + retrying', {
                  retries: this.factualVerifierRetries,
                });
                turns++;
                continue; // Skip the break, let loop re-generate
              }
            } catch (err) {
              log.warn('ApiExecutor: factual-verifier hook errored', {
                error: err instanceof Error ? err.message : String(err),
              });
              // On hook error, accept the answer as-is (don't block user)
            }
          }
        }

        // Save assistant response to history (PASS or no-trigger or no-hook path)
        this.conversationHistory.push({
          role: 'assistant',
          content: finalContent,
          tool_calls: undefined
        });

        break;
      }

      if (turns >= this.maxTurns) {
        log.warn('ApiExecutor: max turns reached', { maxTurns: this.maxTurns });
        finalContent = finalContent || '[Agent loop reached maximum turns without final response]';
      }

      // Bug 8 fix: trim history by TOKENS not message count.
      // Messages may be huge (long tool outputs); 60 small messages != 60 huge ones.
      const TRIM_BUDGET_TOKENS = 50_000;
      const MIN_KEEP_MESSAGES = 6;
      if (this.conversationHistory.length > MIN_KEEP_MESSAGES) {
        // Drop oldest messages one by one until we're under budget
        // (always keep at least the last MIN_KEEP_MESSAGES messages)
        while (
          this.conversationHistory.length > MIN_KEEP_MESSAGES &&
          estimateTokens(this.conversationHistory) > TRIM_BUDGET_TOKENS
        ) {
          this.conversationHistory.shift();
        }
      }

      const result: StreamEventResult = {
        type: 'result',
        subtype: 'success',
        result: finalContent,
        session_id: '',
        duration_ms: Date.now() - startTime,
        num_turns: turns + 1,
        is_error: false
      };

      callbacks?.onComplete?.(result);
      return result;

    } catch (error) {
      if (this.abortController?.signal.aborted) {
        throw new Error('Request aborted');
      }
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks?.onError?.(err);
      throw err;
    } finally {
      this.options.model = originalModel;
      this.abortController = null;
    }
  }

  /**
   * Inject auxiliary system messages for the upcoming turn:
   *   - SelfReview lessons that match the prompt's keywords
   *   - Skill recommendations from the tier-1 catalog
   *   - Plan-mode hint when the prompt looks complex
   *
   * Each block is pushed as its own system message so the compressor /
   * dedupe in buildMessages can handle them independently. Failures are
   * swallowed (logged) so the executor never aborts because a side
   * subsystem misbehaved.
   */
  private injectAuxiliaryContext(prompt: string): void {
    // C-3 fix: prune stale auxiliary system blocks from prior turns BEFORE
    // injecting fresh ones for this turn. Otherwise lesson/skill/plan-mode
    // blocks accumulate forever (5 turns = 5 sets of blocks), wasting tokens
    // and leaking stale plan-mode "WAIT for user reply" hints into new prompts.
    //
    // Tag families enumerated in AUXILIARY_PREFIXES (module-level) so the
    // dedup logic in buildMessages stays in sync — adding a new aux block
    // type only requires updating the constant.
    this.conversationHistory = this.conversationHistory.filter((msg) => {
      if (msg.role !== 'system') return true;
      return !isAuxiliarySystemContent(msg.content || '');
    });

    // 1. SelfReview lessons
    try {
      const lessons = injectSelfReviewsForTask(prompt);
      if (lessons) {
        this.conversationHistory.push({ role: 'system', content: lessons });
        const count = (lessons.match(/^- \[/gm) ?? []).length;
        log.info('SelfReview: lessons injected', { count, promptLen: prompt.length });
      }
    } catch (err) {
      log.warn('SelfReview: injection failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Skill recommendations
    try {
      const skills = listSkillsTier1();
      const recs = recommendSkillsForTask(prompt, skills);
      if (recs.length > 0) {
        const block = formatSkillRecommendations(recs, skills);
        if (block) {
          this.conversationHistory.push({ role: 'system', content: block });
          log.info('SkillSynth: skill recommendations injected', {
            count: recs.length,
            top: recs.slice(0, 3).map((r) => ({ name: r.skillName, score: Number(r.score.toFixed(3)) })),
          });
        }
      }
    } catch (err) {
      log.warn('SkillSynth: recommendation injection failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. Plan-mode auto-trigger (or manual override)
    try {
      let decision: PlanModeDecision | null = consumePlanModeOverride();
      if (!decision) decision = shouldEnterPlanMode(prompt);
      if (decision.shouldPlan) {
        const planBlock = formatPlanModePrompt(decision);
        this.conversationHistory.push({ role: 'system', content: planBlock });
        log.info('PlanMode: entered', {
          reason: decision.reason,
          triggerKeywords: decision.triggerKeywords,
        });
      }
    } catch (err) {
      log.warn('PlanMode: detector failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private buildMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // Build system prompt with profile hints
    let systemContent = this.options.systemPrompt || '';
    if (this.profile.systemPromptHints) {
      systemContent = systemContent
        ? `${systemContent}\n\n${this.profile.systemPromptHints}`
        : this.profile.systemPromptHints;
    }
    if (this.profile.aggressiveToolUse) {
      systemContent += '\nOnly use tools when explicitly needed. Do not call tools unnecessarily.';
    }
    if (this.profile.behaviorPrompt) {
      systemContent = systemContent
        ? `${systemContent}\n\n${this.profile.behaviorPrompt}`
        : this.profile.behaviorPrompt;
    }
    // v2.6.0: one-shot recovery hint after a guard-aborted stream. Cleared
    // immediately so it doesn't pollute subsequent turns.
    if (this.pendingRecoveryHint) {
      systemContent = systemContent
        ? `${systemContent}\n\n${this.pendingRecoveryHint}`
        : this.pendingRecoveryHint;
      this.pendingRecoveryHint = null;
    }
    if (systemContent) {
      messages.push({ role: 'system', content: systemContent });
    }

    // Dedupe history: keep compaction-marker system messages (those generated by the
    // compressor) AND auxiliary injection blocks (selfReview lessons, skill
    // suggestions, plan-mode hints), but drop any system message that
    // duplicates the live system prompt. Non-system messages pass through
    // unchanged.
    for (const msg of this.conversationHistory) {
      if (msg.role === 'system') {
        const content = msg.content || '';
        const isCompactionMarker = content.startsWith('[CONTEXT COMPACTION');
        const isAuxiliaryInjection = isAuxiliarySystemContent(content);
        const isDuplicateLive = !!systemContent && content === systemContent;
        if ((isCompactionMarker || isAuxiliaryInjection) && !isDuplicateLive) {
          messages.push(msg);
        }
        // Otherwise: drop (it's either a duplicate of the live prompt or a stale system msg)
        continue;
      }
      messages.push(msg);
    }
    return messages;
  }

  /**
   * RFC-003 改动 B: detect "AI fabricated answer despite tool failure" pattern.
   * Triggers only when caller has already verified previous tool turn failed.
   * Looks for fabrication indicators (knowledge-from-training language) WITHOUT
   * any citation of the tool error/result.
   */
  private looksLikeFabricatedAfterToolFail(text: string): boolean {
    if (!text || text.length < 30) return false;
    // Fabrication indicators: AI is citing internal knowledge instead of tool result
    const fabricationPatterns = [
      // Chinese
      /根据(系统配置|官方信息|官方文档|我的知识|我所了解|我了解到|我的训练数据)/,
      /据我所知/,
      /^根据/m,
      /我知道的[，,。]/,
      /(deepseek|官方|文档).{0,15}(主要|目前|当前).{0,20}(支持|提供|包括)/,
      // English
      /Based on (the system|my (knowledge|training|understanding)|what I know|publicly available)/i,
      /According to (my (knowledge|training)|publicly|the official)/i,
      /From what I (know|understand|recall)/i,
      /^Here(?:'s| is) (?:what|the) (?:I know|information)/im,
    ];
    const hasFabrication = fabricationPatterns.some(p => p.test(text));
    if (!hasFabrication) return false;

    // Anti-false-positive: if AI properly references the tool failure, it's
    // not fabricating — it's recovering honestly.
    const honestlyAcknowledged =
      /(tool|web_fetch|web_search|工具|fetch).{0,30}(failed|error|returned|401|403|404|5\d\d|无法|失败|返回了?\s*\d{3}|被拦|policy)/i.test(text) ||
      /(I (cannot|can't|am unable|was unable)|无法|不能|没办法).{0,40}(because|since|the URL|the tool|由于|因为|工具)/i.test(text);
    if (honestlyAcknowledged) return false;

    return true;
  }

  private looksLikeEmptyPromise(text: string): boolean {
    if (!text || text.length > 500) return false;
    const promisePatterns = [
      // Investigative verbs (original)
      /I'll\s+(look|check|search|investigate|try|do|run|find|read|examine)/i,
      /Let me\s+(check|look|search|try|find|read|examine|investigate)/i,
      /I will\s+(now|proceed|go ahead|start)/i,
      /I'm going to\s+(check|look|search|try|find|read)/i,
      // Creative verbs — DeepSeek loops on these (e.g. "I'll create a binary search tree...")
      /I'll\s+(create|write|generate|implement|build|make|design|provide|show|give|prepare|construct|develop)/i,
      /Let me\s+(create|write|generate|implement|build|make|design|provide|show|give|prepare|construct|develop)/i,
      /I will\s+(create|write|generate|implement|build|make|design|provide|show|give|prepare|construct|develop)/i,
      /I'm going to\s+(create|write|generate|implement|build|make|design|provide|show|give|prepare|construct|develop)/i,
      /Here'?s?\s+(a|an|the)\s+\w+\s+(for you|implementation|example|code)/i,
      // Chinese counterparts (creative verbs)
      /我(来|帮你|为你)?(写|创建|实现|生成|准备|构建|做)/,
      /好的[，,]\s*我(来|帮你|为你)/,
      // RFC-003 改动 A: Chinese search/investigate verbs (was missing)
      // Bug case: "让我搜索一下DeepSeek的模型信息" repeated 5 times
      /让我\s*(搜索|搜一?下|查一?下|看一?下|找一?下|帮你查|帮你搜|帮你找)/,
      /我(来|要|去|先)?\s*(帮你)?\s*(搜索|搜一?下|查一?下|看一?下|找一?下|查询|检索)/,
      /让我先\s*(搜索|搜|查|看|找|了解|确认)/,
      /好的[，,。]\s*让我\s*(搜|查|看|找)/,
    ];
    const hasPromise = promisePatterns.some(p => p.test(text));
    if (!hasPromise) return false;
    // If the text already contains a code block / actual result, it's not just a promise.
    // Includes both English and Chinese result-cite keywords.
    const hasResult =
      /```|found|result|error|output|here's|here is|the file|the content/i.test(text) ||
      /(搜索结果|结果是|结果显示|找到了?|内容是|文件内容|输出是|返回了?\s*\d|已完成|完成了)/.test(text);
    return !hasResult;
  }

  private async parseSSEStream(response: Response, callbacks?: ExecutorCallbacks): Promise<StreamParseResult> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let usage: { promptTokens: number; completionTokens: number; cacheHitTokens?: number } | null = null;
    let finishReason: string | undefined;
    let abortedByGuard: 'stall' | 'cascade' | 'ngram-repeat' | 'dsml-leak' | 'short-sentence-repeat' | undefined;
    const thinkFilter = new ThinkFilter();

    // v2.6.0 stream watchdog: per-model 3-tier stall detection. Soft-aborts
    // via reader.cancel() at abortMs; hard-kills the response body at killMs
    // if cancel() itself hangs. Per-chunk tick() resets the timers.
    const watchdog = new StreamWatchdog(this.options.model);
    let watchdogTriggered: 'abort' | 'kill' | null = null;
    watchdog.on('stall', (report) => {
      if (report.event === 'abort' || report.event === 'kill') {
        watchdogTriggered = report.event;
      }
    });
    watchdog.start({
      softAbort: async () => {
        try { await reader.cancel(); } catch { /* already cancelled/closed */ }
      },
      hardKill: () => {
        // Last resort: cancel response body directly + abort our controller
        try { (response.body as { cancel?: () => void } | null)?.cancel?.(); } catch { /* ignore */ }
        try { this.abortController?.abort(); } catch { /* ignore */ }
      },
    });

    // v2.6.0 N-gram rolling-hash detector: catches repeats that the regex
    // CASCADE_PATTERNS miss (same JSON output, same code block, paragraph
    // duplication). Skips inside ``` fences automatically.
    const nGram = new RollingHashDetector();

    // v2.7.0 V0 Short-sentence detector: second layer for short preamble
    // self-repeats (e.g. DeepSeek emitting "我来帮你...。我来帮你...。" before
    // tool_use). N-gram is blind to this (windowSize=64 / minBuffer=256).
    // Active only in preamble (content < 200 chars) to avoid false-positives
    // on long enumerated answers with refrain phrases.
    const shortSent = new ShortSentenceDetector();

    // Tool call accumulators keyed by index
    const toolAccumulators = new Map<number, ToolCallAccumulator>();

    // Streaming repetition guard. DeepSeek-chat sometimes loops on its
    // opening sentence ("好的，我来为你..." / "I'll create a...") indefinitely.
    //
    // 2026-04-21 v6 — PATTERN-BASED (final): earlier sentence-split approach
    // (v3-v5) false-positived on C++ code (TreeNode / node->val gets split by
    // \n or .). Now we count occurrences of known empty-promise regexes in
    // accumulated content. Code blocks naturally don't match these patterns,
    // so false positives are minimal. 没做内容检测，
    // 这是 manamir 专为弱模型（DeepSeek/Qwen/Yi）加的兜底。
    const CASCADE_PATTERNS: RegExp[] = [
      // Chinese empty-promise cascades
      /让我\s*(搜索|搜一?下|查一?下|看一?下|找一?下|帮你查|帮你搜|帮你找)/g,
      /我(来|要|去|先)?\s*(帮你)?\s*(搜索|搜一?下|查一?下|看一?下|找一?下|查询|检索)/g,
      /我(来|帮你|为你)?\s*(写|创建|实现|生成|准备|构建|做)(一个)?/g,
      /好的[，,。]\s*我(来|帮你|为你)/g,
      // English empty-promise cascades
      /\bI'?ll\s+(look|check|search|investigate|try|do|run|find|read|examine|create|write|implement|build|make)/gi,
      /\bLet me\s+(check|look|search|try|find|read|examine|investigate|create|write|implement|build|make)/gi,
    ];
    const CASCADE_THRESHOLD = 3; // 3+ empty-promise matches → abort
    const CASCADE_MIN_CONTENT = 60; // only check after content grows
    let repetitionAborted = false;

    try { while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Watchdog: any byte from upstream is proof of life. Reset stall timers.
      watchdog.tick();

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') continue;

        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6);
          try {
            const chunk = JSON.parse(jsonStr);
            // Capture finish_reason from any chunk (OpenAI puts it on the
            // last delta-bearing chunk, before the [DONE] sentinel).
            const fr = chunk.choices?.[0]?.finish_reason;
            if (fr && typeof fr === 'string') finishReason = fr;
            // Capture usage from final chunk (OpenAI sends it in the last
            // SSE event when stream_options.include_usage is true).
            if (chunk.usage && typeof chunk.usage === 'object') {
              const u = chunk.usage as {
                prompt_tokens?: number;
                completion_tokens?: number;
                // DeepSeek + Anthropic both surface cache breakdown in usage.
                // DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens.
                // Anthropic: cache_read_input_tokens / cache_creation_input_tokens.
                prompt_cache_hit_tokens?: number;
                cache_read_input_tokens?: number;
              };
              if (typeof u.prompt_tokens === 'number' || typeof u.completion_tokens === 'number') {
                const cacheHit = Number(u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens) || 0;
                usage = {
                  promptTokens: Number(u.prompt_tokens) || 0,
                  completionTokens: Number(u.completion_tokens) || 0,
                  cacheHitTokens: cacheHit > 0 ? cacheHit : undefined,
                };
              }
            }
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // Text content — filter out think blocks
            if (delta.content) {
              const filtered = thinkFilter.feed(delta.content);
              if (filtered) {
                content += filtered;

                // 2026-04-21 fix: gate emit on !repetitionAborted. Without this,
                // chunks queued after abort detection still streamed to user before
                // reader.cancel() actually propagated upstream → user saw 8+
                // repeated sentences even after detection fired.
                if (!repetitionAborted) {
                  callbacks?.onText?.(filtered);
                  this.emit('text', filtered);
                }

                // Pattern-based repetition detection (v6 final).
                // 数 empty-promise 正则在 content 里的命中次数。代码无 pattern
                // → 不会误伤；cascade 天然命中 pattern 多次 → abort。
                if (
                  !repetitionAborted &&
                  content.length >= CASCADE_MIN_CONTENT
                ) {
                  let totalMatches = 0;
                  let triggerPattern = '';
                  for (const pat of CASCADE_PATTERNS) {
                    pat.lastIndex = 0; // reset stateful regex
                    const matches = content.match(pat);
                    const n = matches ? matches.length : 0;
                    if (n >= CASCADE_THRESHOLD) {
                      totalMatches = n;
                      triggerPattern = pat.source;
                      break;
                    }
                    totalMatches += n;
                  }
                  if (totalMatches >= CASCADE_THRESHOLD) {
                    repetitionAborted = true;
                    abortedByGuard = 'cascade';
                    log.warn('ApiExecutor: aborting stream — empty-promise cascade detected', {
                      pattern: triggerPattern || '(combined)',
                      matches: totalMatches,
                      contentLen: content.length,
                    });
                    try {
                      await reader.cancel();
                    } catch {
                      // ignore — cancel may throw if stream already closed
                    }
                    break;
                  }
                }

                // DS2: DSML protocol leak detection. DeepSeek occasionally emits
                // internal protocol tokens (<｜...｜>) into content stream
                // instead of properly using tool_calls field. Detect on accumulated
                // content (catches cross-chunk leaks) + abort + recovery hint.
                if (!repetitionAborted && /<\uFF5C(DSML|begin_of|end_of|tool|function)/i.test(content)) {
                  repetitionAborted = true;
                  abortedByGuard = 'dsml-leak';
                  log.warn('ApiExecutor: aborting stream — DSML protocol leak detected', {
                    sample: content.slice(-200),
                    contentLen: content.length,
                  });
                  try {
                    await reader.cancel();
                  } catch {
                    // ignore — stream may already be closed
                  }
                  break;
                }

                // v2.6.0: N-gram rolling-hash detection (parallel to CASCADE_PATTERNS).
                // Catches structural repeats (same JSON / same paragraph) that
                // verbal-cascade regex misses. Skips inside ``` fences automatically.
                if (!repetitionAborted) {
                  const repeat = nGram.feed(filtered);
                  if (repeat.detected) {
                    repetitionAborted = true;
                    abortedByGuard = 'ngram-repeat';
                    log.warn('ApiExecutor: aborting stream — N-gram repeat detected', {
                      ngram: (repeat.ngram ?? '').slice(0, 60) + '…',
                      hits: repeat.hits,
                      contentLen: content.length,
                    });
                    try {
                      await reader.cancel();
                    } catch {
                      // ignore
                    }
                    break;
                  }
                }

                // v2.7.0 V0: Short-sentence repeat detection (preamble only).
                // Catches DeepSeek emitting same opener 2× before tool_use,
                // which N-gram is blind to (window/threshold too coarse).
                if (!repetitionAborted) {
                  const sRepeat = shortSent.feed(filtered, content.length);
                  if (sRepeat.detected) {
                    repetitionAborted = true;
                    abortedByGuard = 'short-sentence-repeat';
                    log.warn('ApiExecutor: aborting stream — short-sentence repeat detected', {
                      sentence: (sRepeat.sentence ?? '').slice(0, 40) + '…',
                      hits: sRepeat.hits,
                      contentLen: content.length,
                    });
                    try {
                      await reader.cancel();
                    } catch {
                      // ignore
                    }
                    break;
                  }
                }
              }
            }

            // DeepSeek R1 reasoning_content
            if (delta.reasoning_content) {
              reasoning += delta.reasoning_content;
              callbacks?.onThinking?.(delta.reasoning_content);
              this.emit('thinking', delta.reasoning_content);
            }

            // Tool calls — accumulate across chunks
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.index === undefined || tc.index === null) continue;
                const idx = tc.index;

                if (!toolAccumulators.has(idx)) {
                  toolAccumulators.set(idx, {
                    index: idx,
                    id: tc.id || '',
                    functionName: tc.function?.name || '',
                    argumentChunks: tc.function?.arguments || ''
                  });
                } else {
                  const acc = toolAccumulators.get(idx)!;
                  if (tc.id) acc.id = tc.id;
                  if (tc.function?.name && !acc.functionName) acc.functionName = tc.function.name;
                  if (tc.function?.arguments) acc.argumentChunks += tc.function.arguments;
                }
              }
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
      if (repetitionAborted) break;
    } } finally {
      // Always stop the watchdog — leaving timers live pins the event loop.
      watchdog.stop();
    }

    // Mark stall-aborts in the result so the executor loop can react.
    if (watchdogTriggered && !abortedByGuard) {
      abortedByGuard = 'stall';
      log.warn('ApiExecutor: stream parsed after watchdog trigger', {
        triggered: watchdogTriggered,
      });
    }

    // Flush think filter buffer
    const flushed = thinkFilter.flush();
    if (flushed) {
      content += flushed;
      // Don't emit flushed content if we already aborted — user shouldn't see
      // tail content after an abort message would have shown.
      if (!repetitionAborted) {
        callbacks?.onText?.(flushed);
        this.emit('text', flushed);
      }
    }
    if (thinkFilter.reasoning) {
      reasoning += thinkFilter.reasoning;
    }

    // Convert accumulators to final tool calls
    const toolCalls: ToolCall[] = [];
    const sorted = [...toolAccumulators.values()].sort((a, b) => a.index - b.index);
    for (const acc of sorted) {
      toolCalls.push({
        id: acc.id,
        type: 'function',
        function: {
          name: acc.functionName,
          arguments: acc.argumentChunks
        }
      });
    }

    return { content, toolCalls, reasoning, usage, finishReason, abortedByGuard };
  }

  /** Clear conversation history (start fresh) */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /** Get current history length */
  get historyLength(): number {
    return this.conversationHistory.length;
  }

  /**
   * Replace the conversationHistory with the given messages. Used by
   * SessionManager.adoptSession to seed an executor with a session's saved
   * history before the next turn. Only user/assistant text messages are
   * accepted — tool_calls are not replayed (they belonged to a different
   * agent loop and would not match any pending tool_call_id).
   */
  preloadHistory(messages: Array<{ role: 'user' | 'assistant'; content: string }>): void {
    this.conversationHistory = messages.map((m) => {
      if (m.role === 'user') {
        return { role: 'user', content: m.content };
      }
      return { role: 'assistant', content: m.content };
    });
  }

  kill(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  get isRunning(): boolean {
    return this.abortController !== null;
  }
}
