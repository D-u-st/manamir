// User-extensible slash commands —
// markdown file based: drop a markdown file into
// either `~/.manamir/commands/` (global) or `<projectRoot>/.manamir/commands/`
// (project-level, takes precedence over global) and have it become a slash
// command in the CLI.
//
// File format:
//
//   ---
//   name: review
//   description: Review the current git diff
//   ---
//   Please review the diff at {{args}} and report bugs.
//
// Frontmatter is YAML-ish but we only parse a flat `key: value` form to avoid
// taking a YAML dep. `name` and `description` are required; everything else
// is ignored (forward-compat).
//
// Placeholder substitution at invocation time:
//   {{args}}  -> the entire arg string the user typed after the command name
//   {{argN}}  -> the Nth positional arg (1-indexed, missing -> empty string)
//
// Safety:
//   * Command names must match /^[a-z][a-z0-9-]*$/. Non-conforming files are
//     skipped with a warning so a typo doesn't silently fail.
//   * Built-in command names are reserved — user files cannot shadow them.
//   * Files larger than MAX_COMMAND_BYTES are skipped.
//   * Missing directories are tolerated (no throw).

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, basename, extname } from 'path';

export const MAX_COMMAND_BYTES = 50 * 1024; // 50KB
export const VALID_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Names users are not allowed to shadow. Keep in sync with cli.ts dispatcher. */
export const BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
  'exit',
  'quit',
  'help',
  'clear',
  'new',
  'sessions',
  'resume',
  'status',
  'cost',
  'auto',
  'cron',
  'skills',
  'interrupt',
  'plan',
  'image',
]);

export interface UserCommand {
  /** Lower-case command name (without the leading slash). */
  name: string;
  /** One-line description shown in /help. */
  description: string;
  /** Raw prompt body (frontmatter stripped). */
  body: string;
  /** Absolute path of the source file (for diagnostics). */
  source: string;
  /** "global" or "project" — project wins on a name clash. */
  scope: 'global' | 'project';
}

export interface LoadResult {
  commands: Map<string, UserCommand>;
  warnings: string[];
}

interface ParsedFile {
  name: string;
  description: string;
  body: string;
}

// ---------------- Path discovery ----------------

/**
 * Returns the candidate command directories in **load order** —
 * global first, then project. Project overrides global on a name clash.
 *
 * Project dir is resolved by walking up from `cwd` looking for a
 * `.manamir/commands` folder. The walk stops at the filesystem root or
 * after a reasonable number of steps.
 */
