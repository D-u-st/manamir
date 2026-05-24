// User-editable project/global context loader (CLAUDE.md equivalent for manamir).
//
// Looks for MANAMIR.md in two locations (both optional):
//   1. Global: ~/.manamir/MANAMIR.md  (applies to all sessions)
//   2. Local : <cwd>/.manamir/MANAMIR.md  (project-specific, appended after global)
//
// Use cases:
//   - Tell manamir about current project state (version, focus, constraints)
//   - Personal preferences (language, response style, taboos)
//   - Project-specific conventions (file layout, deployment notes)
//
// Why a separate file vs the existing memory system:
//   - Memory: AI-curated, append-only, lossy (summarized over time)
//   - MANAMIR.md: User-edited, deterministic, exact text injected
//
// Loaded once per process (cached). Restart manamir to pick up changes.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { log } from '../utils/logger';

const MAX_CONTEXT_CHARS = 8192; // ~2K tokens cap, safe for any model
const CONTEXT_FILENAME = 'MANAMIR.md';

let cachedContext: string | null | undefined = undefined; // undefined = not yet checked

function safeRead(path: string, label: string): string | null {
  try {
    const content = readFileSync(path, 'utf-8').trim();
    if (!content) return null;
    log.info(`UserContext: loaded ${label}`, { path, chars: content.length });
    return content;
  } catch (err) {
    log.warn(`UserContext: failed to read ${label}`, { path, err: String(err) });
    return null;
  }
}

/**
 * Load user context from ~/.manamir/MANAMIR.md and <cwd>/.manamir/MANAMIR.md.
 * Returns null if neither exists or both empty. Cached after first call.
 */
export function loadUserContext(cwd?: string): string | null {
  if (cachedContext !== undefined) return cachedContext;

  const parts: string[] = [];

  const globalPath = join(homedir(), '.manamir', CONTEXT_FILENAME);
  if (existsSync(globalPath)) {
    const content = safeRead(globalPath, 'global');
    if (content) {
      parts.push(`# Global User Context (~/.manamir/${CONTEXT_FILENAME})\n${content}`);
    }
  }

  if (cwd) {
    const localPath = join(cwd, '.manamir', CONTEXT_FILENAME);
    if (existsSync(localPath)) {
      const content = safeRead(localPath, 'project');
      if (content) {
        parts.push(`# Project Context (./.manamir/${CONTEXT_FILENAME})\n${content}`);
      }
    }
  }

  if (parts.length === 0) {
    cachedContext = null;
    return null;
  }

  let merged = parts.join('\n\n');
  if (merged.length > MAX_CONTEXT_CHARS) {
    log.warn('UserContext: truncated to MAX_CONTEXT_CHARS', {
      original: merged.length,
      max: MAX_CONTEXT_CHARS,
    });
    merged = merged.slice(0, MAX_CONTEXT_CHARS) + `\n\n[... truncated to ${MAX_CONTEXT_CHARS} chars]`;
  }

  cachedContext = merged;
  return merged;
}

/** Reset cache. Used by tests / manual reload. */
export function clearUserContextCache(): void {
  cachedContext = undefined;
}
