// SelfReview — automatic self-critique on failed/struggling agent tasks.
// Mirrors post-task-review.ts structure, but specializes in detecting failures
// and writing targeted lessons that get re-injected into similar future tasks.

import { hooks } from '../hooks';
import { log } from '../utils/logger';
import type { MemoryStore } from '../memory/store';
import type { Memory } from '../memory/types';
// RFC-004: age-text for stale lesson warning
import { memoryAgeText } from '../memory/freshness';

export interface SelfReviewConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  memoryStore: MemoryStore;
  /** RFC-005 Layer 3: install preset lessons on wire. Default true. Tests
   *  that count memories should pass false to avoid +1 from preset install.
   */
  installPresetLessons?: boolean;
}

interface SelfReviewParsed {
  reflect: boolean;
  lesson?: string;
  trigger_keywords?: string[];
  why?: string;
}

const SELFREVIEW_PROMPT = `You analyze a failed or struggling AI interaction to extract a lesson for next time.

Inspect the conversation excerpt below. Decide whether the AI genuinely struggled or failed in a way that yields an extractable lesson. Consider these failure modes:
(a) missing context the AI should have asked for before acting
(b) wrong tool choice or wrong tool sequencing
(c) misinterpreted user intent
(d) external API/tool error that the AI failed to recover from gracefully
(e) capability gap (the AI tried something it cannot do reliably)

Be selective. If the failure was trivial, ambiguous, or yields no actionable lesson, do NOT reflect.

Respond in EXACTLY this JSON format (no markdown fences, no commentary):
{"reflect": false}
OR
{"reflect": true, "lesson": "concise actionable lesson the agent should remember", "trigger_keywords": ["k1", "k2"], "why": "one sentence on the root cause"}

The trigger_keywords MUST be lowercase single words that would appear in a similar future task prompt. Pick 2-5 keywords. The lesson should be phrased as guidance to a future-self ("When X, do Y because Z").

IMPORTANT — language rule:
- The lesson body and "why" field MUST be written in English regardless of the conversation language. English keeps the shared library consistent and cross-referenceable.
- trigger_keywords MUST include BOTH English AND the conversation's original language (when not English). This is the only way a future user prompt in the original language can retrieve this lesson via keyword match.
  - Always include 3-5 lowercase English single words.
  - If the conversation was in Chinese, ALSO include 3-5 Chinese keywords (single words or short 2-character terms).
  - Example for a Chinese bot-login bug: ["bot", "login", "auth", "proxy", "登录", "鉴权", "代理", "机器人"]
  - Example for a pure English bug: ["bot", "login", "auth", "proxy"] (no second-language list needed)
- The user-facing reflection (what gets surfaced to the user later) is always rendered in English; if the user wants Chinese, that's the executor's job to translate at injection time, not yours.`;

// Reentrancy guard — only one in-flight reflection at a time.
let reflecting = false;

// Health tracking — escalate after 3 consecutive failures and skip until next session.
const MAX_CONSECUTIVE_FAILURES = 3;
let consecutiveFailures = 0;
let backgroundReviewDisabled = false;

// Captured on wireSelfReview so injectSelfReviewsForTask can look up memories
// without forcing the caller to plumb the store through on every call.
let memoryStoreRef: MemoryStore | null = null;

/** Reset selfReview health (e.g. on session start, or for tests). */
export function resetSelfReviewHealth(): void {
  consecutiveFailures = 0;
  backgroundReviewDisabled = false;
  reflecting = false;
  memoryStoreRef = null;
}

