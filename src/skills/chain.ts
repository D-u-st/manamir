// Skill chain resolver — expands `{{skill:other-name}}` template tags inside a
// skill body. Supports recursive expansion with cycle detection and a max depth.
//
// If a referenced skill is missing, the literal tag is left in place and a warning
// is emitted (returned as part of the resolution result so callers can surface it).

import { MAX_CHAIN_DEPTH } from './types';

const SKILL_REF_RE = /\{\{skill:([a-z0-9][a-z0-9._-]*)\}\}/g;

export interface SkillBodyProvider {
  /** Return the body of a skill, or null if not found. */
  (name: string): string | null;
}

export interface ChainResolution {
  body: string;
  expandedRefs: string[];
  missingRefs: string[];
  cyclesDetected: string[];
  depthExceeded: string[];
}

interface ResolveContext {
  loader: SkillBodyProvider;
  visiting: Set<string>;
  expanded: Set<string>;
  missing: Set<string>;
  cycles: Set<string>;
  depthExceeded: Set<string>;
}

function expandRefs(body: string, ctx: ResolveContext, depth: number): string {
  if (depth > MAX_CHAIN_DEPTH) {
    return body;
  }
  return body.replace(SKILL_REF_RE, (match, name: string) => {
    if (ctx.visiting.has(name)) {
      ctx.cycles.add(name);
      return `[chain cycle: ${name}]`;
    }
    if (depth >= MAX_CHAIN_DEPTH) {
      ctx.depthExceeded.add(name);
      return match;
    }
    const inner = ctx.loader(name);
    if (inner === null) {
      ctx.missing.add(name);
      return match;
    }
    ctx.visiting.add(name);
    ctx.expanded.add(name);
    const expanded = expandRefs(inner, ctx, depth + 1);
    ctx.visiting.delete(name);
    return expanded;
  });
}

/** Resolve all `{{skill:name}}` references in a body. */
export function resolveChain(
  body: string,
  loader: SkillBodyProvider,
  rootName?: string
): ChainResolution {
  const ctx: ResolveContext = {
    loader,
    visiting: new Set(rootName ? [rootName] : []),
    expanded: new Set(),
    missing: new Set(),
    cycles: new Set(),
    depthExceeded: new Set(),
  };
  const out = expandRefs(body, ctx, 0);
  return {
    body: out,
    expandedRefs: Array.from(ctx.expanded).sort(),
    missingRefs: Array.from(ctx.missing).sort(),
    cyclesDetected: Array.from(ctx.cycles).sort(),
    depthExceeded: Array.from(ctx.depthExceeded).sort(),
  };
}

/** List all skill references in a body without resolving them. */
export function listSkillRefs(body: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  SKILL_REF_RE.lastIndex = 0;
  while ((m = SKILL_REF_RE.exec(body)) !== null) {
    out.add(m[1]);
  }
  return Array.from(out).sort();
}
