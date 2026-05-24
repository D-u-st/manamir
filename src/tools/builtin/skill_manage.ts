// skill_manage: agent-facing tool for creating, editing, patching, deleting skills
// and managing supporting files. Integrates with the new content scanner (severity-aware,
// trust-matrix-aware) AND the legacy guard (file/dir scanner). Hash-protected save: refuses
// to overwrite a SKILL.md whose disk content_hash differs from the stored one (i.e. user
// has edited since last AI write) unless force=true.

import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { buildTool } from '../build-tool';
import type { ToolDefinition } from '../types';
import {
  computeSkillDir,
  loadSkill,
  saveSkillProtected,
  deleteSkill,
  validateSkillFilePath,
  writeSupportingFile,
  removeSupportingFile,
  resolveSkillTarget,
} from '../../skills/store';
import { coerceFrontmatter, parseSkillMarkdown, validateFrontmatter } from '../../skills/frontmatter';
import { scanSkill, shouldAllowInstall, formatScanReport } from '../../skills/guard';
import { scanSkillContent, formatSecurityReport } from '../../skills/scanner';
import { invalidateCache } from '../../skills/registry';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SKILL_CONTENT_CHARS,
  MAX_SKILL_FILE_BYTES,
  VALID_NAME_RE,
  type CreatedBy,
  type Skill,
  type SkillFrontmatter,
  type Trust,
} from '../../skills/types';
import { atomicWrite } from '../../utils/atomic-write';

type Action = 'create' | 'edit' | 'patch' | 'delete' | 'write_file' | 'remove_file';

function validateName(name: string): string | null {
  if (!name) return 'Skill name is required.';
  if (name.length > MAX_NAME_LENGTH) return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`;
  if (!VALID_NAME_RE.test(name)) {
    return `Invalid skill name '${name}'. Use lowercase letters, numbers, hyphens, dots, underscores; start with letter or digit.`;
  }
  return null;
}

function validateCategory(category: string | undefined): string | null {
  if (!category) return null;
  if (category.includes('/') || category.includes('\\'))
    return `Invalid category '${category}'. Single directory name only.`;
  if (category.length > MAX_NAME_LENGTH)
    return `Category exceeds ${MAX_NAME_LENGTH} characters.`;
  if (!VALID_NAME_RE.test(category)) return `Invalid category '${category}'.`;
  return null;
}

function validateFullContent(
  content: string
): { ok: true; fm: SkillFrontmatter; body: string } | { ok: false; error: string } {
  if (!content.trim()) return { ok: false, error: 'Content cannot be empty.' };
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return { ok: false, error: `SKILL.md exceeds ${MAX_SKILL_CONTENT_CHARS} chars. Split into supporting files.` };
  }
  const parsed = parseSkillMarkdown(content);
  if (!parsed) {
    return { ok: false, error: "SKILL.md must start with '---' frontmatter and close with '---'." };
  }
  const fm = coerceFrontmatter(parsed.data);
  const validation = validateFrontmatter(fm);
  if (!validation.ok) {
    const msg = validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    return { ok: false, error: `Frontmatter validation failed: ${msg}` };
  }
  if (fm.description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.` };
  }
  if (!parsed.body.trim()) return { ok: false, error: 'SKILL.md needs a body after the frontmatter.' };
  return { ok: true, fm, body: parsed.body };
}

/**
 * Run BOTH scanners:
 *   - new content scanner (trust-matrix aware) for the SKILL.md body
 *   - legacy guard (file/dir scanner) for supporting files / structure
 */
async function fullSecurityScan(
  skillDir: string,
  bodyContent: string,
  trust: Trust,
  createdBy: CreatedBy,
  force: boolean
): Promise<string | null> {
  // 1) New content scanner
  const contentReport = scanSkillContent(bodyContent, { trust, createdBy, force });
  if (contentReport.blocked) {
    return `Content scan blocked this skill:\n${formatSecurityReport(contentReport)}`;
  }
  // 2) Legacy file/dir scanner
  const dirSource = createdBy === 'agent' ? 'agent-created' : 'community';
  const guardResult = scanSkill(skillDir, dirSource);
  const { allowed } = shouldAllowInstall(guardResult, force);
  if (allowed === false || allowed === null) {
    return `Structural scan blocked this skill:\n${formatScanReport(guardResult)}`;
  }
  return null;
}

