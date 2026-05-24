// Cheap model routing — routes simple messages to a cheaper/faster model

const COMPLEX_KEYWORDS = [
  'debug', 'implement', 'refactor', 'analyze', 'deploy', 'test',
  'review', 'explain', 'architecture', 'design', 'migrate',
  'optimize', 'benchmark', 'configure', 'investigate', 'diagnose'
];

const COMPLEX_RE = new RegExp(`\\b(${COMPLEX_KEYWORDS.join('|')})\\b`, 'i');

export interface CheapRouterConfig {
  cheapModel: string | undefined;
  maxLength: number;
  maxWords: number;
}

export type RouteDecision = 'primary' | 'cheap';

const DEFAULT_CONFIG: CheapRouterConfig = {
  cheapModel: process.env.CHEAP_MODEL || undefined,
  maxLength: 160,
  maxWords: 28
};

export function chooseRoute(
  userMessage: string,
  config: CheapRouterConfig = DEFAULT_CONFIG
): RouteDecision {
  if (!config.cheapModel) return 'primary';

  const trimmed = userMessage.trim();
  // Bug 9 fix: empty input — split(/\s+/) on '' returns [''] (length 1), masking emptiness.
  // Treat empty as primary (no cheap routing for nothing-to-route).
  if (!trimmed) return 'primary';
  if (trimmed.length > config.maxLength) return 'primary';

  const words = trimmed.split(/\s+/);
  if (words.length > config.maxWords) return 'primary';

  if (trimmed.includes('```')) return 'primary';
  if (/https?:\/\//.test(trimmed)) return 'primary';
  if ((trimmed.match(/\n/g) ?? []).length > 1) return 'primary';
  if (COMPLEX_RE.test(trimmed)) return 'primary';

  return 'cheap';
}

export function getCheapModel(): string | undefined {
  return process.env.CHEAP_MODEL || undefined;
}
