// Minimal YAML frontmatter parser — no external deps.
// Supports: scalar strings, quoted strings, numbers, booleans, flow arrays ([a, b, c]),
// block arrays (- item), nested mappings one level deep, and multi-line block scalars
// with the | (literal) indicator (used for `when_to_use`).
//
// Not a full YAML parser. Sufficient for SKILL.md frontmatter.
//
// Includes a validator for the standard schema.

import type {
  CreatedBy,
  SkillExample,
  SkillFrontmatter,
  Trust,
  ValidationError,
  ValidationResult,
} from './types';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_DESCRIPTION_LENGTH_STRICT,
  MAX_NAME_LENGTH,
  MAX_TAG_COUNT,
  SEMVER_RE,
  STRICT_NAME_RE,
  VALID_NAME_RE,
} from './types';

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function splitFrontmatter(content: string): { yaml: string; body: string } | null {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return null;
  return { yaml: m[1], body: m[2] ?? '' };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0];
    const z = t[t.length - 1];
    if ((a === '"' && z === '"') || (a === "'" && z === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return stripQuotes(s);
}

function parseFlowArray(raw: string): unknown[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  const out: unknown[] = [];
  let depth = 0;
  let cur = '';
  let inQuote: string | null = null;
  for (const ch of inner) {
    if (inQuote) {
      cur += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(parseScalar(cur));
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(parseScalar(cur));
  return out;
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

export function parseYamlFrontmatter(yaml: string): Record<string, unknown> {
  const lines = yaml.split(/\r?\n/);
  const out: Record<string, unknown> = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    if (indentOf(line) !== 0) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    // Block scalar | (literal) — collect indented lines verbatim
    if (rest === '|' || rest === '|-' || rest === '|+') {
      const collected: string[] = [];
      let j = i + 1;
      let blockIndent = -1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) {
          collected.push('');
          j++;
          continue;
        }
        const ind = indentOf(l);
        if (blockIndent < 0) {
          if (ind === 0) break;
          blockIndent = ind;
        }
        if (ind < blockIndent) break;
        collected.push(l.slice(blockIndent));
        j++;
      }
      // Trim trailing empty for | and |- variants
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
      out[key] = collected.join('\n');
      i = j;
      continue;
    }

    if (rest === '') {
      // Block value follows
      const children: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) {
          children.push(l);
          j++;
          continue;
        }
        if (indentOf(l) === 0) break;
        children.push(l);
        j++;
      }
      out[key] = parseBlock(children);
      i = j;
      continue;
    }

    if (rest.startsWith('[')) {
      out[key] = parseFlowArray(rest);
    } else {
      out[key] = parseScalar(rest);
    }
    i++;
  }

  return out;
}

function parseBlock(lines: string[]): unknown {
  const nonEmpty = lines.filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (nonEmpty.length === 0) return null;

  const first = nonEmpty[0];
  const baseIndent = indentOf(first);
  const trimmedFirst = first.trim();

  if (trimmedFirst.startsWith('- ') || trimmedFirst === '-') {
    // Block array
    const items: unknown[] = [];
    let current: string[] = [];
    for (const raw of lines) {
      const ind = indentOf(raw);
      const t = raw.slice(baseIndent);
      if (ind === baseIndent && (t.startsWith('- ') || t === '-')) {
        if (current.length) items.push(parseBlockItem(current));
        current = [t.slice(1).replace(/^\s/, '')];
      } else if (raw.trim()) {
        current.push(raw.slice(baseIndent + 2));
      }
    }
    if (current.length) items.push(parseBlockItem(current));
    return items;
  }

  // Nested mapping
  const obj: Record<string, unknown> = {};
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const t = raw.slice(baseIndent);
    const ci = t.indexOf(':');
    if (ci === -1) continue;
    const k = t.slice(0, ci).trim();
    const v = t.slice(ci + 1).trim();
    if (v.startsWith('[')) obj[k] = parseFlowArray(v);
    else obj[k] = parseScalar(v);
  }
  return obj;
}

