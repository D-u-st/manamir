// Skill sync — manifest-based seeding of bundled skills with user-modification detection.
// Uses MD5 hash of directory contents to detect changes.
//
// Update logic:
//   - NEW skills (not in manifest): copy to user dir, record origin hash
//   - EXISTING (user hash == origin hash): safe to update if bundled changed
//   - EXISTING (user hash != origin hash): user customized — skip, respect their edits
//   - DELETED by user (in manifest, absent on disk): respect deletion
//   - REMOVED from bundled: clean from manifest

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { dirname, join, relative, sep } from 'path';
import { getSkillsDir } from './store';
import { invalidateCache } from './registry';

function manifestPath(): string {
  return join(getSkillsDir(), '.bundled_manifest');
}

function readManifest(): Map<string, string> {
  const m = new Map<string, string>();
  const mp = manifestPath();
  if (!existsSync(mp)) return m;
  try {
    const content = readFileSync(mp, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(':');
      if (idx === -1) {
        m.set(trimmed, '');
      } else {
        m.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
      }
    }
  } catch {
    // ignore
  }
  return m;
}

function writeManifest(entries: Map<string, string>): void {
  const mp = manifestPath();
  const dir = dirname(mp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sorted = Array.from(entries.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const data = sorted.map(([n, h]) => `${n}:${h}`).join('\n') + '\n';
  const tmp = mp + '.tmp';
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, mp);
}

function dirHash(dir: string): string {
  const hasher = createHash('md5');
  if (!existsSync(dir)) return hasher.digest('hex');

  const files: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  files.sort();

  for (const f of files) {
    const rel = relative(dir, f).split(sep).join('/');
    hasher.update(rel);
    try {
      hasher.update(readFileSync(f));
    } catch {
      // ignore unreadable
    }
  }
  return hasher.digest('hex');
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    const st = statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

function readSkillName(skillMd: string, fallback: string): string {
  try {
    const content = readFileSync(skillMd, 'utf-8').slice(0, 4000);
    let inFm = false;
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t === '---') {
        if (inFm) break;
        inFm = true;
        continue;
      }
      if (inFm && t.startsWith('name:')) {
        const v = t.slice(5).trim().replace(/^["']|["']$/g, '');
        if (v) return v;
      }
    }
  } catch {
    // ignore
  }
  return fallback;
}

function discoverBundled(bundledDir: string): Array<{ name: string; dir: string }> {
  const out: Array<{ name: string; dir: string }> = [];
  if (!existsSync(bundledDir)) return out;

  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    if (entries.includes('SKILL.md')) {
      const mdPath = join(d, 'SKILL.md');
      const name = readSkillName(mdPath, d.split(sep).pop()!);
      out.push({ name, dir: d });
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = join(d, entry);
      try {
        if (statSync(full).isDirectory()) walk(full);
      } catch {
        continue;
      }
    }
  };
  walk(bundledDir);
  return out;
}

export interface SyncResult {
  copied: string[];
  updated: string[];
  skipped: number;
  userModified: string[];
  cleaned: string[];
  totalBundled: number;
}

export function syncSkills(bundledDir?: string): SyncResult {
  const src = bundledDir || process.env.MANAMIR_BUNDLED_SKILLS;
  const skillsRoot = getSkillsDir();

  const result: SyncResult = {
    copied: [],
    updated: [],
    skipped: 0,
    userModified: [],
    cleaned: [],
    totalBundled: 0,
  };

  if (!src || !existsSync(src)) return result;

  if (!existsSync(skillsRoot)) mkdirSync(skillsRoot, { recursive: true });
  const manifest = readManifest();
  const bundled = discoverBundled(src);
  const bundledNames = new Set(bundled.map((b) => b.name));
  result.totalBundled = bundled.length;

  for (const { name, dir: skillSrc } of bundled) {
    const rel = relative(src, skillSrc);
    const dest = join(skillsRoot, rel);
    const bundledHash = dirHash(skillSrc);

    if (!manifest.has(name)) {
      if (existsSync(dest)) {
        result.skipped++;
        manifest.set(name, bundledHash);
      } else {
        try {
          copyDir(skillSrc, dest);
          result.copied.push(name);
          manifest.set(name, bundledHash);
        } catch {
          // retry next sync
        }
      }
      continue;
    }

    if (!existsSync(dest)) {
      // user deleted — respect
      result.skipped++;
      continue;
    }

    const originHash = manifest.get(name) ?? '';
    const userHash = dirHash(dest);

    if (!originHash) {
      // v1 migration — set baseline
      manifest.set(name, userHash);
      result.skipped++;
      continue;
    }

    if (userHash !== originHash) {
      result.userModified.push(name);
      continue;
    }

    if (bundledHash !== originHash) {
      const backup = dest + '.bak';
      try {
        renameSync(dest, backup);
        try {
          copyDir(skillSrc, dest);
          manifest.set(name, bundledHash);
          result.updated.push(name);
          rmSync(backup, { recursive: true, force: true });
        } catch {
          if (existsSync(backup) && !existsSync(dest)) {
            renameSync(backup, dest);
          }
        }
      } catch {
        // ignore
      }
    } else {
      result.skipped++;
    }
  }

  // Clean stale manifest entries
  for (const name of manifest.keys()) {
    if (!bundledNames.has(name)) {
      manifest.delete(name);
      result.cleaned.push(name);
    }
  }
  result.cleaned.sort();

  writeManifest(manifest);
  invalidateCache();

  return result;
}
