// Skill system types — full skill subsystem.
//
// Three loading tiers (standard progressive disclosure):
//   tier 1: name + description (cheap, in system prompt)
//   tier 2: frontmatter + first 1000 chars of body + supporting file list
//   tier 3: full frontmatter + full body + supporting files

export type Platform = 'linux' | 'macos' | 'windows';

export type Trust = 'system' | 'user' | 'agent';
export type CreatedBy = 'system' | 'user' | 'agent';
export type Source = 'project' | 'user' | 'legacy' | 'bundled';

export interface SkillExample {
  input: string;
  output: string;
}

export interface SkillConfigField {
  key: string;
  description: string;
  default?: string;
  prompt?: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  platforms?: Platform[];
  category?: string;
  tags?: string[];
  relatedSkills?: string[];
  config?: SkillConfigField[];
  // parity fields
  when_to_use?: string;
  examples?: SkillExample[];
  allowed_tools?: string[];
  forbidden_tools?: string[];
  trust?: Trust;
  created_by?: CreatedBy;
  created_at?: string; // ISO-8601 string
  updated_at?: string;
  content_hash?: string; // 'md5:<hex>' or 'sha256:<hex>'
  // Usage telemetry
  use_count?: number;
  last_used_at?: string;
  // Legacy numeric timestamps (kept for back-compat with prior writers)
  createdAt: number;
  updatedAt: number;
}

export interface Skill {
  frontmatter: SkillFrontmatter;
  body: string;
  directoryPath: string;
  files?: string[];
  source?: Source;
}

/** Parsed but not yet enriched / hash-validated. */
export interface RawSkill {
  frontmatter: SkillFrontmatter;
  body: string;
  directoryPath: string;
  source: Source;
  filePath: string;
}

export interface DiscoveredSkill {
  name: string;
  source: Source;
  filePath: string;
  directoryPath: string;
  description: string;
  category?: string;
  tags?: string[];
  version?: string;
  trust: Trust;
  last_used_at?: string;
  use_count?: number;
}

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export type TrustLevel = 'builtin' | 'trusted' | 'community' | 'agent-created';
export type Verdict = 'safe' | 'caution' | 'dangerous';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type PolicyDecision = 'allow' | 'block' | 'ask';

export interface Finding {
  patternId: string;
  severity: Severity;
  category: string;
  file: string;
  line: number;
  match: string;
  description: string;
}

export interface ScanResult {
  skillName: string;
  source: string;
  trustLevel: TrustLevel;
  verdict: Verdict;
  findings: Finding[];
  scannedAt: string;
  summary: string;
}

/** Severity-aware report from the new scanner (for agent-create checks). */
export interface SecurityReport {
  passed: boolean;
  severity: Severity;
  findings: Finding[];
  blocked: boolean;
  reason: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  category?: string;
  path: string;
  source?: Source;
  tags?: string[];
  version?: string;
  last_used_at?: string;
  use_count?: number;
}

export interface SkillTier2View {
  name: string;
  frontmatter: SkillFrontmatter;
  preview: string;
  truncated: boolean;
  files: string[];
  source: Source;
  directoryPath: string;
}

export interface SkillTier3View {
  name: string;
  frontmatter: SkillFrontmatter;
  body: string;
  files: string[];
  source: Source;
  directoryPath: string;
}

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_DESCRIPTION_LENGTH_STRICT = 200; // standard strict
export const MAX_TAG_COUNT = 10;
export const MAX_SKILL_CONTENT_CHARS = 100_000;
export const MAX_SKILL_FILE_BYTES = 1_048_576;
export const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const STRICT_NAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/; // 3-40 chars
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
export const ALLOWED_SUBDIRS = new Set(['references', 'templates', 'scripts', 'assets']);
export const TIER1_MAX_BYTES = 5 * 1024;
export const TIER2_PREVIEW_CHARS = 1000;
export const MAX_CHAIN_DEPTH = 3;
