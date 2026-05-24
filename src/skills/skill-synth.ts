// SkillSynth-style skill extractor — watches successful tool sequences and proposes
// new skills via a background LLM call. 
//
// Design mirrors post-task-review.ts: fire-and-forget background work driven by
// the executor:complete hook, with reentrancy + health tracking guards.

import { hooks } from '../hooks';
import { log } from '../utils/logger';
import {
  computeSkillDir,
  listSkills,
  saveSkill,
} from './store';
import type { Skill } from './types';
import { VALID_NAME_RE } from './types';

export interface ToolCallSummary {
  tool: string;
  args: unknown;
  ok: boolean;
}

export interface SkillSynthConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Minimum number of tool calls in the trace before we even consider extracting. */
  minToolCalls?: number;
  /** Category folder for extracted skills. */
  category?: string;
}

export interface SkillProposal {
  name: string;
  description: string;
  body: string;
  category: string;
  tags?: string[];
}

interface RawProposal {
  extract?: boolean;
  name?: unknown;
  description?: unknown;
  body?: unknown;
  tags?: unknown;
}

const DEFAULT_MIN_TOOL_CALLS = 3;
const DEFAULT_CATEGORY = 'auto-extracted';
const MAX_CONSECUTIVE_FAILURES = 3;
const DESCRIPTION_FUZZY_PREFIX = 50;

const EXTRACT_PROMPT = `You are analyzing a successful AI tool sequence and deciding if it represents a reusable skill worth saving.

A skill is worth extracting only when ALL of these are true:
- (a) General enough to apply to similar future tasks (not one-off / not project-specific trivia)
- (b) Non-trivial: at least 3 logical steps with real coordination between tools
- (c) Not already obvious from the individual tool docs (the value is in the SEQUENCE / pattern)

Be selective. Most tasks should NOT produce skills. When in doubt, do not extract.

Respond in EXACTLY one of these JSON shapes (no markdown fences, no commentary):
{"extract": false}
OR
{"extract": true, "name": "kebab-case-name", "description": "one-line description", "body": "## When to use\\n...\\n## Steps\\n1. ...", "tags": ["tag1"]}

Rules for the fields when extracting:
- name: lowercase kebab-case, 3-40 chars, [a-z0-9._-] only
- description: single short line, no newlines
- body: markdown body of SKILL.md (no frontmatter — the host adds that). Include "When to use" and "Steps" sections at minimum.
- tags: 1-5 short tags

IMPORTANT — language rule:
- name, description, body MUST be written in English regardless of the conversation language. English keeps the shared library consistent.
- tags MUST include BOTH English AND the conversation's original language (when not English). Tags drive retrieval — single-language tags miss cross-language prompts.
  - Always include 1-3 English tags.
  - If the conversation was in Chinese, ALSO include 1-3 Chinese tags.
  - Example: for a Chinese log-analysis skill, tags=["logs", "analysis", "日志", "分析"]
  - For a pure English skill, English tags only is fine.`;

let extracting = false;
let consecutiveFailures = 0;
let extractorDisabled = false;

/** Reset extractor health (e.g. on session start, or for tests). */
export function resetSkillSynthHealth(): void {
  consecutiveFailures = 0;
  extractorDisabled = false;
  extracting = false; // also clear in-flight reentrancy guard so back-to-back
                      // tests don't deadlock on a stale flag from prior run.
}

/** Wire the extractor to executor:complete events. Fire-and-forget. */
export function wireSkillSynthExtractor(config: SkillSynthConfig): void {
  hooks.on('executor:complete', (_event, data) => {
    if (extractorDisabled) {
      // Already escalated this session; stay silent.
      return;
    }
    if (extracting) {
      log.info('SkillSynth: skipping, previous extraction still running');
      return;
    }

    const minToolCalls = config.minToolCalls ?? DEFAULT_MIN_TOOL_CALLS;
    const toolCalls = extractToolCalls(data.toolCalls);
    if (!toolCalls || toolCalls.length < minToolCalls) return;
    if (!toolCalls.every((c) => c.ok === true)) return;

    const prompt = typeof data.prompt === 'string' ? data.prompt : '';
    if (!prompt) return;

    // Claim the slot synchronously so a rapid second event can't slip past
    // the guard before runExtraction sets it inside the setTimeout callback.
    extracting = true;
    setTimeout(() => {
      void runExtraction(config, prompt, toolCalls);
    }, 0);
  });
}

