// 3-tier progressive skill loading + catalog rendering for system prompt injection.
//
// Tier 1: name + description (one-line catalog)
// Tier 2: frontmatter + first 1000 chars of body + supporting file list
// Tier 3: full frontmatter + full body + supporting files
//
// Catalog rendering caps tier-1 output at 5KB; if discovered skills exceed that,
// we sort by last_used_at desc and include only the top N that fit.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { discoverSkills, findSkillByName } from './discovery';
import { invalidateCached } from './cache';
import {
  ALLOWED_SUBDIRS,
  TIER1_MAX_BYTES,
  TIER2_PREVIEW_CHARS,
  type DiscoveredSkill,
  type Skill,
  type SkillSummary,
  type SkillTier2View,
  type SkillTier3View,
} from './types';
import { listSkills as legacyListSkills, loadSkill as legacyLoadSkill } from './store';

/**
 * Tier-1 listing.
 *
 * Returns minimal records for every discoverable skill across all 4 locations,
 * with priority resolution applied. Falls back to the legacy single-root store
 * when no skills are discovered (preserves backward compat with skillSynth extractor).
 */
export function listSkillsTier1(): SkillSummary[] {
  const discovered = discoverSkills();
  if (discovered.length > 0) {
    return discovered.map<SkillSummary>((d) => ({
      name: d.name,
      description: d.description,
      category: d.category,
      path: d.directoryPath,
      source: d.source,
      tags: d.tags,
      version: d.version,
      last_used_at: d.last_used_at,
      use_count: d.use_count,
    }));
  }
  return legacyListSkills();
}

function listSupporting(skillDir: string): string[] {
  const out: string[] = [];
  for (const sub of ALLOWED_SUBDIRS) {
    const subDir = join(skillDir, sub);
    if (!existsSync(subDir)) continue;
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const full = join(dir, entry);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full);
        else out.push(relative(skillDir, full).split(sep).join('/'));
      }
    };
    walk(subDir);
  }
  return out;
}

/**
 * Tier-2 view: frontmatter + first 1000 chars of body + supporting file list.
 * No body beyond the preview is loaded.
 */
export function viewSkillTier2(name: string): SkillTier2View | null {
  const raw = findSkillByName(name);
  if (raw) {
    const preview = raw.body.length > TIER2_PREVIEW_CHARS
      ? raw.body.slice(0, TIER2_PREVIEW_CHARS)
      : raw.body;
    return {
      name: raw.frontmatter.name || name,
      frontmatter: raw.frontmatter,
      preview,
      truncated: raw.body.length > TIER2_PREVIEW_CHARS,
      files: listSupporting(raw.directoryPath),
      source: raw.source,
      directoryPath: raw.directoryPath,
    };
  }
  // Legacy fallback
  const legacy = legacyLoadSkill(name);
  if (!legacy) return null;
  const preview = legacy.body.length > TIER2_PREVIEW_CHARS
    ? legacy.body.slice(0, TIER2_PREVIEW_CHARS)
    : legacy.body;
  return {
    name: legacy.frontmatter.name || name,
    frontmatter: legacy.frontmatter,
    preview,
    truncated: legacy.body.length > TIER2_PREVIEW_CHARS,
    files: legacy.files ?? listSupporting(legacy.directoryPath),
    source: 'user',
    directoryPath: legacy.directoryPath,
  };
}

/** Tier-3 view: full frontmatter + full body + supporting files. */
export function viewSkillTier3(name: string): SkillTier3View | null {
  const raw = findSkillByName(name);
  if (raw) {
    return {
      name: raw.frontmatter.name || name,
      frontmatter: raw.frontmatter,
      body: raw.body,
      files: listSupporting(raw.directoryPath),
      source: raw.source,
      directoryPath: raw.directoryPath,
    };
  }
  const legacy = legacyLoadSkill(name);
  if (!legacy) return null;
  return {
    name: legacy.frontmatter.name || name,
    frontmatter: legacy.frontmatter,
    body: legacy.body,
    files: legacy.files ?? listSupporting(legacy.directoryPath),
    source: 'user',
    directoryPath: legacy.directoryPath,
  };
}

/**
 * Read a supporting file inside a skill directory.
 * Path-traversal protected: filePath must resolve under directoryPath.
 */
export function readSkillFile(
  name: string,
  filePath: string
): { content: string; error?: string } {
  const view = viewSkillTier3(name);
  if (!view) return { content: '', error: `Skill '${name}' not found.` };
  const norm = filePath.replace(/\\/g, '/');
  if (!norm || norm.includes('..') || norm.startsWith('/') || /^[a-z]:/i.test(norm)) {
    return { content: '', error: 'Invalid file path (traversal/absolute).' };
  }
  const parts = norm.split('/').filter(Boolean);
  if (!parts.length) return { content: '', error: 'Empty file path.' };
  if (!ALLOWED_SUBDIRS.has(parts[0])) {
    return {
      content: '',
      error: `File must live under: ${Array.from(ALLOWED_SUBDIRS).join(', ')}.`,
    };
  }
  const target = join(view.directoryPath, ...parts);
  // Defense in depth: resolve and confirm the target is still inside the dir
  const resolvedDir = view.directoryPath;
  if (!target.startsWith(resolvedDir + sep) && target !== resolvedDir) {
    return { content: '', error: 'Resolved path escapes skill directory.' };
  }
  if (!existsSync(target)) {
    return {
      content: '',
      error: `File '${filePath}' not found. Available: ${view.files.join(', ') || '(none)'}`,
    };
  }
  let st;
  try {
    st = statSync(target);
  } catch {
    return { content: '', error: 'Cannot stat file.' };
  }
  if (!st.isFile()) {
    return { content: '', error: 'Target is not a regular file.' };
  }
  try {
    return { content: readFileSync(target, 'utf-8') };
  } catch (err) {
    return {
      content: '',
      error: err instanceof Error ? err.message : 'Read failed.',
    };
  }
}