export function getUserCommandPaths(cwd: string = process.cwd()): Array<{ dir: string; scope: 'global' | 'project' }> {
  const out: Array<{ dir: string; scope: 'global' | 'project' }> = [];
  const globalDir = join(homedir(), '.manamir', 'commands');
  if (existsSync(globalDir)) out.push({ dir: globalDir, scope: 'global' });

  let dir = cwd;
  for (let i = 0; i < 64; i++) {
    const projectDir = join(dir, '.manamir', 'commands');
    if (existsSync(projectDir)) {
      out.push({ dir: projectDir, scope: 'project' });
      break;
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return out;
}

// ---------------- Frontmatter parsing ----------------

/**
 * Parses a markdown file body. Frontmatter must be the very first line
 * (`---`) terminated by another `---`. Returns null if the document does not
 * carry the required `name` field. Falls back to `description: ''` if absent.
 *
 * NB: this is *not* a real YAML parser — only flat `key: value` entries are
 * supported, value is the raw string (trimmed). Quoted strings have their
 * outer quotes stripped. Lists/objects are not supported and will be passed
 * through as raw strings (and ignored by the consumer, since only `name` and
 * `description` are read).
 */
export function parseCommandFile(text: string, fallbackName?: string): ParsedFile | null {
  // Normalise line endings — Windows users will commit CRLF files.
  const normalised = text.replace(/\r\n/g, '\n');

  let body = normalised;
  const fm: Record<string, string> = {};

  if (normalised.startsWith('---\n')) {
    const end = normalised.indexOf('\n---', 4);
    if (end !== -1) {
      const block = normalised.slice(4, end);
      // Body starts after the closing ---, plus optional newline.
      const after = normalised.slice(end + 4);
      body = after.startsWith('\n') ? after.slice(1) : after;
      for (const rawLine of block.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        let value = line.slice(colon + 1).trim();
        // Strip matching outer quotes.
        if (
          (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
          (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
        ) {
          value = value.slice(1, -1);
        }
        fm[key.toLowerCase()] = value;
      }
    }
  }

  const name = (fm.name || fallbackName || '').trim().toLowerCase();
  if (!name) return null;

  return {
    name,
    description: fm.description || '',
    body: body.trimEnd(),
  };
}

// ---------------- Loader ----------------

/**
 * Scans both candidate dirs and returns the merged command map plus any
 * warnings. Project-level files override global ones with the same name.
 * Built-in names are always rejected.
 *
 * The loader is deliberately permissive — a single bad file should not
 * prevent the rest from loading.
 */
export function loadUserCommands(cwd: string = process.cwd()): LoadResult {
  const commands = new Map<string, UserCommand>();
  const warnings: string[] = [];

  for (const { dir, scope } of getUserCommandPaths(cwd)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      warnings.push(`could not read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const entry of entries) {
      if (extname(entry).toLowerCase() !== '.md') continue;
      const full = join(dir, entry);

      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_COMMAND_BYTES) {
        warnings.push(`skipping ${full}: file too large (${st.size} > ${MAX_COMMAND_BYTES} bytes)`);
        continue;
      }

      let raw: string;
      try {
        raw = readFileSync(full, 'utf8');
      } catch (err) {
        warnings.push(`could not read ${full}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const fallback = basename(entry, '.md').toLowerCase();
      const parsed = parseCommandFile(raw, fallback);
      if (!parsed) {
        warnings.push(`skipping ${full}: no usable name (need frontmatter \`name:\` or a sensible filename)`);
        continue;
      }

      if (!VALID_NAME_RE.test(parsed.name)) {
        warnings.push(`skipping ${full}: invalid command name "${parsed.name}" (need /^[a-z][a-z0-9-]*$/)`);
        continue;
      }

      if (BUILTIN_COMMANDS.has(parsed.name)) {
        warnings.push(`skipping ${full}: "${parsed.name}" is a built-in command and cannot be overridden`);
        continue;
      }

      const existing = commands.get(parsed.name);
      // Project scope wins. Within the same scope, later-loaded wins (no
      // strong ordering guarantee from readdir, so we record a warning).
      if (existing) {
        if (existing.scope === 'project' && scope === 'global') {
          // Skip — project already won.
          continue;
        }
        if (existing.scope === scope) {
          warnings.push(
            `duplicate command "${parsed.name}" in ${scope} scope: ${existing.source} vs ${full} (using latter)`
          );
        }
      }

      commands.set(parsed.name, {
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        source: full,
        scope,
      });
    }
  }

  return { commands, warnings };
}

// ---------------- Argument substitution ----------------

/**
 * Splits an arg string the same way the CLI dispatcher splits its line:
 * by runs of whitespace, dropping empties.
 */
export function splitArgs(argString: string): string[] {
  if (!argString) return [];
  return argString.split(/\s+/).filter(Boolean);
}

/**
 * Substitutes `{{args}}` and `{{argN}}` placeholders in the command body.
 * Missing positional args become the empty string. The {{args}} placeholder
 * receives the joined raw args (single space).
 *
 * Substitution is a single pass — replacement text is treated as literal,
 * so a user passing `{{args}}` as an arg will not recurse.
 */
export function applyArgs(body: string, args: string[]): string {
  // Single-pass replacement using a callback so user-provided text in `args`
  // can't trigger a second substitution round.
  return body.replace(/\{\{\s*(args|arg(\d+))\s*\}\}/g, (_match, key: string, idx: string | undefined) => {
    if (key === 'args') return args.join(' ');
    const i = parseInt(idx as string, 10);
    if (!Number.isFinite(i) || i < 1) return '';
    return args[i - 1] ?? '';
  });
}

/**
 * Convenience: format a command for use as a prompt. Identical to
 * `applyArgs(cmd.body, args)`, factored out so cli.ts has one place to call.
 */
export function renderUserCommand(cmd: UserCommand, args: string[]): string {
  return applyArgs(cmd.body, args);
}