async function doCreate(
  name: string,
  content: string,
  category?: string,
  trust: Trust = 'agent',
  createdBy: CreatedBy = 'agent',
  force = false
): Promise<object> {
  const nameErr = validateName(name);
  if (nameErr) return { success: false, error: nameErr };
  const catErr = validateCategory(category);
  if (catErr) return { success: false, error: catErr };
  const v = validateFullContent(content);
  if (!v.ok) return { success: false, error: v.error };
  if (v.fm.name !== name) {
    return {
      success: false,
      error: `Frontmatter name '${v.fm.name}' must match tool 'name' parameter '${name}'.`,
    };
  }
  if (loadSkill(name)) return { success: false, error: `Skill '${name}' already exists.` };

  const dir = computeSkillDir(name, category);
  v.fm.trust = trust;
  v.fm.created_by = createdBy;

  const skill: Skill = {
    frontmatter: v.fm,
    body: v.body,
    directoryPath: dir,
  };
  const saved = await saveSkillProtected(skill, { force: true /* new file */ });
  if (!saved.ok) {
    return { success: false, error: saved.reason ?? 'save failed' };
  }

  const scanErr = await fullSecurityScan(dir, v.body, trust, createdBy, force);
  if (scanErr) {
    rmSync(dir, { recursive: true, force: true });
    invalidateCache();
    return { success: false, error: scanErr };
  }

  invalidateCache();
  return {
    success: true,
    message: `Skill '${name}' created.`,
    path: dir,
    trust,
    created_by: createdBy,
    hint: `Add supporting files via skill_manage(action='write_file', name='${name}', file_path='references/...', file_content='...')`,
  };
}

async function doEdit(
  name: string,
  content: string,
  trust: Trust | undefined,
  createdBy: CreatedBy | undefined,
  force = false
): Promise<object> {
  const v = validateFullContent(content);
  if (!v.ok) return { success: false, error: v.error };
  const existing = loadSkill(name);
  if (!existing) return { success: false, error: `Skill '${name}' not found.` };

  const mdPath = join(existing.directoryPath, 'SKILL.md');
  const backup = existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : null;

  const effectiveTrust = trust ?? existing.frontmatter.trust ?? 'user';
  const effectiveCreatedBy = createdBy ?? existing.frontmatter.created_by ?? 'user';

  const updated: Skill = {
    frontmatter: {
      ...v.fm,
      trust: effectiveTrust,
      created_by: effectiveCreatedBy,
      created_at: existing.frontmatter.created_at,
      createdAt: existing.frontmatter.createdAt,
    },
    body: v.body,
    directoryPath: existing.directoryPath,
  };

  const saved = await saveSkillProtected(updated, { force });
  if (!saved.ok) {
    return {
      success: false,
      error: saved.reason ?? 'save blocked by hash protection',
      diff: saved.diff,
      expected_hash: saved.expectedHash,
      actual_hash: saved.conflictHash,
    };
  }

  const scanErr = await fullSecurityScan(
    existing.directoryPath,
    v.body,
    effectiveTrust,
    effectiveCreatedBy,
    force
  );
  if (scanErr) {
    if (backup !== null) await atomicWrite(mdPath, backup);
    invalidateCache(name);
    return { success: false, error: scanErr };
  }

  invalidateCache(name);
  return { success: true, message: `Skill '${name}' updated.`, path: existing.directoryPath };
}