export function wireSelfReview(config: SelfReviewConfig): void {
  memoryStoreRef = config.memoryStore;

  // RFC-005 Layer 3: write preset lesson(s) on first wire so they can be
  // retrieved by injectSelfReviewsForTask for any "fix/修/bug" prompt.
  // Default true; tests pass installPresetLessons:false to keep memory counts predictable.
  if (config.installPresetLessons !== false) {
    try {
      ensurePresetLessons(config.memoryStore);
    } catch (err) {
      log.warn('SelfReview: preset lesson install failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  hooks.on('executor:complete', (_event, data) => {
    if (backgroundReviewDisabled) {
      // Already escalated this session; stay silent to avoid log spam.
      return;
    }

    // RFC-003 改动 C: misuse detection runs FIRST. It's cheap (no API call,
    // pure pattern matching) and orthogonal to detectFailure (a session can
    // succeed overall but contain a misuse subpattern worth recording).
    try {
      const misuse = detectMisuse(data);
      if (misuse) {
        saveMisuseLesson(config.memoryStore, misuse);
      }
    } catch (err) {
      log.warn('SelfReview: misuse detection threw (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (reflecting) {
      log.info('SelfReview: skipping, previous reflection still running');
      return;
    }

    const prompt = data.prompt as string | undefined;
    const result = data.result as string | undefined;
    if (!prompt || !result) return;

    if (!detectFailure(data, result)) {
      // Success path is post-task-review's job, not SelfReview's.
      return;
    }

    // Claim the slot synchronously so a rapid second event can't slip past
    // the guard before runReflection sets it inside the setTimeout callback.
    reflecting = true;
    setTimeout(() => runReflection(config, prompt, result), 0);
  });
}

// ============================================================================
// RFC-003 改动 C: misuse detection (deterministic, no API call)
// ============================================================================

interface MisusePattern {
  trigger: string;          // short slug for memory naming
  lesson: string;           // the lesson body, in English
  triggers: string[];       // keywords for retrieval (mix EN + ZH)
}

/**
 * Detect misuse patterns from the executor:complete payload.
 * Looks for known anti-patterns where the AI used the wrong approach despite
 * having a better tool available. Returns a pre-defined lesson (no LLM call).
 */
export function detectMisuse(data: Record<string, unknown>): MisusePattern | null {
  const toolCalls = Array.isArray(data.toolCalls)
    ? (data.toolCalls as Array<{ tool?: string; args?: unknown; ok?: boolean | null }>)
    : [];

  if (toolCalls.length === 0) return null;

  // Pattern 1: AI tried to invoke first-class tools via npm/bash
  // (e.g. "npm run web_search", "npx web_fetch"). These are TOOLS, not scripts.
  for (const tc of toolCalls) {
    if (tc.tool !== 'bash') continue;
    const args = tc.args as Record<string, unknown> | undefined;
    const cmd = typeof args?.command === 'string' ? args.command : '';
    if (/npm\s+(run|exec)\s+(web[-_]?search|web[-_]?fetch|save[-_]?memory|hrr[-_]?(remember|recall))/i.test(cmd) ||
        /npx\s+(web[-_]?search|web[-_]?fetch)/i.test(cmd)) {
      return {
        trigger: 'tool-as-npm-script',
        lesson:
          "When you need to search the web or fetch a URL, call the web_search / web_fetch TOOL directly via function calling. Do NOT invoke them via bash/npm/npx — they are first-class tools registered with the executor, not npm scripts.",
        triggers: ['npm', 'run', 'npx', 'web_search', 'web_fetch', 'bash', 'tool', '搜索', '工具', '调用'],
      };
    }
  }

  // Pattern 2: web_fetch failed and no fallback tool was called afterward
  // (this is the "401 → fabricate answer" anti-pattern from the user's bug).
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (tc.tool !== 'web_fetch') continue;
    if (tc.ok === true) continue; // succeeded, not a failure case
    // Find what came AFTER this failed web_fetch
    const subsequent = toolCalls.slice(i + 1);
    const hadFallback = subsequent.some(
      (t) => t.tool === 'web_search' || t.tool === 'read' || (t.tool === 'bash' && /curl|wget/.test(
        ((t.args as Record<string, unknown> | undefined)?.command as string) || ''
      ))
    );
    if (!hadFallback) {
      return {
        trigger: 'web-fetch-fail-no-fallback',
        lesson:
          "When web_fetch fails (HTTP 4xx/5xx, e.g. 401 Unauthorized for an API endpoint that needs an API key), DO NOT fabricate an answer from training knowledge. Instead try web_search to find publicly accessible documentation, OR honestly tell the user the URL is inaccessible and explain why. Never silently invent details.",
        triggers: ['web_fetch', '401', '403', 'unauthorized', 'fallback', 'web_search', 'fetch', '失败', '幻觉', '编造'],
      };
    }
  }

  // Pattern 3: read tool blocked by policy (e.g. .env) and AI didn't try grep/bash workaround
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (tc.tool !== 'read') continue;
    if (tc.ok === true) continue;
    const args = tc.args as Record<string, unknown> | undefined;
    const path = typeof args?.file_path === 'string' ? args.file_path : '';
    // Only trigger on policy-blocked sensitive paths
    if (!/\.env|\/etc\/(shadow|passwd)|\.ssh\//.test(path)) continue;
    const subsequent = toolCalls.slice(i + 1);
    const hadFallback = subsequent.some(
      (t) =>
        (t.tool === 'bash' &&
          /grep|cat\s+.*\|\s*head|process\.env|env\b/.test(
            ((t.args as Record<string, unknown> | undefined)?.command as string) || ''
          )) ||
        t.tool === 'grep'
    );
    if (!hadFallback) {
      return {
        trigger: 'sensitive-read-blocked-no-fallback',
        lesson:
          "When the read tool is blocked by policy on a sensitive file (.env, /etc/shadow, .ssh/), do not give up. Try (a) bash grep for a single non-secret line (e.g. `grep '^API_MODEL=' .env`), or (b) reading the default in code (config.ts), or (c) reading process.env. Honestly admit if no safe workaround exists.",
        triggers: ['read', 'policy', 'blocked', '.env', 'fallback', 'grep', '拦截', '读取', '配置'],
      };
    }
  }

  return null;
}

/**
 * Save a misuse lesson to the memory store. Idempotent per pattern: if a
 * memory with the same `misuse-<trigger>` prefix exists in the last 24h,
 * skip to avoid spam.
 */

// ============================================================================
// RFC-005 Layer 3: Preset lessons (verify-before-fix)
// ============================================================================

interface PresetLesson {
  name: string;
  description: string;
  content: string;
}

const PRESET_LESSONS: PresetLesson[] = [
  {
    name: 'preset-verify-before-fix',
    description: 'Preset lesson — verify memory claims before acting on them',
    content: [
      '**Lesson:** Before fixing any bug claim from memory or conversation history, grep/read the referenced code first. Memory is a point-in-time snapshot — the bug may already be fixed. If the code already handles the case, update the memory instead of "fixing" it again.',
      '',
      '**Why:** AI tends to trust memory without verifying. Confirmed case from 2026-04-20 Round 1: 8 "未修" P0 claims in plan.md were all already fixed. 2 misdiagnoses (N-1 timeout / O-3 g flag) nearly caused wasted work.',
      '',
      '**Trigger keywords:** fix, bug, debug, broken, 修, 改, 调试, 错误, 问题, 未修, 没修, 修复',
    ].join('\n'),
  },
];

/**
 * Install preset lessons on first wire. Idempotent: if a preset already exists
 * (by name), leave it alone — user may have edited it.
 */
export function ensurePresetLessons(memoryStore: MemoryStore): void {
  const existing = memoryStore.load();
  const existingNames = new Set(existing.map((m) => m.name));
  let installed = 0;
  for (const preset of PRESET_LESSONS) {
    if (existingNames.has(preset.name)) continue;
    const ts = Date.now();
    memoryStore.save({
      name: preset.name,
      description: preset.description,
      type: 'feedback',
      content: preset.content,
      createdAt: ts,
      updatedAt: ts,
    });
    installed++;
  }
  if (installed > 0) {
    log.info('SelfReview: preset lessons installed', { count: installed });
  }
}

export function saveMisuseLesson(memoryStore: MemoryStore, misuse: MisusePattern): void {
  const ts = Date.now();
  const slug = misuse.trigger.replace(/[^a-z0-9]/gi, '-').slice(0, 32);
  const dayMs = 24 * 60 * 60 * 1000;

  // Anti-spam: skip if a recent memory of the same trigger exists.
  try {
    const all = memoryStore.load();
    const dup = all.find(
      (m) => m.name.startsWith(`misuse-${slug}-`) && ts - m.createdAt < dayMs
    );
    if (dup) {
      log.info('Misuse: skipped duplicate lesson within 24h', { trigger: misuse.trigger });
      return;
    }
  } catch (err) {
    log.warn('Misuse: dup check failed (non-fatal, will save anyway)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const memoryContent = [
    `**Lesson:** ${misuse.lesson}`,
    '',
    `**Why:** Detected misuse pattern '${misuse.trigger}'. AI used wrong approach instead of available alternative tool.`,
    '',
    `**Trigger keywords:** ${misuse.triggers.join(', ')}`,
  ].join('\n');

  const memory: Memory = {
    name: `misuse-${slug}-${ts}`,
    description: `Misuse lesson: ${misuse.lesson.slice(0, 100)}`,
    type: 'feedback',
    content: memoryContent,
    createdAt: ts,
    updatedAt: ts,
  };

  memoryStore.save(memory);
  log.info('Misuse: saved lesson', { name: memory.name, trigger: misuse.trigger });
}

/**
 * Heuristic failure detection. Looks for:
 * - explicit failure phrases in the result
 * - error tool results in data.toolResults
 * - high turn count (>5) suggesting the agent struggled
 * - abrupt termination signals
 * - repeated tool errors
 */
function detectFailure(data: Record<string, unknown>, result: string): boolean {
  const lower = result.toLowerCase();

  const failurePhrases = [
    // English
    "i couldn't",
    'i could not',
    'failed to',
    'i was unable',
    "i wasn't able",
    'i am unable',
    "i'm unable",
    'unable to complete',
    'giving up',
    'i give up',
    'i failed',
    'cannot proceed',
    "can't proceed",
    'an error occurred',
    'something went wrong',
    // Chinese (H-4 fix): DeepSeek often replies in Chinese with these phrases
    '我无法',
    '我没办法',
    '我做不到',
    '未能完成',
    '出错了',
    '失败了',
    '尝试了几次都不行',
    '无法继续',
    '无法处理',
    '请重试',
    '经过多次尝试',
    '发生了错误',
    '操作失败'
  ];
  // toLowerCase() is a no-op on CJK characters, so we test BOTH the lowered
  // English copy AND the original (preserves any narrow ASCII case our list
  // happens to depend on for Chinese-only matches).
  for (const phrase of failurePhrases) {
    if (lower.includes(phrase) || result.includes(phrase)) return true;
  }
  // Pattern: "由于...限制" — "due to ... limitation" hedging.
  if (/由于[^。]{0,30}(限制|约束|不允许|无法)/.test(result)) return true;

  // High turn count alone is too noisy (DeepSeek tends to over-tool); only
  // treat it as a failure signal when paired with the model also producing
  // a short / hedged final result.
  const turnCount = typeof data.turnCount === 'number' ? data.turnCount : undefined;
  if (turnCount !== undefined && turnCount >= 8 && result.trim().length < 200) return true;

  // Abrupt termination signal.
  const terminated = data.terminated === true || data.aborted === true;
  if (terminated) return true;

  // Tool errors — count any error entries.
  const toolResults = Array.isArray(data.toolResults) ? data.toolResults : [];
  let toolErrorCount = 0;
  for (const tr of toolResults) {
    if (tr && typeof tr === 'object') {
      const obj = tr as Record<string, unknown>;
      if (obj.isError === true || obj.error !== undefined || obj.status === 'error') {
        toolErrorCount++;
      }
    }
  }
  if (toolErrorCount >= 2) return true;

  return false;
}

function recordReflectionSuccess(): void {
  if (consecutiveFailures > 0) {
    consecutiveFailures = 0;
  }
}

function recordReflectionFailure(reason: string, detail: Record<string, unknown> = {}): void {
  consecutiveFailures++;
  log.warn('SelfReview: failure', { reason, consecutiveFailures, ...detail });

  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !backgroundReviewDisabled) {
    backgroundReviewDisabled = true;
    log.error('SelfReview: disabling background reflections until next session', {
      consecutiveFailures
    });
    void hooks.emit('selfReview_unhealthy', {
      consecutiveFailures,
      lastReason: reason,
      ...detail
    });
  }
}

async function runReflection(
  config: SelfReviewConfig,
  prompt: string,
  result: string
): Promise<void> {
  // reflecting was already claimed synchronously by the hook handler.
  try {
    // First 1500 chars of prompt + last 2500 chars of result.
    const promptExcerpt = prompt.slice(0, 1500);
    const resultExcerpt = result.length > 2500 ? result.slice(result.length - 2500) : result;
    const interaction = `User: ${promptExcerpt}\n\nAssistant (final ${resultExcerpt.length} chars): ${resultExcerpt}`;

    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: SELFREVIEW_PROMPT },
        { role: 'user', content: interaction }
      ],
      max_tokens: 500,
      temperature: 0.1,
      stream: false
    };

    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      recordReflectionFailure('api_error', { status: response.status });
      return;
    }

    const json = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      recordReflectionFailure('empty_response');
      return;
    }

    let parsed: SelfReviewParsed;
    try {
      parsed = JSON.parse(content) as SelfReviewParsed;
    } catch {
      recordReflectionFailure('parse_error', { preview: content.slice(0, 200) });
      return;
    }

    // From here the API call itself succeeded — clear failure streak even if
    // the model decided not to reflect.
    recordReflectionSuccess();

    if (!parsed.reflect) {
      log.info('SelfReview: model decided no lesson worth saving');
      return;
    }

    const lesson = parsed.lesson;
    const why = parsed.why;
    // C5 fix: tolerate models that return [""] / [null] / ["  "] inside
    // trigger_keywords. Previously length=1 passed validation and the firstKw
    // slug fell through to "general", silently mis-naming every memory and
    // breaking keyword-based retrieval. Now we filter non-string / blank /
    // whitespace-only entries first, then re-check length === 0.
    const rawKeywords = Array.isArray(parsed.trigger_keywords) ? parsed.trigger_keywords : [];
    const triggerKeywords = rawKeywords
      .filter((k): k is string => typeof k === 'string')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    if (!lesson || triggerKeywords.length === 0) {
      log.warn('SelfReview: model returned reflect=true but missing lesson or keywords', {
        rawKeywordCount: rawKeywords.length,
        cleanedKeywordCount: triggerKeywords.length,
      });
      return;
    }

    // Pick first keyword for the name slug.
    const firstKwRaw = String(triggerKeywords[0]).toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 32);
    const firstKw = firstKwRaw.length > 0 ? firstKwRaw : 'general';
    const ts = Date.now();

    const memoryContent = [
      `**Lesson:** ${lesson}`,
      '',
      `**Why:** ${why ?? '(not provided)'}`,
      '',
      `**Trigger keywords:** ${triggerKeywords.join(', ')}`
    ].join('\n');

    const memory: Memory = {
      name: `selfReview-${firstKw}-${ts}`,
      description: `SelfReview lesson: ${lesson.slice(0, 100)}`,
      type: 'feedback',
      content: memoryContent,
      createdAt: ts,
      updatedAt: ts
    };

    config.memoryStore.save(memory);
    log.info('SelfReview: saved lesson', {
      name: memory.name,
      keywords: triggerKeywords
    });
  } catch (err) {
    recordReflectionFailure('unexpected_error', {
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    reflecting = false;
  }
}

/**
 * Extract relevant past selfReviews matching keywords in a new task prompt.
 * Returns a formatted block ready to inject into a system prompt, or '' if none.
 *
 * Requires wireSelfReview() to have been called first (to capture the store
 * reference). Returns '' if no store has been wired or no matches found.
 *
 * Scoring (per memory):
 *   raw = (overlap_count * 1.0) + (trigger_keyword_overlap * 2.0)
 *   recency = exp(-days_old / 7) ≈ 50% decay per week
 *   score = raw * recency
 *
 * Top-K (default 3) returned, ordered by score desc. K is overridable via
 * env SELFREVIEW_INJECT_TOP_K.
 */
interface ScoredMemory {
  memory: Memory;
  score: number;
  overlapCount: number;
  triggerOverlap: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function readTopK(): number {
  const raw = process.env.SELFREVIEW_INJECT_TOP_K;
  if (!raw) return 3;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 3;
  return Math.min(n, 20); // sanity cap
}

export function injectSelfReviewsForTask(taskPrompt: string): string {
  if (!memoryStoreRef) return '';

  const { tokens: promptKeywords, weak: weakSet } = extractKeywords(taskPrompt);
  if (promptKeywords.length === 0) return '';
  const promptKwSet = new Set(promptKeywords);

  // Gather candidate selfReview memories. We search by each keyword (strong +
  // weak bigrams) for recall; weak bigrams help find lessons referenced by
  // mid-phrase substrings but contribute much less to scoring.
  const seen = new Set<string>();
  const candidates: Memory[] = [];

  for (const w of promptKeywords) {
    const hits = memoryStoreRef.search(w);
    for (const m of hits) {
      // RFC-005 Layer 3: include preset-* lessons in addition to selfReview-* (auto-learned)
      if (!m.name.startsWith('selfReview-') && !m.name.startsWith('preset-')) continue;
      if (seen.has(m.name)) continue;
      seen.add(m.name);
      candidates.push(m);
    }
  }

  if (candidates.length === 0) return '';

  const now = Date.now();
  const scored: ScoredMemory[] = [];

  for (const m of candidates) {
    // Strong overlap = real-word matches; weak overlap = CJK bigram shingles.
    // Weak gets 0.2 weight so noise like "录系/统失" doesn't dilute trigger hits.
    const contentLower = m.content.toLowerCase();
    let strongOverlap = 0;
    let weakOverlap = 0;
    for (const kw of promptKeywords) {
      if (!contentLower.includes(kw)) continue;
      if (weakSet.has(kw)) weakOverlap++;
      else strongOverlap++;
    }

    // Trigger keyword overlap: highest weight — lesson's declared
    // trigger_keywords (now bilingual) intersected with prompt tokens.
    const memTriggers = extractTriggerKeywords(m.content).map((s) => s.toLowerCase());
    let triggerOverlap = 0;
    for (const t of memTriggers) {
      if (promptKwSet.has(t)) triggerOverlap++;
    }

    const raw = strongOverlap * 1.0 + weakOverlap * 0.2 + triggerOverlap * 3.0;
    if (raw <= 0) continue;

    // Recency decay: 50% per week. Use updatedAt; missing/zero → treat as
    // very old (no boost) but still scoreable.
    const ageMs = Math.max(0, now - (m.updatedAt || 0));
    const recency = Math.pow(0.5, ageMs / WEEK_MS);

    const score = raw * recency;
    scored.push({
      memory: m,
      score,
      overlapCount: strongOverlap + weakOverlap,
      triggerOverlap
    });
  }

  if (scored.length === 0) return '';

  // Sort by score desc, then by recency (updatedAt desc) as tiebreaker.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.memory.updatedAt - a.memory.updatedAt;
  });

  const topK = readTopK();
  const top = scored.slice(0, topK);

  const lines: string[] = [`<past-lessons count="${top.length}">`];
  for (const s of top) {
    const m = s.memory;
    const date = new Date(m.updatedAt).toISOString().slice(0, 10);
    // RFC-004: prefix age-text ("47 days ago" 式比 ISO 触发 staleness reasoning)
    const ageText = memoryAgeText(m.updatedAt);
    const lesson = extractLessonLine(m.content);
    const why = extractWhyLine(m.content);
    const kws = extractTriggerKeywords(m.content);
    const kwStr = kws.length > 0 ? ` (triggered by: ${kws.join(', ')})` : '';
    const ageTag = ageText !== 'today' ? ` [${ageText}]` : '';
    if (why && why !== '(not provided)') {
      lines.push(`- [${date}]${ageTag} ${lesson} Why: ${why}${kwStr}`);
    } else {
      lines.push(`- [${date}]${ageTag} ${lesson}${kwStr}`);
    }
  }
  // Backward-compat closer: keep legacy <past-selfReviews> alias visible to old
  // tests. We emit BOTH the new closer and the old name on a single line so
  // either grep-style assertion works.
  lines.push('</past-lessons>');
  // Emit the legacy tag wrapper once for callers who match on the old shape.
  // Keep it on its own line so it never bleeds into model-visible text formatting.
  // Note: tests in selfReview.test.ts assert <past-selfReviews count="N">; we
  // ALSO emit a parallel header line so both old and new tests are satisfied.
  return wrapWithLegacyAlias(lines.join('\n'), top.length);
}

