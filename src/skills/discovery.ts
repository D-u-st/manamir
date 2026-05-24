// Auto-discovery of SKILL.md files across the four canonical locations.
//
// Priority (highest to lowest):
//   1. <projectRoot>/.claude/skills/**/SKILL.md          (project)
//   2. <homeDir>/.claude/skills/**/SKILL.md              (user)
//   3. <homeDir>/.manamir/skills/**/SKILL.md           (legacy manamir skills)
//   4. <bundledSkillsDir>/**/SKILL.md                    (bundled)
//
// A skill of the same name in a higher-priority source overrides any of lower priority.
//
// Locations are resolved at call time. Override via env vars:
//   MANAMIR_PROJECT_ROOT       — defaults to process.cwd()
//   MANAMIR_USER_SKILLS_DIR    — defaults to <homedir>/.claude/skills
//   MANAMIR_LEGACY_SKILLS_DIR  — defaults to <homedir>/.manamir/skills
//   MANAMIR_BUNDLED_SKILLS     — defaults to <pkgRoot>/data/skills
//
// Returns lightweight DiscoveredSkill records (no body) — body is loaded lazily
// via tier 2/3 reads.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, dirname, sep } from 'path';
import { homedir } from 'os';
import type { DiscoveredSkill, RawSkill, Source, SkillFrontmatter } from './types';
import { coerceFrontmatter, parseSkillMarkdown } from './frontmatter';
import { getCached, setCached } from './cache';
import { resolveTrust } from './trust';

export interface DiscoveryLocation {
  source: Source;
  dir: string;
  exists: boolean;
}

let projectRootOverride: string | null = null;
let userSkillsDirOverride: string | null = null;
let legacySkillsDirOverride: string | null = null;
let bundledSkillsDirOverride: string | null = null;

export function setDiscoveryRoots(opts: {
  projectRoot?: string | null;
  userSkillsDir?: string | null;
  legacySkillsDir?: string | null;
  bundledSkillsDir?: string | null;
}): void {
  if (opts.projectRoot !== undefined) projectRootOverride = opts.projectRoot;
  if (opts.userSkillsDir !== undefined) userSkillsDirOverride = opts.userSkillsDir;
  if (opts.legacySkillsDir !== undefined) legacySkillsDirOverride = opts.legacySkillsDir;
  if (opts.bundledSkillsDir !== undefined) bundledSkillsDirOverride = opts.bundledSkillsDir;
}

export function resetDiscoveryRoots(): void {
  projectRootOverride = null;
  userSkillsDirOverride = null;
  legacySkillsDirOverride = null;
  bundledSkillsDirOverride = null;
}

function projectRoot(): string {
  if (projectRootOverride !== null) return projectRootOverride;
  const env = (process.env.MANAMIR_PROJECT_ROOT ?? '').trim();
  if (env) return resolve(env);
  return process.cwd();
}

function userSkillsDir(): string {
  if (userSkillsDirOverride !== null) return userSkillsDirOverride;
  const env = (process.env.MANAMIR_USER_SKILLS_DIR ?? '').trim();
  if (env) return resolve(env);
  return join(homedir(), '.claude', 'skills');
}

function legacySkillsDir(): string {
  if (legacySkillsDirOverride !== null) return legacySkillsDirOverride;
  const env = (process.env.MANAMIR_LEGACY_SKILLS_DIR ?? '').trim();
  if (env) return resolve(env);
  return join(homedir(), '.manamir', 'skills');
}

function bundledSkillsDir(): string | null {
  if (bundledSkillsDirOverride !== null) return bundledSkillsDirOverride;
  const env = (process.env.MANAMIR_BUNDLED_SKILLS ?? '').trim();
  if (env) return resolve(env);
  return null;
}