async function doPatch(
  name: string,
  oldString: string,
  newString: string,
  filePath?: string,
  replaceAll = false,
  force = false
): Promise<object> {
  if (!oldString) return { success: false, error: 'old_string is required for patch.' };
  if (newString === undefined || newString === null) {
    return { success: false, error: 'new_string is required (use empty string to delete).' };
  }
  const existing = loadSkill(name);
  if (!existing) return { success: false, error: `Skill '${name}' not found.` };

  let targetPath: string;
  if (filePath) {
    const err = validateSkillFilePath(filePath);
    if (err) return { success: false, error: err };
    const resolved = resolveSkillTarget(existing.directoryPath, filePath);
    if (!resolved) return { success: false, error: 'Resolved path escapes skill directory.' };
    targetPath = resolved;
  } else {
    targetPath = join(existing.directoryPath, 'SKILL.md');
  }

  if (!existsSync(targetPath))
    return { success: false, error: `File not found: ${filePath ?? 'SKILL.md'}` };
  const content = readFileSync(targetPath, 'utf-8');
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    return {
      success: false,
      error: `old_string not found in ${filePath ?? 'SKILL.md'}.`,
      file_preview: content.slice(0, 500) + (content.length > 500 ? '...' : ''),
    };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      success: false,
      error: `old_string matched ${occurrences} times. Provide more context or set replace_all=true.`,
    };
  }

  const newContent = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);

  if (newContent.length > MAX_SKILL_CONTENT_CHARS) {
    return { success: false, error: `Result exceeds ${MAX_SKILL_CONTENT_CHARS} chars.` };
  }
  if (!filePath) {
    const v = validateFullContent(newContent);
    if (!v.ok) return { success: false, error: `Patch would break SKILL.md: ${v.error}` };
  }

  await atomicWrite(targetPath, newContent);

  const trust: Trust = existing.frontmatter.trust ?? 'user';
  const createdBy: CreatedBy = existing.frontmatter.created_by ?? 'user';
  const bodyForScan = filePath ? newContent : (validateFullContent(newContent) as { body: string }).body;
  const scanErr = await fullSecurityScan(existing.directoryPath, bodyForScan, trust, createdBy, force);
  if (scanErr) {
    await atomicWrite(targetPath, content);
    invalidateCache(name);
    return { success: false, error: scanErr };
  }

  invalidateCache(name);
  const count = replaceAll ? occurrences : 1;
  return {
    success: true,
    message: `Patched ${filePath ?? 'SKILL.md'} in '${name}' (${count} replacement${count > 1 ? 's' : ''}).`,
  };
}

function doDelete(name: string): object {
  const existing = loadSkill(name);
  if (!existing) return { success: false, error: `Skill '${name}' not found.` };
  const ok = deleteSkill(name);
  invalidateCache(name);
  return ok
    ? { success: true, message: `Skill '${name}' deleted.` }
    : { success: false, error: 'Delete failed.' };
}

async function doWriteFile(
  name: string,
  filePath: string,
  fileContent: string,
  force = false
): Promise<object> {
  const err = validateSkillFilePath(filePath);
  if (err) return { success: false, error: err };
  const bytes = Buffer.byteLength(fileContent, 'utf-8');
  if (bytes > MAX_SKILL_FILE_BYTES) {
    return { success: false, error: `File is ${bytes} bytes (limit ${MAX_SKILL_FILE_BYTES}).` };
  }
  if (fileContent.length > MAX_SKILL_CONTENT_CHARS) {
    return { success: false, error: `File content exceeds ${MAX_SKILL_CONTENT_CHARS} chars.` };
  }
  const existing = loadSkill(name);
  if (!existing) return { success: false, error: `Skill '${name}' not found. Create it first.` };

  const target = resolveSkillTarget(existing.directoryPath, filePath);
  if (!target) return { success: false, error: 'Resolved path escapes skill directory.' };
  const backup = existsSync(target) ? readFileSync(target, 'utf-8') : null;

  const res = await writeSupportingFile(existing.directoryPath, filePath, fileContent);
  if (!res.ok) return { success: false, error: res.error };

  const trust: Trust = existing.frontmatter.trust ?? 'user';
  const createdBy: CreatedBy = existing.frontmatter.created_by ?? 'user';
  const scanErr = await fullSecurityScan(
    existing.directoryPath,
    existing.body,
    trust,
    createdBy,
    force
  );
  if (scanErr) {
    if (backup !== null) await atomicWrite(target, backup);
    else if (existsSync(target)) rmSync(target, { force: true });
    invalidateCache(name);
    return { success: false, error: scanErr };
  }

  invalidateCache(name);
  return { success: true, message: `File '${filePath}' written to skill '${name}'.`, path: target };
}