function extractToolCalls(value: unknown): ToolCallSummary[] | null {
  if (!Array.isArray(value)) return null;
  const out: ToolCallSummary[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.tool !== 'string' || typeof obj.ok !== 'boolean') return null;
    out.push({ tool: obj.tool, args: obj.args, ok: obj.ok });
  }
  return out;
}

function recordExtractionSuccess(): void {
  if (consecutiveFailures > 0) {
    consecutiveFailures = 0;
  }
}

function recordExtractionFailure(reason: string, detail: Record<string, unknown> = {}): void {
  consecutiveFailures++;
  log.warn('SkillSynth: failure', { reason, consecutiveFailures, ...detail });

  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !extractorDisabled) {
    extractorDisabled = true;
    log.error('SkillSynth: disabling extractor until next session', { consecutiveFailures });
    void hooks.emit('skillSynth_unhealthy', {
      consecutiveFailures,
      lastReason: reason,
      ...detail,
    });
  }
}

async function runExtraction(
  config: SkillSynthConfig,
  prompt: string,
  toolCalls: ToolCallSummary[]
): Promise<void> {
  // extracting was already claimed synchronously by the hook handler.
  try {
    const category = config.category ?? DEFAULT_CATEGORY;
    const proposal = await proposeSkillFromTrace({ prompt, toolCalls }, config);
    if (!proposal) {
      log.info('SkillSynth: nothing to extract');
      return;
    }

    // Re-check existing skills right before save (defensive — list may have changed
    // since proposeSkillFromTrace last looked).
    if (skillCollides(proposal)) {
      log.info('SkillSynth: skipping — skill already exists or fuzzy-matches', {
        name: proposal.name,
      });
      return;
    }

    const finalCategory = proposal.category || category;
    const now = Date.now();
    const skill: Skill = {
      frontmatter: {
        name: proposal.name,
        description: proposal.description,
        category: finalCategory,
        tags: proposal.tags,
        createdAt: now,
        updatedAt: now,
      },
      body: proposal.body,
      directoryPath: computeSkillDir(proposal.name, finalCategory),
    };

    await saveSkill(skill);
    log.info('SkillSynth: extracted skill', {
      name: proposal.name,
      category: finalCategory,
    });
  } catch (err) {
    recordExtractionFailure('unexpected_error', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    extracting = false;
  }
}

/**
 * Pure-ish: runs the API call and returns a SkillProposal (or null). Side effects
 * are limited to the network call and (on failure) bumping the health counter.
 *
 * Suitable for unit tests — call with a stubbed global fetch.
 */
export async function proposeSkillFromTrace(
  opts: { prompt: string; toolCalls: ToolCallSummary[] },
  config: SkillSynthConfig
): Promise<SkillProposal | null> {
  const minToolCalls = config.minToolCalls ?? DEFAULT_MIN_TOOL_CALLS;
  const category = config.category ?? DEFAULT_CATEGORY;

  if (opts.toolCalls.length < minToolCalls) return null;
  if (!opts.toolCalls.every((c) => c.ok === true)) return null;

  // Cheap pre-check before spending an API call
  if (anyExistingSkillMatches(opts.prompt)) {
    return null;
  }

  const trace = serializeTrace(opts.toolCalls);
  const userMessage = `User prompt:\n${opts.prompt.slice(0, 1500)}\n\nTool sequence (${opts.toolCalls.length} calls):\n${trace}`;

  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 800,
    temperature: 0.1,
    stream: false,
  };

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    recordExtractionFailure('network_error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!response.ok) {
    recordExtractionFailure('api_error', { status: response.status });
    return null;
  }

  let json: { choices?: Array<{ message?: { content?: string } }> };
  try {
    json = (await response.json()) as typeof json;
  } catch (err) {
    recordExtractionFailure('json_decode_error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    recordExtractionFailure('empty_response');
    return null;
  }

  let parsed: RawProposal;
  try {
    parsed = JSON.parse(content) as RawProposal;
  } catch {
    recordExtractionFailure('parse_error', { preview: content.slice(0, 200) });
    return null;
  }

  // From here on the API succeeded — clear the failure streak even if extract=false.
  recordExtractionSuccess();

  if (parsed.extract !== true) {
    return null;
  }

  const validated = validateProposal(parsed, category);
  if (!validated) {
    log.warn('SkillSynth: model returned invalid proposal', {
      preview: content.slice(0, 200),
    });
    return null;
  }

  // Final collision check before returning
  if (skillCollides(validated)) {
    log.info('SkillSynth: proposal collides with existing skill', { name: validated.name });
    return null;
  }

  return validated;
}

function serializeTrace(calls: ToolCallSummary[]): string {
  const lines: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    let argPreview: string;
    try {
      argPreview = JSON.stringify(c.args);
    } catch {
      argPreview = String(c.args);
    }
    if (argPreview.length > 200) {
      argPreview = argPreview.slice(0, 197) + '...';
    }
    lines.push(`${i + 1}. ${c.tool}(${argPreview}) -> ok`);
  }
  return lines.join('\n');
}