/* ============================================================================
 * Backward-compat shims used by skill_view / skill_manage / skillSynth-extractor
 * ============================================================================ */

export function viewSkill(name: string): Skill | null {
  const view = viewSkillTier3(name);
  if (!view) return null;
  return {
    frontmatter: view.frontmatter,
    body: view.body,
    directoryPath: view.directoryPath,
    files: view.files,
    source: view.source,
  };
}

export function viewSkillFile(
  name: string,
  filePath: string
): { content: string; error?: string } {
  return readSkillFile(name, filePath);
}

export function invalidateCache(_name?: string): void {
  // The new cache is path-keyed; we can't easily invalidate by name, so blow it all.
  invalidateCached();
}

/* ============================================================================
 * Catalog rendering — what gets injected into the system prompt
 * ============================================================================ */

function lastUsedTime(s: SkillSummary | DiscoveredSkill): number {
  if (s.last_used_at) {
    const t = Date.parse(s.last_used_at);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

export interface CatalogOptions {
  /** Filter by category (substring match, case-insensitive). */
  category?: string;
  /** Hard cap (bytes); default 5KB. Use 0 for unlimited. */
  maxBytes?: number;
  /** Group lines by category if available (default true). */
  group?: boolean;
}

/**
 * Render the tier-1 skills catalog for system prompt injection.
 *
 * Format (when grouped):
 *   # Available Skills (call skill_view to see how to use)
 *   - skill-a: description...
 *   - skill-b: description...
 *
 *   ## category-x
 *   - skill-c: description...
 */
export function renderSkillCatalog(options: CatalogOptions = {}): string {
  const cap = options.maxBytes ?? TIER1_MAX_BYTES;
  const group = options.group !== false;
  let skills = listSkillsTier1();
  if (options.category) {
    const needle = options.category.toLowerCase();
    skills = skills.filter((s) => (s.category ?? '').toLowerCase().includes(needle));
  }
  if (!skills.length) return '';

  // Sort by last_used_at desc (recently used first), then name
  skills.sort((a, b) => {
    const ta = lastUsedTime(a);
    const tb = lastUsedTime(b);
    if (tb !== ta) return tb - ta;
    return a.name.localeCompare(b.name);
  });

  const header = '# Available Skills (call skill_view to see how to use)';
  const footer =
    'If you completed a complex task (5+ tool calls) successfully, consider saving it via `skill_manage` for future reuse.';

  const renderLine = (s: SkillSummary): string => `- ${s.name}: ${s.description}`;

  let out = header + '\n';
  let truncated = false;

  if (group) {
    const uncategorized: SkillSummary[] = [];
    const byCategory = new Map<string, SkillSummary[]>();
    for (const s of skills) {
      if (!s.category) {
        uncategorized.push(s);
      } else {
        const arr = byCategory.get(s.category) ?? [];
        arr.push(s);
        byCategory.set(s.category, arr);
      }
    }
    // uncategorized first
    for (const s of uncategorized) {
      const ln = renderLine(s) + '\n';
      if (cap > 0 && Buffer.byteLength(out + ln, 'utf-8') > cap) {
        truncated = true;
        break;
      }
      out += ln;
    }
    if (!truncated) {
      const cats = Array.from(byCategory.keys()).sort();
      for (const cat of cats) {
        const sectionHeader = `\n## ${cat}\n`;
        if (cap > 0 && Buffer.byteLength(out + sectionHeader, 'utf-8') > cap) {
          truncated = true;
          break;
        }
        out += sectionHeader;
        for (const s of byCategory.get(cat)!) {
          const ln = renderLine(s) + '\n';
          if (cap > 0 && Buffer.byteLength(out + ln, 'utf-8') > cap) {
            truncated = true;
            break;
          }
          out += ln;
        }
        if (truncated) break;
      }
    }
  } else {
    for (const s of skills) {
      const ln = renderLine(s) + '\n';
      if (cap > 0 && Buffer.byteLength(out + ln, 'utf-8') > cap) {
        truncated = true;
        break;
      }
      out += ln;
    }
  }

  if (truncated) {
    out += '... (truncated at 5KB; sorted by recently-used first)\n';
  }
  out += '\n' + footer;
  return out;
}

/** For instrumentation/tests: how many bytes the catalog occupies. */
export function catalogByteSize(options?: CatalogOptions): number {
  return Buffer.byteLength(renderSkillCatalog(options), 'utf-8');
}