function parseBlockItem(itemLines: string[]): unknown {
  const first = itemLines[0];
  const colonIdx = first.indexOf(':');
  if (colonIdx === -1 || (itemLines.length === 1 && !/:\s/.test(first))) {
    return parseScalar(first);
  }
  const obj: Record<string, unknown> = {};
  for (const l of itemLines) {
    const ci = l.indexOf(':');
    if (ci === -1) continue;
    const k = l.slice(0, ci).trim();
    const v = l.slice(ci + 1).trim();
    obj[k] = v.startsWith('[') ? parseFlowArray(v) : parseScalar(v);
  }
  return obj;
}

export function parseSkillMarkdown(content: string): ParsedFrontmatter | null {
  const split = splitFrontmatter(content);
  if (!split) return null;
  return { data: parseYamlFrontmatter(split.yaml), body: split.body };
}

const KNOWN_TRUST: ReadonlyArray<Trust> = ['system', 'user', 'agent'];
const KNOWN_CREATED_BY: ReadonlyArray<CreatedBy> = ['system', 'user', 'agent'];

export interface CoerceOptions {
  /** Strict schema (description<=200, name 3-40, etc) */
  strict?: boolean;
}

/** Coerce a parsed YAML object into a SkillFrontmatter (does not validate). */
export function coerceFrontmatter(data: Record<string, unknown>): SkillFrontmatter {
  const now = Date.now();
  const examples = Array.isArray(data.examples)
    ? (data.examples as unknown[])
        .map((e) => {
          if (!e || typeof e !== 'object') return null;
          const obj = e as Record<string, unknown>;
          const input = obj.input != null ? String(obj.input) : '';
          const output = obj.output != null ? String(obj.output) : '';
          if (!input && !output) return null;
          return { input, output } satisfies SkillExample;
        })
        .filter((x): x is SkillExample => x !== null)
    : undefined;

  const trust = typeof data.trust === 'string' && KNOWN_TRUST.includes(data.trust as Trust)
    ? (data.trust as Trust)
    : undefined;
  const createdBy =
    typeof data.created_by === 'string' && KNOWN_CREATED_BY.includes(data.created_by as CreatedBy)
      ? (data.created_by as CreatedBy)
      : undefined;

  return {
    name: String(data.name ?? ''),
    description: String(data.description ?? ''),
    version: data.version != null ? String(data.version) : undefined,
    platforms: Array.isArray(data.platforms) ? (data.platforms as SkillFrontmatter['platforms']) : undefined,
    category: data.category != null ? String(data.category) : undefined,
    tags: Array.isArray(data.tags) ? (data.tags as string[]).map(String) : undefined,
    relatedSkills: Array.isArray(data.relatedSkills)
      ? (data.relatedSkills as string[]).map(String)
      : undefined,
    config: Array.isArray(data.config) ? (data.config as SkillFrontmatter['config']) : undefined,
    when_to_use: data.when_to_use != null ? String(data.when_to_use) : undefined,
    examples,
    allowed_tools: Array.isArray(data.allowed_tools)
      ? (data.allowed_tools as unknown[]).map(String)
      : undefined,
    forbidden_tools: Array.isArray(data.forbidden_tools)
      ? (data.forbidden_tools as unknown[]).map(String)
      : undefined,
    trust,
    created_by: createdBy,
    created_at: data.created_at != null ? String(data.created_at) : undefined,
    updated_at: data.updated_at != null ? String(data.updated_at) : undefined,
    content_hash: data.content_hash != null ? String(data.content_hash) : undefined,
    use_count: typeof data.use_count === 'number' ? data.use_count : undefined,
    last_used_at: data.last_used_at != null ? String(data.last_used_at) : undefined,
    createdAt:
      typeof data.createdAt === 'number'
        ? data.createdAt
        : typeof data.created_at === 'string'
          ? Date.parse(data.created_at) || now
          : now,
    updatedAt:
      typeof data.updatedAt === 'number'
        ? data.updatedAt
        : typeof data.updated_at === 'string'
          ? Date.parse(data.updated_at) || now
          : now,
  };
}

