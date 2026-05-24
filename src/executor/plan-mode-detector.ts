// Plan-mode auto-trigger heuristics.
//
// "Plan Mode" forces the model to lay out a numbered plan and wait for user
// confirmation BEFORE invoking any tools. This is meant for complex tasks
// where DeepSeek's tendency to dive straight in causes loops, partial work,
// or destructive missteps (the canonical example: "重构 src/").
//
// The detector is intentionally heuristic — false positives just produce a
// short confirmation round trip; false negatives revert to legacy behavior
// (model executes immediately). A user-facing toggle (/plan in cli.ts) lets
// the operator force or disable plan mode for the next message regardless of
// what the heuristics say.

export interface PlanModeDecision {
  shouldPlan: boolean;
  reason?: string;
  /** Which keywords / signals fired the trigger (for logging). */
  triggerKeywords?: string[];
}

// Word-boundary keywords. English uses \b; Chinese uses substring includes
// because \b doesn't fire on CJK boundaries.
const ENGLISH_TRIGGER_WORDS = [
  'refactor',
  'rewrite',
  'migrate',
  'restructure',
  'overhaul',
  'deploy',
  'redesign',
  'reorganize',
];

const CHINESE_TRIGGER_PHRASES = [
  '重构',
  '重写',
  '迁移',
  '整体',
  '批量',
  '全部',
  '部署',
  '重新组织',
  '重新设计',
  '彻底',
];

// Action verbs — when a prompt contains 3+ of these we treat it as "complex
// multi-action task" and recommend planning. The list is curated for the
// kinds of multi-step requests that historically cause problems: install +
// configure + deploy in one go, etc.
const ACTION_VERBS = [
  'install',
  'configure',
  'deploy',
  'migrate',
  'refactor',
  'build',
  'compile',
  'test',
  'document',
  'update',
  'upgrade',
  'remove',
  'delete',
  'replace',
  'rename',
  'move',
  'commit',
  'push',
  'merge',
  'rebase',
  'release',
];

// Multi-file patterns: when the prompt references file globs or whole
// directories we assume the task touches many files.
const MULTI_FILE_PATTERNS: RegExp[] = [
  /\bsrc\//i,
  /\btests?\//i,
  /\bevery\s+(file|config|module)/i,
  /\ball\s+(files|configs|tests|modules|\.[a-z]+\s+files)/i,
  /\b\*\.(ts|js|tsx|jsx|py|go|rs|md|json)\b/i,
  /\b全部.{0,4}文件/,
  /\b所有.{0,4}文件/,
  /\b整个.{0,4}(目录|项目)/,
];

const LENGTH_THRESHOLD = 200;
const ACTION_VERB_THRESHOLD = 3;

/**
 * Decide whether to enter plan mode for the given prompt.
 *
 * Returns shouldPlan=false for empty / trivial prompts. Returns shouldPlan=true
 * with a reason and trigger keywords as soon as ANY heuristic fires.
 */
export function shouldEnterPlanMode(taskPrompt: string): PlanModeDecision {
  if (!taskPrompt) return { shouldPlan: false };
  const trimmed = taskPrompt.trim();
  if (trimmed.length === 0) return { shouldPlan: false };

  const lower = trimmed.toLowerCase();

  // 1. Explicit complex-task keywords — highest signal.
  const matchedKw: string[] = [];
  for (const word of ENGLISH_TRIGGER_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(trimmed)) matchedKw.push(word);
  }
  for (const phrase of CHINESE_TRIGGER_PHRASES) {
    if (trimmed.includes(phrase)) matchedKw.push(phrase);
  }
  if (matchedKw.length > 0) {
    return {
      shouldPlan: true,
      reason: `complex-task keyword: ${matchedKw[0]}`,
      triggerKeywords: matchedKw,
    };
  }

  // 2. Multi-file patterns (any one match → plan).
  for (const re of MULTI_FILE_PATTERNS) {
    const m = trimmed.match(re);
    if (m) {
      return {
        shouldPlan: true,
        reason: 'multi-file scope',
        triggerKeywords: [m[0]],
      };
    }
  }

  // 3. Multiple action verbs in one prompt.
  const actionsHit: string[] = [];
  for (const verb of ACTION_VERBS) {
    const re = new RegExp(`\\b${verb}\\b`, 'i');
    if (re.test(lower)) actionsHit.push(verb);
    if (actionsHit.length >= ACTION_VERB_THRESHOLD) break;
  }
  if (actionsHit.length >= ACTION_VERB_THRESHOLD) {
    return {
      shouldPlan: true,
      reason: `multiple action verbs (${actionsHit.length})`,
      triggerKeywords: actionsHit.slice(0, ACTION_VERB_THRESHOLD),
    };
  }

  // 4. Long prompts — treat as inherently complex. We use the trimmed length
  // (ignoring trailing whitespace) so a 199-char prompt doesn't tip just
  // because the user pressed enter twice.
  if (trimmed.length >= LENGTH_THRESHOLD) {
    return {
      shouldPlan: true,
      reason: `length (${trimmed.length} >= ${LENGTH_THRESHOLD})`,
      triggerKeywords: ['__length__'],
    };
  }

  return { shouldPlan: false };
}

/**
 * Render the plan-mode system prompt that gets injected ahead of the user
 * message when shouldEnterPlanMode returns true.
 */
export function formatPlanModePrompt(decision: PlanModeDecision): string {
  const trigger = decision.triggerKeywords?.[0] ?? decision.reason ?? 'heuristic';
  const lines: string[] = [];
  lines.push(`<plan-mode triggered_by="${escapeAttr(trigger)}">`);
  lines.push('This appears to be a complex task. BEFORE executing any tools or making changes:');
  lines.push('');
  lines.push('1. Output a numbered plan in this format:');
  lines.push('   ## Plan');
  lines.push('   1. ...');
  lines.push('   2. ...');
  lines.push('   ## Affected files');
  lines.push('   - ...');
  lines.push('   ## Confirmation');
  lines.push('   Confirm to proceed? (yes/no/edit)');
  lines.push('');
  lines.push('2. WAIT for user reply. Do NOT execute any tools yet.');
  lines.push('3. Only execute after user replies "yes" / "确认" / "执行" / "干".');
  lines.push('4. If user replies "no" / "取消" / "edit" / "改" → ask for clarification.');
  lines.push('</plan-mode>');
  return lines.join('\n');
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/[\r\n]+/g, ' ');
}

/**
 * Manual override state for the next message. Set via /plan command in the
 * CLI. force=true → always plan; force=false → never plan; null → use
 * heuristics. Reset to null after each consumption (one-shot).
 */
let manualOverride: boolean | null = null;

export function setPlanModeOverride(force: boolean | null): void {
  manualOverride = force;
}

export function getPlanModeOverride(): boolean | null {
  return manualOverride;
}

/**
 * Consume the manual override (one-shot). If set, returns the forced
 * decision and clears the state. Otherwise returns null and the caller
 * should fall back to shouldEnterPlanMode().
 */
export function consumePlanModeOverride(): PlanModeDecision | null {
  if (manualOverride === null) return null;
  const force = manualOverride;
  manualOverride = null;
  if (force) {
    return {
      shouldPlan: true,
      reason: 'manual override (/plan)',
      triggerKeywords: ['__manual__'],
    };
  }
  return { shouldPlan: false, reason: 'manual override (/plan off)' };
}
