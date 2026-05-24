// Profile isolation — each profile gets independent session/memory/skills/log dirs.
// Activated by MANAMIR_PROFILE env var. Default profile = 'default'.
//
// Profile root layout: ./data/profiles/<name>/{sessions,memory,skills,speculation,logs}
// If a per-resource env var is explicitly set (e.g. SESSION_DATA_DIR), it wins.

import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

const DEFAULT_PROFILE = 'default';
const VALID_PROFILE_RE = /^[a-zA-Z0-9_-]{1,40}$/;

let activeProfile: string | null = null;
let profileRoot: string | null = null;

function readProfileEnv(): string {
  const raw = (process.env.MANAMIR_PROFILE ?? '').trim();
  if (!raw) return DEFAULT_PROFILE;
  if (!VALID_PROFILE_RE.test(raw)) {
    throw new Error(`Invalid MANAMIR_PROFILE '${raw}': must match ${VALID_PROFILE_RE}`);
  }
  return raw;
}

function readProfilesRoot(): string {
  const env = (process.env.MANAMIR_PROFILES_ROOT ?? '').trim();
  if (env) return resolve(env);
  return resolve('./data/profiles');
}

/** Get the active profile name. Computed once on first call, cached. */
export function getProfileName(): string {
  if (activeProfile === null) {
    activeProfile = readProfileEnv();
  }
  return activeProfile;
}

/** Get the absolute path of the active profile's root directory. */
export function getProfileRoot(): string {
  if (profileRoot === null) {
    profileRoot = join(readProfilesRoot(), getProfileName());
    if (!existsSync(profileRoot)) {
      mkdirSync(profileRoot, { recursive: true });
    }
  }
  return profileRoot;
}

/**
 * Get a subpath within the active profile's root. The profile root itself is
 * created lazily by getProfileRoot(); intermediate subdirs are NOT created
 * here — callers create them on first write (matches MemoryStore/SessionManager
 * existing behavior).
 */
export function profilePath(...parts: string[]): string {
  return join(getProfileRoot(), ...parts);
}

/**
 * Resolve a config path: env var wins, otherwise default to profile-scoped path.
 * @param envValue raw env var value (may be undefined or empty)
 * @param ...defaultParts path components inside the profile root
 */
export function resolveProfileScoped(
  envValue: string | undefined,
  ...defaultParts: string[]
): string {
  const raw = (envValue ?? '').trim();
  if (raw) return resolve(raw);
  return profilePath(...defaultParts);
}

/** Skills dir: env override > profile-scoped > legacy ~/.manamir/skills fallback. */
export function resolveSkillsDir(): string {
  const env = (process.env.SKILLS_DIR ?? '').trim();
  if (env) return resolve(env);
  // If a non-default profile is active, scope skills under it
  if (getProfileName() !== DEFAULT_PROFILE) {
    return profilePath('skills');
  }
  // Default profile keeps legacy global location for backward compat
  return join(homedir(), '.manamir', 'skills');
}

/** Reset cached state (for tests only). */
export function resetProfileCache(): void {
  activeProfile = null;
  profileRoot = null;
}