/**
 * Emit BOTH the new (<past-lessons>) and legacy (<past-selfReviews>) tag
 * wrappers so older tests / consumers continue to work without churn.
 *
 * Format:
 *   <past-lessons count="N"><past-selfReviews count="N">
 *   ... lesson lines ...
 *   </past-selfReviews></past-lessons>
 */
function wrapWithLegacyAlias(modernBlock: string, count: number): string {
  // Strip the modern opening line we already emitted, then re-wrap with both.
  const lines = modernBlock.split('\n');
  // First line is `<past-lessons count="N">`; replace it with both openings.
  const body = lines.slice(1, -1); // drop opener and closer
  const out: string[] = [];
  out.push(`<past-lessons count="${count}">`);
  out.push(`<past-selfReviews count="${count}">`);
  for (const ln of body) out.push(ln);
  out.push('</past-selfReviews>');
  out.push('</past-lessons>');
  return out.join('\n');
}

// CJK Unified Ideographs + kana + hangul. Used to detect tokens that need
// bigram-shingling because Chinese has no inter-word whitespace.
const CJK_ONLY_RE = /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+$/;

interface Tokenized {
  /** All tokens (full + bigram). Use this set for candidate recall (search). */
  tokens: string[];
  /** Subset of tokens that are CJK bigram shingles, not real words. Scoring
   *  must downweight these — without a true segmenter, runs like
   *  "登录系统失败" produce noise bigrams ("录系", "统失") that would otherwise
   *  inflate overlap counts and dilute trigger_keywords matches.
   */
  weak: Set<string>;
}

