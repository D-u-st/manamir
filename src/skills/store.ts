// Skill storage on disk. Each skill = directory with SKILL.md + optional subdirs.
// Atomic writes via tempfile + rename (reuses atomic-write.ts).
//
// Hash-protected save (parity):
//   - On every save we compute md5 of the body and stamp it into frontmatter
//     as `content_hash: 'md5:<hex>'`.
//   - On agent-driven save_skill, we re-read the existing file's stored hash;
//     if it differs from md5(currentBody) on disk, the user has edited the
//     file → we REFUSE overwrite unless force=true. The diff (or a preview) is
//     returned to the caller.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'fs';
import { createHash } from 'crypto';
import { dirname, join, relative, resolve, sep } from 'path';
import { atomicWrite } from '../utils/atomic-write';
import { coerceFrontmatter, parseSkillMarkdown, serializeFrontmatter } from './frontmatter';
import { resolveSkillsDir } from '../profile';
import type { Skill, SkillFrontmatter, SkillSummary } from './types';
import { ALLOWED_SUBDIRS } from './types';

let skillsRoot = resolveSkillsDir();

export function setSkillsDir(dir: string): void {
  skillsRoot = dir;
}

export function getSkillsDir(): string {
  return skillsRoot;
}

function ensureRoot(): void {
  if (!existsSync(skillsRoot)) mkdirSync(skillsRoot, { recursive: true });
}

export function bodyHash(body: string): string {
  return 'md5:' + createHash('md5').update(body, 'utf-8').digest('hex');
}

function findSkillMdFiles(root: string): string[] {
  const results: string[] = [];
  if (!existsSync(root)) return results;

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
      if (st.isDirectory()) {
        walk(full);
      } else if (entry === 'SKILL.md') {
        results.push(full);
      }
    }
  };

  walk(root);
  return results;
}

/**
 * Save a skill. Stamps content_hash, created_at/updated_at automatically.
 * Does NOT perform hash collision check — use saveSkillProtected for that.
 */
export async function saveSkill(skill: Skill): Promise<void> {
  ensureRoot();
  const dir = skill.directoryPath;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const nowIso = new Date().toISOString();
  const fm: SkillFrontmatter = {
    ...skill.frontmatter,
    content_hash: bodyHash(skill.body),
    updated_at: nowIso,
    updatedAt: Date.now(),
  };
  if (!fm.created_at) fm.created_at = nowIso;
  const md = serializeFrontmatter(fm, skill.body);
  await atomicWrite(join(dir, 'SKILL.md'), md);
}

export interface ProtectedSaveResult {
  ok: boolean;
  reason?: string;
  /** Existing file's body if a conflict was detected. */
  conflictBody?: string;
  conflictHash?: string;
  expectedHash?: string;
  /** A unified-ish diff sketch (limited; full diff not generated to keep deps light). */
  diff?: string;
}

/**
 * Hash-protected save.
 *
 * If the file does not exist → safe to write.
 * If the file exists:
 *   - read its frontmatter and body.
 *   - compare stored content_hash against md5(current body on disk).
 *   - if they match (no user edits since last AI write) → safe to overwrite.
 *   - if they differ → user has edited → REFUSE unless `force=true`.
 *
 * Always stamps a fresh content_hash on the new write.
 */
export async function saveSkillProtected(
  skill: Skill,
  options: { force?: boolean } = {}
): Promise<ProtectedSaveResult> {
  ensureRoot();
  const dir = skill.directoryPath;
  const mdPath = join(dir, 'SKILL.md');

  if (existsSync(mdPath)) {
    let raw: string;
    try {
      raw = readFileSync(mdPath, 'utf-8');
    } catch {
      raw = '';
    }
    const parsed = parseSkillMarkdown(raw);
    if (parsed) {
      const existingFm = coerceFrontmatter(parsed.data);
      const storedHash = existingFm.content_hash;
      const actualHash = bodyHash(parsed.body);
      if (storedHash && storedHash !== actualHash && !options.force) {
        return {
          ok: false,
          reason:
            'Skill file was modified outside of this agent (content_hash mismatch). Pass force=true to overwrite.',
          conflictBody: parsed.body,
          conflictHash: actualHash,
          expectedHash: storedHash,
          diff: makeDiff(parsed.body, skill.body),
        };
      }
    }
  }

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const nowIso = new Date().toISOString();
  const fm: SkillFrontmatter = {
    ...skill.frontmatter,
    content_hash: bodyHash(skill.body),
    updated_at: nowIso,
    updatedAt: Date.now(),
  };
  if (!fm.created_at) fm.created_at = nowIso;
  const md = serializeFrontmatter(fm, skill.body);
  await atomicWrite(mdPath, md);
  return { ok: true };
}

function makeDiff(a: string, b: string): string {
  // Very lightweight: show first divergent chunk + counts
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const maxLen = Math.max(aLines.length, bLines.length);
  const out: string[] = [];
  let firstDiff = -1;
  for (let i = 0; i < maxLen; i++) {
    if (aLines[i] !== bLines[i]) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff < 0) return '(no textual diff but hashes differ)';
  out.push(`First difference at line ${firstDiff + 1}:`);
  for (let i = firstDiff; i < Math.min(firstDiff + 10, maxLen); i++) {
    if (aLines[i] !== undefined) out.push(`- ${aLines[i]}`);
    if (bLines[i] !== undefined) out.push(`+ ${bLines[i]}`);
  }
  out.push(`(disk: ${aLines.length} lines, proposed: ${bLines.length} lines)`);
  return out.join('\n');
}