function doRemoveFile(name: string, filePath: string): object {
  const existing = loadSkill(name);
  if (!existing) return { success: false, error: `Skill '${name}' not found.` };
  const res = removeSupportingFile(existing.directoryPath, filePath);
  invalidateCache(name);
  if (!res.ok) return { success: false, error: res.error };
  return { success: true, message: `File '${filePath}' removed from skill '${name}'.` };
}

export const skillManageTool: ToolDefinition = buildTool({
  name: 'skill_manage',
  description:
    "Create, update, or delete skills. Skills are procedural memory — reusable approaches for recurring tasks. " +
    "Actions: create (new SKILL.md + optional category), patch (old_string/new_string find-replace, preferred for fixes), " +
    "edit (full SKILL.md rewrite — major overhauls), delete, write_file (add references/templates/scripts/assets), remove_file. " +
    "Create when a complex task (5+ tool calls) succeeded or user-corrected approach worked. " +
    "All writes pass through (a) a content scanner with 100+ patterns and (b) the structural scanner. " +
    "Agent-created skills are blocked from saving when high/critical findings appear (use force=true to override). " +
    "Edits are hash-protected: if the on-disk file has been modified outside the agent (content_hash mismatch), the save is refused.",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'edit', 'patch', 'delete', 'write_file', 'remove_file'] },
      name: { type: 'string', description: 'Skill name (lowercase, hyphens/underscores, max 64).' },
      content: { type: 'string', description: 'Full SKILL.md (frontmatter + body). Required for create/edit.' },
      category: { type: 'string', description: 'Optional category for grouping (create only).' },
      old_string: { type: 'string', description: 'Text to find (patch).' },
      new_string: { type: 'string', description: 'Replacement text (patch). Empty string to delete.' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (patch, default false).' },
      file_path: { type: 'string', description: "Supporting file path under references/, templates/, scripts/, or assets/." },
      file_content: { type: 'string', description: 'Content for write_file.' },
      trust: { type: 'string', enum: ['system', 'user', 'agent'], description: 'Trust level (default agent for create).' },
      created_by: { type: 'string', enum: ['system', 'user', 'agent'], description: 'Author class (default agent for create).' },
      force: { type: 'boolean', description: 'Override hash-protection / scanner blocks. Use sparingly.' },
    },
    required: ['action', 'name'],
  },
  readonly: false,
  category: 'system',

  async execute(input) {
    const action = input.action as Action;
    const name = (input.name as string) ?? '';
    const force = Boolean(input.force);
    const trust = input.trust as Trust | undefined;
    const createdBy = input.created_by as CreatedBy | undefined;

    let result: object;
    try {
      switch (action) {
        case 'create':
          if (!input.content) return { content: 'content is required for create.', isError: true };
          result = await doCreate(
            name,
            String(input.content),
            input.category as string | undefined,
            trust ?? 'agent',
            createdBy ?? 'agent',
            force
          );
          break;
        case 'edit':
          if (!input.content) return { content: 'content is required for edit.', isError: true };
          result = await doEdit(name, String(input.content), trust, createdBy, force);
          break;
        case 'patch':
          result = await doPatch(
            name,
            (input.old_string as string) ?? '',
            (input.new_string as string) ?? '',
            input.file_path as string | undefined,
            Boolean(input.replace_all),
            force
          );
          break;
        case 'delete':
          result = doDelete(name);
          break;
        case 'write_file':
          if (!input.file_path) return { content: 'file_path is required for write_file.', isError: true };
          if (input.file_content == null)
            return { content: 'file_content is required for write_file.', isError: true };
          result = await doWriteFile(
            name,
            String(input.file_path),
            String(input.file_content),
            force
          );
          break;
        case 'remove_file':
          if (!input.file_path) return { content: 'file_path is required for remove_file.', isError: true };
          result = doRemoveFile(name, String(input.file_path));
          break;
        default:
          result = { success: false, error: `Unknown action '${action}'.` };
      }
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const isError = !(result as { success?: boolean }).success;
    return { content: JSON.stringify(result), isError };
  },
});