/** strict validator. Returns an error list (empty = ok). */
export function validateFrontmatter(
  fm: SkillFrontmatter,
  opts: CoerceOptions = {}
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  // name
  if (!fm.name) {
    errors.push({ field: 'name', message: "Required field 'name' is missing.", severity: 'error' });
  } else if (opts.strict) {
    if (!STRICT_NAME_RE.test(fm.name)) {
      errors.push({
        field: 'name',
        message: `name must be 3-40 chars matching ${STRICT_NAME_RE} (got '${fm.name}').`,
        severity: 'error',
      });
    }
  } else {
    if (fm.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: 'name',
        message: `name exceeds ${MAX_NAME_LENGTH} chars.`,
        severity: 'error',
      });
    }
    if (!VALID_NAME_RE.test(fm.name)) {
      errors.push({
        field: 'name',
        message: `name must match ${VALID_NAME_RE} (got '${fm.name}').`,
        severity: 'error',
      });
    }
  }

  // description
  if (!fm.description) {
    errors.push({
      field: 'description',
      message: "Required field 'description' is missing.",
      severity: 'error',
    });
  } else {
    if (/[\r\n]/.test(fm.description)) {
      errors.push({
        field: 'description',
        message: 'description must be one line (no newlines).',
        severity: 'error',
      });
    }
    const cap = opts.strict ? MAX_DESCRIPTION_LENGTH_STRICT : MAX_DESCRIPTION_LENGTH;
    if (fm.description.length > cap) {
      errors.push({
        field: 'description',
        message: `description exceeds ${cap} chars (${fm.description.length}).`,
        severity: 'error',
      });
    }
  }

  // version
  if (fm.version !== undefined && fm.version !== '' && !SEMVER_RE.test(fm.version)) {
    warnings.push({
      field: 'version',
      message: `version '${fm.version}' is not semver-like.`,
      severity: 'warning',
    });
  }

  // tags
  if (fm.tags) {
    if (fm.tags.length > MAX_TAG_COUNT) {
      errors.push({
        field: 'tags',
        message: `tags has ${fm.tags.length} items (max ${MAX_TAG_COUNT}).`,
        severity: 'error',
      });
    }
    for (const t of fm.tags) {
      if (typeof t !== 'string' || t.length > 32) {
        errors.push({
          field: 'tags',
          message: `tag must be string <=32 chars (got '${String(t)}').`,
          severity: 'error',
        });
      }
    }
  }

  // examples
  if (fm.examples) {
    for (let i = 0; i < fm.examples.length; i++) {
      const ex = fm.examples[i];
      if (typeof ex.input !== 'string' || typeof ex.output !== 'string') {
        errors.push({
          field: `examples[${i}]`,
          message: 'each example needs string input and output.',
          severity: 'error',
        });
      }
    }
  }

  // allowed/forbidden tools
  if (fm.allowed_tools) {
    for (const t of fm.allowed_tools) {
      if (typeof t !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(t)) {
        errors.push({
          field: 'allowed_tools',
          message: `tool name '${String(t)}' invalid.`,
          severity: 'error',
        });
      }
    }
  }
  if (fm.forbidden_tools) {
    for (const t of fm.forbidden_tools) {
      if (typeof t !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(t)) {
        errors.push({
          field: 'forbidden_tools',
          message: `tool name '${String(t)}' invalid.`,
          severity: 'error',
        });
      }
    }
  }
  if (fm.allowed_tools && fm.forbidden_tools) {
    const overlap = fm.allowed_tools.filter((t) => fm.forbidden_tools?.includes(t));
    if (overlap.length) {
      errors.push({
        field: 'allowed_tools',
        message: `tools listed in both allowed and forbidden: ${overlap.join(', ')}`,
        severity: 'error',
      });
    }
  }

  // trust
  if (fm.trust !== undefined && !KNOWN_TRUST.includes(fm.trust)) {
    errors.push({
      field: 'trust',
      message: `trust must be one of ${KNOWN_TRUST.join('|')} (got '${fm.trust}').`,
      severity: 'error',
    });
  }
  if (fm.created_by !== undefined && !KNOWN_CREATED_BY.includes(fm.created_by)) {
    errors.push({
      field: 'created_by',
      message: `created_by must be one of ${KNOWN_CREATED_BY.join('|')} (got '${fm.created_by}').`,
      severity: 'error',
    });
  }

  // when_to_use
  if (fm.when_to_use !== undefined && fm.when_to_use.length > 4000) {
    warnings.push({
      field: 'when_to_use',
      message: `when_to_use is ${fm.when_to_use.length} chars (>4000); consider trimming.`,
      severity: 'warning',
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function serializeFrontmatter(fm: SkillFrontmatter, body: string): string {
  const lines: string[] = ['---'];
  const writeScalar = (k: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'string') {
      if (/[:#\[\]\n]/.test(v) || v.trim() !== v) {
        lines.push(`${k}: "${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`${k}: ${v}`);
      }
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  };
  const writeArray = (k: string, arr: unknown[]) => {
    if (!arr.length) return;
    const flow = `[${arr
      .map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v)))
      .join(', ')}]`;
    lines.push(`${k}: ${flow}`);
  };
  const writeBlockScalar = (k: string, v: string) => {
    if (!v.includes('\n')) {
      writeScalar(k, v);
      return;
    }
    lines.push(`${k}: |`);
    for (const ln of v.split('\n')) lines.push(`  ${ln}`);
  };

  writeScalar('name', fm.name);
  writeScalar('description', fm.description);
  if (fm.version) writeScalar('version', fm.version);
  if (fm.category) writeScalar('category', fm.category);
  if (fm.platforms?.length) writeArray('platforms', fm.platforms);
  if (fm.tags?.length) writeArray('tags', fm.tags);
  if (fm.relatedSkills?.length) writeArray('relatedSkills', fm.relatedSkills);
  if (fm.allowed_tools?.length) writeArray('allowed_tools', fm.allowed_tools);
  if (fm.forbidden_tools?.length) writeArray('forbidden_tools', fm.forbidden_tools);
  if (fm.trust) writeScalar('trust', fm.trust);
  if (fm.created_by) writeScalar('created_by', fm.created_by);
  if (fm.when_to_use) writeBlockScalar('when_to_use', fm.when_to_use);
  if (fm.examples?.length) {
    lines.push('examples:');
    for (const ex of fm.examples) {
      lines.push(`  - input: ${JSON.stringify(ex.input)}`);
      lines.push(`    output: ${JSON.stringify(ex.output)}`);
    }
  }
  if (fm.created_at) writeScalar('created_at', fm.created_at);
  if (fm.updated_at) writeScalar('updated_at', fm.updated_at);
  if (fm.content_hash) writeScalar('content_hash', fm.content_hash);
  if (fm.use_count !== undefined) writeScalar('use_count', fm.use_count);
  if (fm.last_used_at) writeScalar('last_used_at', fm.last_used_at);
  if (fm.createdAt) writeScalar('createdAt', fm.createdAt);
  if (fm.updatedAt) writeScalar('updatedAt', fm.updatedAt);
  if (fm.config?.length) {
    lines.push('config:');
    for (const c of fm.config) {
      lines.push(`  - key: ${c.key}`);
      lines.push(`    description: ${JSON.stringify(c.description)}`);
      if (c.default !== undefined) lines.push(`    default: ${JSON.stringify(c.default)}`);
      if (c.prompt !== undefined) lines.push(`    prompt: ${JSON.stringify(c.prompt)}`);
    }
  }

  lines.push('---');
  // Note: only ONE \n between closing --- and body so that when the file is
  // re-parsed the body matches exactly (no leading newline). This is critical
  // for content_hash round-trips.
  return lines.join('\n') + '\n' + body.replace(/^\n+/, '');
}
