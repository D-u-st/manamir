// Skill recommender — scores tier-1 SkillSummary records against an incoming
// task prompt and returns the top-K most likely matches. Used by the
// ApiExecutor to prepend a small "you may want to use these skills" hint
// before each agent loop kicks off.
//
// Scoring is intentionally simple and dependency-free (no tokenizer, no
// embeddings):
//   - keyword overlap of prompt vs skill (name + description + tags)
//   - tag-exact matches weighted higher than name/description substring
//   - recency boost from last_used_at (recent uses bias the recs)
//
// Total score is normalized into [0,1] roughly; threshold defaults to 0.4.
//
// Threshold + top-K both overridable via env (REC_THRESHOLD / REC_TOP_K).
//
// Format helper (formatSkillRecommendations) renders the suggestions block
// the executor injects into the conversation as a system message.

import type { SkillSummary } from './types';

export interface SkillRecommendation {
  skillName: string;
  score: number;
  reason: string;
}

export interface RecommendOptions {
  /** Override the default top-K (3). */
  topK?: number;
  /** Override the default acceptance threshold (0.4). */
  threshold?: number;
  /** Reference time for recency boost (defaults to Date.now()). */
  now?: number;
}

const DEFAULT_TOP_K = 3;
const DEFAULT_THRESHOLD = 0.4;
const RECENCY_FULL_BOOST_DAYS = 7; // within 7d → full boost (1.0)
const RECENCY_DECAY_DAYS = 30; // by 30d the boost decays to ~0
const DAY_MS = 24 * 60 * 60 * 1000;

function readEnvNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

// CJK Unified Ideographs + kana + hangul. Used to detect pure-CJK tokens
// that need bigram shingling (Chinese has no inter-word whitespace).
const CJK_ONLY_RE = /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+$/;

/**
 * Emit a token into `sink`; if `weak` is provided, CJK bigram shingles are
 * also recorded there so the caller can downweight them at scoring time.
 * Chinese is unsegmented so [\p{L}\p{N}]+ collapses long runs into one token;
 * bigram shingling helps a short tag like "登录" still match a prompt like
 * "请帮我登录一下" — but the noise bigrams ("请帮", "帮我"...) need lower weight.
 */
function emitToken(
  t: string,
  sink: Set<string>,
  latinFloor: number,
  weak?: Set<string>
): void {
  if (CJK_ONLY_RE.test(t)) {
    if (t.length >= 2) sink.add(t);
    if (t.length > 2) {
      for (let i = 0; i + 2 <= t.length; i++) {
        const bg = t.slice(i, i + 2);
        sink.add(bg);
        if (weak) weak.add(bg);
      }
    }
    return;
  }
  if (t.length >= latinFloor) sink.add(t);
}

interface PromptTokens {
  all: Set<string>;
  weak: Set<string>;
}

/**
 * Tokenize a prompt: lowercase, letters/digits across all scripts.
 *   - Latin / Cyrillic / etc.: length >= 3
 *   - CJK / kana / hangul: length >= 2; long runs also bigram-shingled, with
 *     bigrams recorded as `weak` so scoring can damp them down.
 */
function tokenizePrompt(text: string): PromptTokens {
  const lower = text.toLowerCase();
  const tokens = lower.match(/[\p{L}\p{N}]+/gu) ?? [];
  const all = new Set<string>();
  const weak = new Set<string>();
  for (const t of tokens) {
    emitToken(t, all, 3, weak);
  }
  return { all, weak };
}

/**
 * Tokenize a skill's identifier text (name + description + tags). Same
 * normalization as the prompt tokenizer but with a slightly more permissive
 * floor for Latin tokens — skill names like "ls" are valid signals.
 */
function tokenizeSkill(skill: SkillSummary): { all: Set<string>; tags: Set<string> } {
  const all = new Set<string>();
  const tags = new Set<string>();

  const collect = (text: string, sink: Set<string>): void => {
    if (!text) return;
    const lower = text.toLowerCase();
    const tokens = lower.match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const t of tokens) {
      emitToken(t, sink, 2);
    }
  };

  collect(skill.name, all);
  collect(skill.description, all);

  if (Array.isArray(skill.tags)) {
    for (const tag of skill.tags) {
      collect(tag, tags);
      collect(tag, all);
    }
  }

  return { all, tags };
}

/**
 * Recency boost in [0, 1]:
 *   - within RECENCY_FULL_BOOST_DAYS → 1.0
 *   - linearly decays to 0 at RECENCY_DECAY_DAYS
 *   - older / never-used → 0
 *
 * The boost is added to (not multiplied with) the keyword score so that a
 * never-used skill with strong keyword overlap can still surface.
 */
