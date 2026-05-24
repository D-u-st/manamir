// Tool Result Sanitizer
//
// Cleans tool output before sending it back to the LLM, to prevent context
// pollution that has been observed to degrade DeepSeek (and other models) into
// keyword cascades, infinite loops, or token-level repetition.
//
// Triggers we have seen in the wild:
//   - bash output with raw ANSI escape codes
//   - web_fetch returning long base64/URL tokens or <script> blobs
//   - read returning minified JS / binary data with NULL bytes
//   - OCR output with garbled control characters
//
// Design goals:
//   - Default ON, opt-out via MANAMIR_TOOL_SANITIZE=false
//   - Idempotent (safe to call twice)
//   - Preserve structural content: markdown code fences, JSON, CJK chars,
//     emoji
//   - Be conservative: rather leave a small bit of weirdness than mangle
//     legitimate content
//
// Implementation notes:
//   - Code fences (``` ... ```) are masked out before line/token rewrites
//     so we don't break long lines inside fenced blocks.
//   - We do NOT strip HTML in general — only inside web_fetch (script tags),
//     since other tools may legitimately return HTML samples.
//   - Repetition collapse uses a sliding 5-char window and triggers when the
//     same window repeats >= 10 times back-to-back.

const LONG_TOKEN_LEN = 200;
const LONG_LINE_LEN = 500;
const REPETITION_WINDOW = 5;
const REPETITION_THRESHOLD = 10;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
// All C0 control chars except \t (\x09), \n (\x0A), \r (\x0D), plus DEL (\x7F).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
// NULL byte — cleaned separately for clarity (also covered by CONTROL_RE).
// eslint-disable-next-line no-control-regex
const NULL_RE = /\x00/g;

const SCRIPT_RE = /<script[\s\S]*?<\/script>/gi;
const STYLE_RE = /<style[\s\S]*?<\/style>/gi;

const FENCE_PLACEHOLDER_PREFIX = '\u0001MANAMIR_FENCE_';
const FENCE_PLACEHOLDER_SUFFIX = '\u0001';

export interface SanitizeOptions {
  /** Override env-driven enable/disable. */
  enabled?: boolean;
}

function isEnabled(opts?: SanitizeOptions): boolean {
  if (opts && typeof opts.enabled === 'boolean') return opts.enabled;
  const env = process.env.MANAMIR_TOOL_SANITIZE;
  if (env === undefined || env === '') return true; // default ON
  return env.toLowerCase() !== 'false' && env !== '0';
}

/**
 * Mask fenced code blocks with placeholders so token/line rewrites skip them.
 * Returns the masked string plus a mapping for restoration.
 */
function maskFences(input: string): { masked: string; fences: string[] } {
  const fences: string[] = [];
  // Match standard ``` fences. Non-greedy. We do not try to be clever about
  // language tags or indentation — just preserve the raw block verbatim.
  const masked = input.replace(/```[\s\S]*?```/g, (match) => {
    const idx = fences.length;
    fences.push(match);
    return `${FENCE_PLACEHOLDER_PREFIX}${idx}${FENCE_PLACEHOLDER_SUFFIX}`;
  });
  return { masked, fences };
}

function unmaskFences(input: string, fences: string[]): string {
  if (fences.length === 0) return input;
  return input.replace(
    new RegExp(`${FENCE_PLACEHOLDER_PREFIX}(\\d+)${FENCE_PLACEHOLDER_SUFFIX}`, 'g'),
    (_, idx) => fences[Number(idx)] ?? ''
  );
}

/**
 * Detect if a string is valid JSON. Used to skip line-wrapping for JSON.
 * We only check the trimmed full string — partial JSON is treated as text.
 */