export function loadSkill(name: string): Skill | null {
  ensureRoot();
  const mdFiles = findSkillMdFiles(skillsRoot);
  for (const mdPath of mdFiles) {
    const dir = dirname(mdPath);
    const raw = readFileSync(mdPath, 'utf-8');
    const parsed = parseSkillMarkdown(raw);
    if (!parsed) continue;
    const fm = coerceFrontmatter(parsed.data);
    const skillName = fm.name || dir.split(sep).pop()!;
    if (skillName !== name) continue;

    const files = listSupportingFiles(dir);
    return {
      frontmatter: fm,
      body: parsed.body,
      directoryPath: dir,
      files,
    };
  }
  return null;
}

export function listSkills(): SkillSummary[] {
  ensureRoot();
  const mdFiles = findSkillMdFiles(skillsRoot);
  const out: SkillSummary[] = [];
  for (const mdPath of mdFiles) {
    try {
      const raw = readFileSync(mdPath, 'utf-8');
      const parsed = parseSkillMarkdown(raw);
      if (!parsed) continue;
      const fm = coerceFrontmatter(parsed.data);
      const dir = dirname(mdPath);
      const name = fm.name || dir.split(sep).pop()!;
      out.push({
        name,
        description: fm.description,
        category: fm.category,
        path: relative(skillsRoot, dir) || name,
        version: fm.version,
        tags: fm.tags,
        last_used_at: fm.last_used_at,
        use_count: fm.use_count,
      });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function deleteSkill(name: string): boolean {
  const skill = loadSkill(name);
  if (!skill) return false;
  rmSync(skill.directoryPath, { recursive: true, force: true });

  const parent = dirname(skill.directoryPath);
  if (parent !== skillsRoot && existsSync(parent)) {
    try {
      const remaining = readdirSync(parent);
      if (remaining.length === 0) rmSync(parent, { recursive: false });
    } catch {
      // ignore
    }
  }
  return true;
}

export function listSupportingFiles(skillDir: string): string[] {
  const out: string[] = [];
  for (const sub of ALLOWED_SUBDIRS) {
    const subDir = join(skillDir, sub);
    if (!existsSync(subDir)) continue;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.')) continue;
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else out.push(relative(skillDir, full).split(sep).join('/'));
      }
    };
    walk(subDir);
  }
  return out;
}

export function validateSkillFilePath(filePath: string): string | null {
  if (!filePath) return 'file_path is required.';
  const norm = filePath.replace(/\\/g, '/');
  if (norm.includes('../') || norm.startsWith('/')) {
    return 'Path traversal or absolute paths are not allowed.';
  }
  const parts = norm.split('/').filter(Boolean);
  if (!parts.length) return 'Empty file_path.';
  if (!ALLOWED_SUBDIRS.has(parts[0])) {
    return `File must be under: ${Array.from(ALLOWED_SUBDIRS).join(', ')}. Got: '${filePath}'`;
  }
  if (parts.length < 2) {
    return `Provide a file path, not just a directory. Example: '${parts[0]}/myfile.md'`;
  }
  return null;
}

export function resolveSkillTarget(skillDir: string, filePath: string): string | null {
  const target = resolve(skillDir, filePath);
  const baseResolved = resolve(skillDir);
  if (!target.startsWith(baseResolved + sep) && target !== baseResolved) {
    return null;
  }
  return target;
}

export function loadSupportingFile(skillDir: string, filePath: string): string | null {
  const target = resolveSkillTarget(skillDir, filePath);
  if (!target || !existsSync(target)) return null;
  return readFileSync(target, 'utf-8');
}

export async function writeSupportingFile(
  skillDir: string,
  filePath: string,
  content: string
): Promise<{ ok: boolean; error?: string }> {
  const err = validateSkillFilePath(filePath);
  if (err) return { ok: false, error: err };
  const target = resolveSkillTarget(skillDir, filePath);
  if (!target) return { ok: false, error: 'Resolved path escapes skill directory.' };
  await atomicWrite(target, content);
  return { ok: true };
}

export function removeSupportingFile(
  skillDir: string,
  filePath: string
): { ok: boolean; error?: string } {
  const err = validateSkillFilePath(filePath);
  if (err) return { ok: false, error: err };
  const target = resolveSkillTarget(skillDir, filePath);
  if (!target) return { ok: false, error: 'Resolved path escapes skill directory.' };
  if (!existsSync(target)) return { ok: false, error: `File not found: ${filePath}` };
  unlinkSync(target);
  const parent = dirname(target);
  try {
    if (existsSync(parent) && readdirSync(parent).length === 0) {
      rmSync(parent, { recursive: false });
    }
  } catch {
    // ignore
  }
  return { ok: true };
}

export function computeSkillDir(name: string, category?: string): string {
  ensureRoot();
  return category ? join(skillsRoot, category, name) : join(skillsRoot, name);
}

/**
 * Touch the use_count + last_used_at fields on disk (best-effort, non-blocking).
 * Used when a skill is invoked.
 */
export async function bumpSkillUsage(name: string): Promise<void> {
  const skill = loadSkill(name);
  if (!skill) return;
  const fm: SkillFrontmatter = {
    ...skill.frontmatter,
    use_count: (skill.frontmatter.use_count ?? 0) + 1,
    last_used_at: new Date().toISOString(),
  };
  // Preserve hash since body unchanged
  const md = serializeFrontmatter(fm, skill.body);
  try {
    await atomicWrite(join(skill.directoryPath, 'SKILL.md'), md);
  } catch {
    // ignore
  }
}