function validateProposal(raw: RawProposal, defaultCategory: string): SkillProposal | null {
  if (typeof raw.name !== 'string') return null;
  if (typeof raw.description !== 'string') return null;
  if (typeof raw.body !== 'string') return null;

  const name = raw.name.trim();
  const description = raw.description.trim();
  const body = raw.body;

  if (!name || !description || !body.trim()) return null;
  if (name.length > 40) return null;

  // No path traversal / no path separators
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;

  // kebab-case + safe character set
  if (!VALID_NAME_RE.test(name)) return null;

  let tags: string[] | undefined;
  if (Array.isArray(raw.tags)) {
    // C5/D2 fix: drop non-string / blank / whitespace-only tags BEFORE the
    // length cap, otherwise we'd happily emit tags=[""] when the model
    // returned a blank string in slot 0. Cap raised from 5 → 8 because
    // EXTRACT_PROMPT now demands BOTH 1-3 English AND 1-3 Chinese tags
    // (max 6 legitimate values). The old cap of 5 silently truncated the
    // last legitimate language tag, breaking cross-language retrieval.
    const t = raw.tags
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 32);
    if (t.length > 0) tags = t.slice(0, 8);
  }

  return {
    name,
    description,
    body,
    category: defaultCategory,
    tags,
  };
}

function skillCollides(proposal: { name: string; description: string }): boolean {
  let existing;
  try {
    existing = listSkills();
  } catch {
    return false;
  }
  const targetDescPrefix = proposal.description.slice(0, DESCRIPTION_FUZZY_PREFIX).toLowerCase();
  for (const s of existing) {
    if (s.name === proposal.name) return true;
    const existingPrefix = (s.description ?? '').slice(0, DESCRIPTION_FUZZY_PREFIX).toLowerCase();
    if (
      targetDescPrefix.length >= 10 &&
      existingPrefix.length >= 10 &&
      (existingPrefix.includes(targetDescPrefix) || targetDescPrefix.includes(existingPrefix))
    ) {
      return true;
    }
  }
  return false;
}

function anyExistingSkillMatches(_prompt: string): boolean {
  // Reserved for future smarter pre-filtering; for now we always defer the
  // collision check until the model returns a name+description we can compare.
  return false;
}
