// Trust matrix for skill execution.
//
// Three trust levels:
//   system  — bundled with manamir (highest trust, full access)
//   user    — written by the human (full access, soft warnings on dangerous patterns)
//   agent   — extracted by SkillSynth / proposed by an AI (must pass strict scan,
//             bash blocked unless skill explicitly opts in via allowed_tools)
//
// Source -> default trust mapping (when frontmatter doesn't specify):
//   bundled  -> system
//   project  -> user
//   user     -> user
//   legacy   -> user
//
// Permission decisions are returned as `ToolPermission` objects.

import type { CreatedBy, Source, SkillFrontmatter, Trust } from './types';

const SOURCE_TO_TRUST: Record<Source, Trust> = {
  project: 'user',
  user: 'user',
  legacy: 'user',
  bundled: 'system',
};

const DANGEROUS_TOOLS_DEFAULT_BLOCKED_FOR_AGENT = new Set([
  'bash',
  'write',
  'edit',
  'web_fetch',
]);

export interface ToolPermission {
  tool: string;
  allowed: boolean;
  reason: string;
}

/** Resolve effective trust for a skill given its frontmatter + source. */
export function resolveTrust(fm: SkillFrontmatter, source: Source): Trust {
  if (fm.trust) return fm.trust;
  return SOURCE_TO_TRUST[source];
}

/** Resolve effective createdBy. */
export function resolveCreatedBy(fm: SkillFrontmatter, source: Source): CreatedBy {
  if (fm.created_by) return fm.created_by;
  if (source === 'bundled') return 'system';
  return 'user';
}

/** Decide whether a given tool may be called when this skill is the active one. */
export function checkToolPermission(
  fm: SkillFrontmatter,
  source: Source,
  toolName: string
): ToolPermission {
  const trust = resolveTrust(fm, source);
  const createdBy = resolveCreatedBy(fm, source);

  // Forbidden list — always blocking (per skill).
  if (fm.forbidden_tools?.includes(toolName)) {
    return {
      tool: toolName,
      allowed: false,
      reason: `tool '${toolName}' is in forbidden_tools for this skill`,
    };
  }

  // Allowed list — if defined, must include the tool.
  if (fm.allowed_tools && fm.allowed_tools.length > 0) {
    if (fm.allowed_tools.includes(toolName)) {
      return {
        tool: toolName,
        allowed: true,
        reason: `tool '${toolName}' explicitly allowed`,
      };
    }
    return {
      tool: toolName,
      allowed: false,
      reason: `tool '${toolName}' not in allowed_tools (whitelist mode)`,
    };
  }

  // No whitelist → trust-based default
  if (trust === 'system' || createdBy === 'system') {
    return { tool: toolName, allowed: true, reason: 'system trust: full access' };
  }
  if (trust === 'user' && createdBy !== 'agent') {
    return { tool: toolName, allowed: true, reason: 'user trust: full access' };
  }

  // agent
  if (DANGEROUS_TOOLS_DEFAULT_BLOCKED_FOR_AGENT.has(toolName)) {
    return {
      tool: toolName,
      allowed: false,
      reason: `agent-created skill cannot use '${toolName}' without explicit allowed_tools opt-in`,
    };
  }
  return { tool: toolName, allowed: true, reason: 'agent trust: read-only tool allowed' };
}

/** Map source -> default trust (utility). */
export function defaultTrustForSource(source: Source): Trust {
  return SOURCE_TO_TRUST[source];
}

/** Whether this skill should be subjected to strict scanning. */
export function requiresStrictScan(fm: SkillFrontmatter, source: Source): boolean {
  const cb = resolveCreatedBy(fm, source);
  return cb === 'agent';
}
