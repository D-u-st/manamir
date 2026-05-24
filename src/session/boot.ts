// BOOT.md auto-execute — load a project-root BOOT.md file and inject its
// contents as a system message on first user turn.
//
// No Bun APIs. ES modules.

import { existsSync, readFileSync, statSync } from 'fs';
import { join, isAbsolute } from 'path';
import { log } from '../utils/logger';

export interface BootConfig {
  /** Directory to look for BOOT.md (no parent walk, no recursion). */
  projectRoot: string;
  /** Maximum size in bytes; larger files are refused. Default 32_000. */
  maxSizeBytes?: number;
}

const DEFAULT_MAX_SIZE = 32_000;
const BOOT_FILENAME = 'BOOT.md';

/**
 * Load BOOT.md from the configured project root.
 *
 * Returns the file content as a string when:
 *   - BOOT_MD_PATH env override (if set) points at a readable file, OR
 *   - `<projectRoot>/BOOT.md` exists and is readable.
 *
 * Returns null when:
 *   - file is missing,
 *   - file exceeds `maxSizeBytes` (warning logged),
 *   - any IO error occurs (warning logged).
 */
export function loadBoot(config: BootConfig): string | null {
  const maxSize = config.maxSizeBytes ?? DEFAULT_MAX_SIZE;

  // Allow env override, but only if it points at an existing absolute or
  // project-root-relative file. Empty / blank values are ignored.
  const envOverride = (process.env.BOOT_MD_PATH || '').trim();
  let target: string;
  if (envOverride.length > 0) {
    target = isAbsolute(envOverride) ? envOverride : join(config.projectRoot, envOverride);
  } else {
    target = join(config.projectRoot, BOOT_FILENAME);
  }

  if (!existsSync(target)) {
    return null;
  }

  let size: number;
  try {
    size = statSync(target).size;
  } catch (err) {
    log.warn('BOOT.md stat failed', { path: target, error: String(err) });
    return null;
  }

  if (size > maxSize) {
    log.warn('BOOT.md exceeds maxSizeBytes — refusing to load', {
      path: target,
      size,
      maxSize
    });
    return null;
  }

  try {
    const content = readFileSync(target, 'utf8');
    return content;
  } catch (err) {
    log.warn('BOOT.md read failed', { path: target, error: String(err) });
    return null;
  }
}

/**
 * Wrap raw BOOT.md content as an XML-tagged system message that downstream
 * preprocessors will recognize and preserve.
 */
export function formatBootForSystemPrompt(content: string): string {
  return `<boot-instructions source="BOOT.md">\n${content}\n</boot-instructions>`;
}