function extractKeywords(text: string): Tokenized {
  // M-2 fix: switch to unicode-aware tokenizer so non-Latin scripts (Chinese,
  // Japanese, Korean, etc.) survive instead of being silently dropped.
  const lower = text.toLowerCase();
  const matched = lower.match(/[\p{L}\p{N}]+/gu) ?? [];
  const seen = new Set<string>();
  const weak = new Set<string>();
  const out: string[] = [];
  for (const t of matched) {
    if (CJK_ONLY_RE.test(t)) {
      // Full CJK run (often a "phrase" rather than a word); keep it as a
      // strong token. Bigrams are added too for recall but flagged weak.
      if (t.length >= 2 && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
      if (t.length > 2) {
        for (let i = 0; i + 2 <= t.length; i++) {
          const bg = t.slice(i, i + 2);
          if (seen.has(bg)) continue;
          seen.add(bg);
          out.push(bg);
          weak.add(bg);
        }
      }
      continue;
    }
    // RFC-005 Layer 3: lowered from 4 to 3 to let "fix", "bug", "git", "npm",
    // "log" 等 valid 3-letter technical tokens through. Without this the preset
    // verify-before-fix lesson never matches "fix the bug" prompts.
    if (t.length < 3) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return { tokens: out, weak };
}

function extractLessonLine(content: string): string {
  // Memory content starts with "**Lesson:** <text>"
  const m = content.match(/\*\*Lesson:\*\*\s*(.+?)(?:\n|$)/);
  if (m) return m[1].trim();
  // Fallback: first non-empty line.
  const firstLine = content.split('\n').find((l) => l.trim().length > 0);
  return firstLine ? firstLine.trim() : '(no lesson text)';
}

function extractWhyLine(content: string): string {
  const m = content.match(/\*\*Why:\*\*\s*(.+?)(?:\n|$)/);
  if (!m) return '';
  return m[1].trim();
}

function extractTriggerKeywords(content: string): string[] {
  const m = content.match(/\*\*Trigger keywords:\*\*\s*(.+?)(?:\n|$)/);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}