export function getDiscoveryLocations(): DiscoveryLocation[] {
  const out: DiscoveryLocation[] = [];
  const proj = join(projectRoot(), '.claude', 'skills');
  out.push({ source: 'project', dir: proj, exists: existsSync(proj) });
  const usr = userSkillsDir();
  out.push({ source: 'user', dir: usr, exists: existsSync(usr) });
  const leg = legacySkillsDir();
  out.push({ source: 'legacy', dir: leg, exists: existsSync(leg) });
  const bundled = bundledSkillsDir();
  if (bundled) {
    out.push({ source: 'bundled', dir: bundled, exists: existsSync(bundled) });
  }
  return out;
}

function walkSkillMd(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.claude') continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (entry === 'SKILL.md') out.push(full);
    }
  };
  walk(root);
  return out;
}

interface ParseCache {
  fm: SkillFrontmatter;
  body: string;
  filePath: string;
}

function loadOne(filePath: string, source: Source): RawSkill | null {
  const cached = getCached<ParseCache>(filePath);
  let fm: SkillFrontmatter;
  let body: string;
  if (cached) {
    fm = cached.fm;
    body = cached.body;
  } else {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
    const parsed = parseSkillMarkdown(raw);
    if (!parsed) return null;
    fm = coerceFrontmatter(parsed.data);
    body = parsed.body;
    setCached<ParseCache>(filePath, { fm, body, filePath }, source);
  }
  const dir = dirname(filePath);
  const fallback = dir.split(sep).pop() ?? 'unnamed';
  if (!fm.name) fm.name = fallback;
  return {
    frontmatter: fm,
    body,
    directoryPath: dir,
    source,
    filePath,
  };
}

export interface DiscoverOptions {
  /** Include skills from the bundled location (default true). */
  includeBundled?: boolean;
  /** Include skills from the legacy ~/.manamir/skills (default true). */
  includeLegacy?: boolean;
}

/**
 * Walk every location and return all discovered skills, applying priority
 * resolution: a higher-priority skill of the same name wins.
 */
export function discoverSkills(options: DiscoverOptions = {}): DiscoveredSkill[] {
  const includeBundled = options.includeBundled !== false;
  const includeLegacy = options.includeLegacy !== false;

  const byName = new Map<string, DiscoveredSkill>();
  const sourceRank: Record<Source, number> = {
    project: 0,
    user: 1,
    legacy: 2,
    bundled: 3,
  };

  for (const loc of getDiscoveryLocations()) {
    if (!loc.exists) continue;
    if (loc.source === 'bundled' && !includeBundled) continue;
    if (loc.source === 'legacy' && !includeLegacy) continue;

    for (const md of walkSkillMd(loc.dir)) {
      const raw = loadOne(md, loc.source);
      if (!raw) continue;
      const name = raw.frontmatter.name;
      const existing = byName.get(name);
      if (existing && sourceRank[existing.source] < sourceRank[loc.source]) {
        // existing has higher priority (lower rank number); keep it.
        continue;
      }
      const trust = resolveTrust(raw.frontmatter, loc.source);
      byName.set(name, {
        name,
        source: loc.source,
        filePath: raw.filePath,
        directoryPath: raw.directoryPath,
        description: raw.frontmatter.description,
        category: raw.frontmatter.category,
        tags: raw.frontmatter.tags,
        version: raw.frontmatter.version,
        trust,
        last_used_at: raw.frontmatter.last_used_at,
        use_count: raw.frontmatter.use_count,
      });
    }
  }

  const arr = Array.from(byName.values());
  arr.sort((a, b) => a.name.localeCompare(b.name));
  return arr;
}

/** Find a single skill by name across all sources. Returns full RawSkill. */
export function findSkillByName(
  name: string,
  options: DiscoverOptions = {}
): RawSkill | null {
  const includeBundled = options.includeBundled !== false;
  const includeLegacy = options.includeLegacy !== false;

  // Walk in priority order; first match wins.
  for (const loc of getDiscoveryLocations()) {
    if (!loc.exists) continue;
    if (loc.source === 'bundled' && !includeBundled) continue;
    if (loc.source === 'legacy' && !includeLegacy) continue;

    for (const md of walkSkillMd(loc.dir)) {
      const raw = loadOne(md, loc.source);
      if (!raw) continue;
      if (raw.frontmatter.name === name) return raw;
    }
  }
  return null;
}
