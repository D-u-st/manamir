// Skill content scanner — produces a SecurityReport with severity-aware findings.
//
// Distinct from src/skills/guard.ts (legacy file/dir scanner). This module focuses on
// content scanning for the Claude-Code-style 3-tier skill subsystem and the trust
// matrix. Used at save time and on-demand.

import type { CreatedBy, Finding, Severity, SecurityReport, Trust } from './types';
import { SECURITY_PATTERNS, SEVERITY_RANK, maxSeverity } from './security-patterns';

const INVISIBLE_CHARS: Record<string, string> = {
  '\u200b': 'zero-width space',
  '\u200c': 'zero-width non-joiner',
  '\u200d': 'zero-width joiner',
  '\u2060': 'word joiner',
  '\u2062': 'invisible times',
  '\u2063': 'invisible separator',
  '\u2064': 'invisible plus',
  '\ufeff': 'BOM',
  '\u202a': 'LTR embedding',
  '\u202b': 'RTL embedding',
  '\u202c': 'pop directional',
  '\u202d': 'LTR override',
  '\u202e': 'RTL override',
  '\u2066': 'LTR isolate',
  '\u2067': 'RTL isolate',
  '\u2068': 'first strong isolate',
  '\u2069': 'pop directional isolate',
};

export interface ScanContentOptions {
  /** Source filename for findings, default 'SKILL.md' */
  fileName?: string;
  /** Skip pattern checks against fenced code blocks (false = also scan blocks). */
  ignoreCodeFences?: boolean;
}

/** Scan an arbitrary content string and return raw findings. */
export function scanContent(content: string, options: ScanContentOptions = {}): Finding[] {
  const fileName = options.fileName ?? 'SKILL.md';
  const lines = content.split('\n');
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const tp of SECURITY_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const key = `${tp.id}:${i}`;
      if (seen.has(key)) continue;
      if (tp.pattern.test(line)) {
        seen.add(key);
        let match = line.trim();
        if (match.length > 120) match = match.slice(0, 117) + '...';
        findings.push({
          patternId: tp.id,
          severity: tp.severity,
          category: tp.category,
          file: fileName,
          line: i + 1,
          match,
          description: tp.description,
        });
      }
    }
  }

  // Invisible Unicode (each line: report once per char-class)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of Object.keys(INVISIBLE_CHARS)) {
      if (line.includes(ch)) {
        findings.push({
          patternId: 'invisible_unicode',
          severity: 'high',
          category: 'instruction-override',
          file: fileName,
          line: i + 1,
          match: `U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} (${INVISIBLE_CHARS[ch]})`,
          description: `invisible unicode character ${INVISIBLE_CHARS[ch]}`,
        });
        break;
      }
    }
  }

  return findings;
}

/** Detect fenced ``` code blocks in markdown content for command-injection patterns. */
export function scanCodeBlocks(content: string): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split('\n');
  let inBlock = false;
  let blockStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      if (!inBlock) {
        inBlock = true;
        blockStart = i + 1;
      } else {
        inBlock = false;
      }
      continue;
    }
    if (!inBlock) continue;
    // Heightened scrutiny inside code blocks: pipes-to-shell, eval, subst-curl
    if (/\$\(\s*curl\b[^)]*\)/.test(line) || /`[^`]*curl[^`]*`/.test(line)) {
      findings.push({
        patternId: 'cb_subst_curl',
        severity: 'high',
        category: 'code-exec',
        file: 'SKILL.md',
        line: i + 1,
        match: line.trim().slice(0, 120),
        description: 'command substitution with curl in code block',
      });
    }
    if (/\b(curl|wget)\s+[^|\n]+\|\s*(ba)?sh/.test(line)) {
      findings.push({
        patternId: 'cb_pipe_shell',
        severity: 'critical',
        category: 'supply-chain',
        file: 'SKILL.md',
        line: i + 1,
        match: line.trim().slice(0, 120),
        description: 'curl/wget piped to shell in code block',
      });
    }
    if (/\beval\s*\(/.test(line)) {
      findings.push({
        patternId: 'cb_eval',
        severity: 'high',
        category: 'code-exec',
        file: 'SKILL.md',
        line: i + 1,
        match: line.trim().slice(0, 120),
        description: 'eval() in code block',
      });
    }
  }
  // Track unmatched fence (helpful as a low-sev signal)
  if (inBlock) {
    findings.push({
      patternId: 'cb_unclosed',
      severity: 'low',
      category: 'instruction-override',
      file: 'SKILL.md',
      line: blockStart,
      match: 'unclosed code fence',
      description: 'unclosed code fence (parser may swallow content)',
    });
  }
  return findings;
}

/** Decision policy: should the skill be allowed to install/update/run? */
export interface ScanDecisionInput {
  trust: Trust;
  createdBy: CreatedBy;
  /** Force flag (user explicit override). */
  force?: boolean;
}

export function evaluateReport(
  findings: Finding[],
  input: ScanDecisionInput
): SecurityReport {
  const severity = findings.length === 0 ? 'low' : maxSeverity(findings);
  let blocked = false;
  let reason: string;

  // Trust matrix:
  //   system: never blocked (bundled)
  //   user: blocked only on critical (warn on high), unless force
  //   agent: blocked on high or critical
  if (input.trust === 'system' || input.createdBy === 'system') {
    blocked = false;
    reason = 'system-trusted; no block';
  } else if (input.createdBy === 'agent' || input.trust === 'agent') {
    if (SEVERITY_RANK[severity] >= SEVERITY_RANK.high) {
      blocked = !input.force;
      reason = blocked
        ? `agent-created skill has ${severity}-severity findings (blocked)`
        : `agent-created skill has ${severity}-severity findings (forced)`;
    } else {
      reason = 'agent-created skill passed scan';
    }
  } else {
    // user trust
    if (severity === 'critical') {
      blocked = !input.force;
      reason = blocked
        ? 'critical findings in user skill (use force to override)'
        : 'critical findings in user skill (forced)';
    } else if (severity === 'high') {
      reason = 'high-severity findings in user skill (allowed with warning)';
    } else {
      reason = findings.length === 0 ? 'clean' : `${severity}-severity findings (allowed)`;
    }
  }

  return {
    passed: !blocked,
    severity,
    findings,
    blocked,
    reason,
  };
}

/** Convenience: scan content + apply trust matrix → SecurityReport. */
export function scanSkillContent(
  content: string,
  input: ScanDecisionInput,
  options?: ScanContentOptions
): SecurityReport {
  const baseFindings = scanContent(content, options);
  const blockFindings = options?.ignoreCodeFences ? [] : scanCodeBlocks(content);
  const all = [...baseFindings, ...blockFindings];
  return evaluateReport(all, input);
}

export function formatSecurityReport(report: SecurityReport): string {
  const lines: string[] = [];
  lines.push(`Security: severity=${report.severity}, passed=${report.passed}, blocked=${report.blocked}`);
  lines.push(`Reason: ${report.reason}`);
  const sorted = [...report.findings].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
  );
  for (const f of sorted) {
    lines.push(
      `  [${f.severity.toUpperCase()}] ${f.category} ${f.file}:${f.line} (${f.patternId}) — ${f.description}`
    );
  }
  return lines.join('\n');
}

export function highestSeverity(findings: Finding[]): Severity {
  return maxSeverity(findings);
}