function isLikelyJson(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Truncate any whitespace-free run >= LONG_TOKEN_LEN chars.
 * Catches base64 blobs, long URLs, hex dumps, etc.
 */
function truncateLongTokens(input: string): string {
  return input.replace(new RegExp(`\\S{${LONG_TOKEN_LEN},}`, 'g'), (m) =>
    m.slice(0, LONG_TOKEN_LEN) + '...[truncated long token]'
  );
}

/**
 * Force-wrap any line that exceeds LONG_LINE_LEN chars. Operates per-line so
 * we don't insert breaks inside short lines that happen to neighbor long
 * ones. Long-token truncation runs first, so this mostly catches lines that
 * are long-but-have-spaces (e.g. minified-but-tokenized JS).
 */
function wrapLongLines(input: string): string {
  return input
    .split('\n')
    .map((line) => {
      if (line.length <= LONG_LINE_LEN) return line;
      // Keep the first LONG_LINE_LEN chars, drop the rest, mark it.
      return line.slice(0, LONG_LINE_LEN) + '\n[...long line truncated]';
    })
    .join('\n');
}

/**
 * Collapse runs where the same `windowSize`-char substring repeats
 * `threshold`+ times back-to-back. Catches keyword cascades and pathological
 * repetition without touching natural prose.
 *
 * Example trigger: "abcabcabcabcabcabcabcabcabcabc" (window=3, threshold=10)
 * → "abc[...x10 repetition collapsed]"
 */
export function collapseRepetition(
  input: string,
  windowSize: number = REPETITION_WINDOW,
  threshold: number = REPETITION_THRESHOLD
): string {
  if (input.length < windowSize * threshold) return input;

  let result = '';
  let i = 0;
  const n = input.length;

  while (i < n) {
    if (i + windowSize * threshold > n) {
      result += input.slice(i);
      break;
    }
    const window = input.slice(i, i + windowSize);
    let repeats = 1;
    let j = i + windowSize;
    while (j + windowSize <= n && input.slice(j, j + windowSize) === window) {
      repeats++;
      j += windowSize;
    }
    if (repeats >= threshold) {
      result += `${window}[...x${repeats} repetition collapsed]`;
      i = j;
    } else {
      result += input[i];
      i++;
    }
  }

  return result;
}

/**
 * Per-tool sanitize hooks.
 * Currently only web_fetch needs special treatment (script/style stripping).
 */
function applyToolSpecific(content: string, toolName: string): string {
  if (toolName === 'web_fetch' || toolName === 'WebFetch') {
    return content.replace(SCRIPT_RE, '').replace(STYLE_RE, '');
  }
  return content;
}

/**
 * Main entry: sanitize a tool result before it is appended to the LLM
 * conversation history.
 *
 * Order matters:
 *   1. ANSI escapes (could otherwise survive control-char strip in some
 *      shapes — kill them first)
 *   2. Tool-specific (e.g. strip <script> for web_fetch) so we don't waste
 *      work on garbage that would be cut anyway
 *   3. Mask code fences so steps 4–5 don't damage them
 *   4. Long-token truncate
 *   5. Long-line wrap (skipped for valid JSON outside fences)
 *   6. Restore fences
 *   7. Control chars + NULL bytes
 *   8. Repetition collapse (last, so it operates on cleaned text)
 */
export function sanitizeToolResult(
  content: string,
  toolName: string,
  opts?: SanitizeOptions
): string {
  if (!isEnabled(opts)) return content;
  if (typeof content !== 'string' || content.length === 0) return content;

  let s = content;

  // 1. ANSI escapes
  s = s.replace(ANSI_RE, '');

  // 2. Tool-specific
  s = applyToolSpecific(s, toolName);

  // 3. Mask fences before mutating tokens/lines
  const { masked, fences } = maskFences(s);
  s = masked;

  // 4 + 5. Token/line rewrites — skip BOTH for whole-string JSON
  //         (JSON is one big space-free run by design; rewriting would
  //          corrupt structure and downstream parsers).
  if (!isLikelyJson(s)) {
    s = truncateLongTokens(s);
    s = wrapLongLines(s);
  }

  // 6. Restore fences
  s = unmaskFences(s, fences);

  // 7. Control chars + NULL bytes (NULL_RE is redundant after CONTROL_RE
  //    but kept explicit per spec)
  s = s.replace(CONTROL_RE, '');
  s = s.replace(NULL_RE, '');

  // 8. Repetition collapse
  s = collapseRepetition(s);

  return s;
}