function recencyBoost(skill: SkillSummary, now: number): number {
  const ts = skill.last_used_at ? Date.parse(skill.last_used_at) : NaN;
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (now - ts) / DAY_MS);
  if (ageDays <= RECENCY_FULL_BOOST_DAYS) return 1.0;
  if (ageDays >= RECENCY_DECAY_DAYS) return 0;
  // Linear decay between full-boost and zero
  const span = RECENCY_DECAY_DAYS - RECENCY_FULL_BOOST_DAYS;
  return 1.0 - (ageDays - RECENCY_FULL_BOOST_DAYS) / span;
}

/**
 * Recommend skills for a task. Returns a (possibly empty) list, sorted by
 * score desc, capped at topK and filtered by threshold.
 *
 * Scoring breakdown:
 *   tag exact match (per token): 1.5
 *   name/description token match (per token): 1.0
 *   max raw score is normalized by the prompt's keyword count to keep scores
 *   in a comparable range across short vs long prompts.
 *   recency boost in [0,1] is added on top, weighted at 0.4.
 *
 * Reason string explains which inputs drove the score.
 */
export function recommendSkillsForTask(
  taskPrompt: string,
  skills: SkillSummary[],
  options: RecommendOptions = {}
): SkillRecommendation[] {
  if (!skills || skills.length === 0) return [];
  const promptTokens = tokenizePrompt(taskPrompt);
  if (promptTokens.all.size === 0) return [];

  const topK = options.topK ?? readEnvNumber('REC_TOP_K', DEFAULT_TOP_K);
  const threshold = options.threshold ?? readEnvNumber('REC_THRESHOLD', DEFAULT_THRESHOLD);
  const now = options.now ?? Date.now();

  const scored: SkillRecommendation[] = [];

  for (const skill of skills) {
    const { all, tags } = tokenizeSkill(skill);

    // Per-token contributions: tag > text, strong > weak (CJK bigram).
    let tagHits = 0;
    let weakTagHits = 0;
    let textHits = 0;
    let weakTextHits = 0;
    const matchedTokens: string[] = [];
    for (const pt of promptTokens.all) {
      const isWeak = promptTokens.weak.has(pt);
      if (tags.has(pt)) {
        if (isWeak) weakTagHits++;
        else tagHits++;
        matchedTokens.push(pt);
        continue;
      }
      if (all.has(pt)) {
        if (isWeak) weakTextHits++;
        else textHits++;
        matchedTokens.push(pt);
      }
    }

    if (tagHits + weakTagHits + textHits + weakTextHits === 0) continue;

    const rawScore =
      tagHits * 1.5 +
      weakTagHits * 0.3 +
      textHits * 1.0 +
      weakTextHits * 0.2;
    // Normalize by sqrt(promptSize) — long prompts naturally hit more tokens
    // but shouldn't drown out short, focused prompts.
    const normalized = rawScore / Math.max(1, Math.sqrt(promptTokens.all.size));
    const recency = recencyBoost(skill, now);
    const score = normalized + recency * 0.4;

    if (score < threshold) continue;

    const reasonParts: string[] = [];
    if (matchedTokens.length > 0) {
      reasonParts.push(`matched: ${matchedTokens.slice(0, 4).join(', ')}`);
    }
    if (tagHits > 0) reasonParts.push(`${tagHits} tag hit${tagHits > 1 ? 's' : ''}`);
    if (recency > 0) reasonParts.push(`recent`);

    scored.push({
      skillName: skill.name,
      score,
      reason: reasonParts.join('; ') || 'keyword match',
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Render the suggestions block injected as a system message. Empty input
 * returns ''. Includes per-skill description so the model has enough context
 * to decide whether to call skill_view without an extra round-trip.
 */
export function formatSkillRecommendations(
  recs: SkillRecommendation[],
  skills: SkillSummary[]
): string {
  if (!recs || recs.length === 0) return '';
  const byName = new Map<string, SkillSummary>();
  for (const s of skills) byName.set(s.name, s);

  const lines: string[] = [];
  lines.push(`<skill-suggestions count="${recs.length}">`);
  lines.push('You may want to use these skills for this task:');
  for (const r of recs) {
    const s = byName.get(r.skillName);
    const desc = s?.description ? `: ${s.description}` : '';
    lines.push(`- skill_view name="${r.skillName}"${desc}`);
  }
  lines.push('Call skill_view to see how to use one. Skip if none apply.');
  lines.push('</skill-suggestions>');
  return lines.join('\n');
}
