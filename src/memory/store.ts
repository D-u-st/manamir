// File-based memory store (v2.1)
// Each memory = one .md file with YAML frontmatter
// data/memory/MEMORY.md = index listing all memories

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { log } from '../utils/logger';
import type { Memory, MemoryType, MemoryConfig } from './types';
import { freshnessNoteForMemory } from './freshness';

export class MemoryStore {
  private dataDir: string;
  private indexPath: string;
  // In-process cache of all parsed memories. SelfReview's injectSelfReviewsForTask
  // calls search() per keyword (often 30+ for a long Chinese prompt with bigram
  // shingles), and each search() previously triggered a full readdirSync +
  // parseFrontmatter sweep. With OCR persisting hundreds of memories, that's
  // O(K·M·fileIO) per turn — measurable lag in the daemon. Cache invalidates
  // on save/delete; assumes single-process ownership of the directory.
  private cache: Memory[] | null = null;

  constructor(private config: MemoryConfig) {
    this.dataDir = resolve(config.dataDir);
    this.indexPath = join(this.dataDir, 'MEMORY.md');

    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    // Create index if it doesn't exist
    if (!existsSync(this.indexPath)) {
      writeFileSync(this.indexPath, '# Memory Index\n', 'utf-8');
    }
  }

  /** Drop the in-memory cache. Call when the directory may have been mutated
   *  outside this process, or in tests between fixtures.
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Save a memory: write .md file + update index.
   */
  save(memory: Memory): void {
    const filename = this.toFilename(memory.name);
    const filepath = join(this.dataDir, filename);

    // Build .md file with YAML frontmatter
    const frontmatter = [
      '---',
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
      `createdAt: ${memory.createdAt}`,
      `updatedAt: ${memory.updatedAt}`,
      '---',
      '',
      memory.content
    ].join('\n');

    writeFileSync(filepath, frontmatter, 'utf-8');
    this.cache = null; // invalidate on write
    this.updateIndex();

    log.info('MemoryStore: saved', { name: memory.name, type: memory.type });
  }

  /**
   * Load all memories, optionally filtered by type. Cached in process; cache
   * is invalidated on save() / delete().
   */
  load(type?: MemoryType): Memory[] {
    if (this.cache === null) {
      if (!existsSync(this.dataDir)) {
        this.cache = [];
      } else {
        const files = readdirSync(this.dataDir)
          .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
        const memories: Memory[] = [];
        for (const file of files) {
          const memory = this.parseMemoryFile(join(this.dataDir, file));
          if (memory) memories.push(memory);
        }
        memories.sort((a, b) => b.updatedAt - a.updatedAt);
        this.cache = memories;
      }
    }
    if (!type) return this.cache;
    return this.cache.filter((m) => m.type === type);
  }

  /**
   * Search memories by keyword match on name + description.
   */
  search(query: string): Memory[] {
    const queryLower = query.toLowerCase();
    const all = this.load();

    return all.filter(m =>
      m.name.toLowerCase().includes(queryLower) ||
      m.description.toLowerCase().includes(queryLower) ||
      m.content.toLowerCase().includes(queryLower)
    );
  }

  /**
   * Delete a memory by name.
   */
  delete(name: string): boolean {
    const filename = this.toFilename(name);
    const filepath = join(this.dataDir, filename);

    if (!existsSync(filepath)) {
      log.warn('MemoryStore: memory not found for deletion', { name });
      return false;
    }

    unlinkSync(filepath);
    this.cache = null; // invalidate on delete
    this.updateIndex();

    log.info('MemoryStore: deleted', { name });
    return true;
  }

  /**
   * Get a single memory by name.
   */
  get(name: string): Memory | null {
    const filename = this.toFilename(name);
    const filepath = join(this.dataDir, filename);

    if (!existsSync(filepath)) return null;
    return this.parseMemoryFile(filepath);
  }

  /**
   * Format memories for injection into system prompt.
   * Returns the N most recent memories formatted as markdown.
   */
  formatForPrompt(maxCount?: number): string {
    const limit = maxCount ?? this.config.maxMemoriesInPrompt;
    const memories = this.load().slice(0, limit);

    if (memories.length === 0) return '';

    const lines = ['# Persistent Memory'];

    for (const mem of memories) {
      // RFC-004: inject staleness note before stale memories
      const freshness = freshnessNoteForMemory(mem);
      if (freshness) {
        lines.push(`\n${freshness.trimEnd()}`);
      }
      lines.push(`\n## [${mem.type}] ${mem.name}`);
      lines.push(`_${mem.description}_`);
      lines.push(mem.content);
    }

    return lines.join('\n');
  }

  // --- Internal helpers ---

  private toFilename(name: string): string {
    // Sanitize name to a safe filename
    return name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.md';
  }

  private parseMemoryFile(filepath: string): Memory | null {
    try {
      const raw = readFileSync(filepath, 'utf-8');
      return this.parseFrontmatter(raw);
    } catch (err) {
      log.error('MemoryStore: failed to parse', { filepath, error: String(err) });
      return null;
    }
  }

  private parseFrontmatter(raw: string): Memory | null {
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fmMatch) return null;

    const frontmatter = fmMatch[1];
    const content = fmMatch[2].trim();

    const getValue = (key: string): string => {
      const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
      return match ? match[1].trim() : '';
    };

    const name = getValue('name');
    const description = getValue('description');
    const type = getValue('type') as MemoryType;

    if (!name || !type) return null;

    return {
      name,
      description,
      type,
      content,
      createdAt: Number(getValue('createdAt')) || Date.now(),
      updatedAt: Number(getValue('updatedAt')) || Date.now()
    };
  }

  private updateIndex(): void {
    const memories = this.load();
    const lines = ['# Memory Index', ''];

    for (const mem of memories) {
      const filename = this.toFilename(mem.name);
      lines.push(`- [${mem.name}](${filename}) — ${mem.description}`);
    }

    writeFileSync(this.indexPath, lines.join('\n') + '\n', 'utf-8');
  }
}
