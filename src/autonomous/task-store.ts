// Persistent task store for the autonomous scheduler.
//
// Why JSONL: append-friendly, recoverable from a partial write because
// each line is parsed independently, and we keep the full audit trail of
// state transitions. We compact on load when the file gets large.
//
// File layout:
//   <dataDir>/tasks.jsonl   — append-only event log
//
// Each line is one of:
//   { v:1, kind:'add',    task:AutoTask }
//   { v:1, kind:'update', id, patch }
//   { v:1, kind:'delete', id }
//
// On load() we replay events into an in-memory Map<id, AutoTask>. When the
// file exceeds COMPACT_THRESHOLD lines we rewrite it with one 'add' per
// surviving task (atomic write via tmp+rename).
//
// Crash recovery: on load(), any task with status='running' is rewritten
// to 'failed' with error="process died mid-task" so the worker doesn't
// double-execute.

import { existsSync, mkdirSync, readFileSync, appendFileSync, statSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic-write';
import { log } from '../utils/logger';
import type { AutoTask, AutoTaskStatus } from './scheduler';

export const TASK_RESULT_MAX_BYTES = 5 * 1024;
const COMPACT_THRESHOLD_LINES = 500;
const STORE_VERSION = 1;

interface AddEvent {
  v: 1;
  kind: 'add';
  task: AutoTask;
}

interface UpdateEvent {
  v: 1;
  kind: 'update';
  id: string;
  patch: Partial<AutoTask>;
}

interface DeleteEvent {
  v: 1;
  kind: 'delete';
  id: string;
}

type StoreEvent = AddEvent | UpdateEvent | DeleteEvent;

export interface TaskStoreOptions {
  /** Directory that will contain tasks.jsonl */
  dataDir: string;
  /** Optional override for the result truncation budget (testing). */
  resultMaxBytes?: number;
  /** Optional override for the line count compaction threshold (testing). */
  compactThresholdLines?: number;
}

/**
 * Truncate a result string to at most maxBytes UTF-8 bytes. Appends a
 * "...[truncated N bytes]" marker so the audit trail remains honest.
 */
export function truncateResult(value: string | null, maxBytes: number): string | null {
  if (value === null) return null;
  const bytes = Buffer.byteLength(value, 'utf-8');
  if (bytes <= maxBytes) return value;
  // Slice progressively until we fit, then append the marker.
  let cut = value;
  while (Buffer.byteLength(cut, 'utf-8') > maxBytes - 32) {
    cut = cut.slice(0, Math.max(1, Math.floor(cut.length * 0.9)));
  }
  return `${cut}...[truncated ${bytes - Buffer.byteLength(cut, 'utf-8')} bytes]`;
}

export class TaskStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly resultMaxBytes: number;
  private readonly compactThreshold: number;
  private tasks = new Map<string, AutoTask>();
  private appendedLines = 0;

  constructor(opts: TaskStoreOptions) {
    this.dataDir = opts.dataDir;
    this.filePath = join(this.dataDir, 'tasks.jsonl');
    this.resultMaxBytes = opts.resultMaxBytes ?? TASK_RESULT_MAX_BYTES;
    this.compactThreshold = opts.compactThresholdLines ?? COMPACT_THRESHOLD_LINES;
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Replay the JSONL log into memory. Tasks with status='running' are
   * rewritten to 'failed' (and the rewrite is persisted) — this is the
   * crash-recovery boundary.
   */
  load(): { restored: number; markedFailed: number } {
    this.tasks.clear();
    this.appendedLines = 0;

    if (!existsSync(this.filePath)) {
      return { restored: 0, markedFailed: 0 };
    }

    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      log.error('TaskStore: failed to read tasks.jsonl', { error: String(err) });
      return { restored: 0, markedFailed: 0 };
    }

    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.appendedLines++;
      let event: StoreEvent;
      try {
        event = JSON.parse(trimmed) as StoreEvent;
      } catch {
        // Skip corrupted line — tolerant by design.
        continue;
      }
      this.applyEvent(event);
    }

    // Crash recovery: anything still 'running' is now stale.
    let markedFailed = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        task.status = 'failed';
        task.error = 'process died mid-task';
        task.completedAt = Date.now();
        markedFailed++;
      }
    }
    if (markedFailed > 0) {
      // Compact so we don't replay the running→failed dance forever.
      this.compact();
      log.warn('TaskStore: marked stale running tasks as failed', { count: markedFailed });
    } else if (this.appendedLines > this.compactThreshold) {
      this.compact();
    }

    return { restored: this.tasks.size, markedFailed };
  }

  /** Persist a brand-new task. */
  recordAdd(task: AutoTask): void {
    const sanitized: AutoTask = {
      ...task,
      result: truncateResult(task.result, this.resultMaxBytes)
    };
    this.tasks.set(sanitized.id, sanitized);
    this.appendEvent({ v: STORE_VERSION, kind: 'add', task: sanitized });
  }

  /** Persist a partial update (status / result / timestamps / error). */
  recordUpdate(id: string, patch: Partial<AutoTask>): void {
    const existing = this.tasks.get(id);
    if (!existing) return;
    const safePatch: Partial<AutoTask> = { ...patch };
    if (safePatch.result !== undefined) {
      safePatch.result = truncateResult(safePatch.result, this.resultMaxBytes);
    }
    Object.assign(existing, safePatch);
    this.appendEvent({ v: STORE_VERSION, kind: 'update', id, patch: safePatch });
  }

  /** Persist a deletion (used by prune). */
  recordDelete(id: string): void {
    if (!this.tasks.delete(id)) return;
    this.appendEvent({ v: STORE_VERSION, kind: 'delete', id });
  }

  /** Read-only access to the in-memory task map. */
  getAll(): AutoTask[] {
    return [...this.tasks.values()];
  }

  /** Lookup by id. */
  get(id: string): AutoTask | undefined {
    return this.tasks.get(id);
  }

  /** Filter by status. */
  byStatus(status: AutoTaskStatus): AutoTask[] {
    return [...this.tasks.values()].filter(t => t.status === status);
  }

  /** Force a compaction (rewrite the JSONL with one add per surviving task). */
  compact(): void {
    const lines: string[] = [];
    for (const task of this.tasks.values()) {
      const evt: AddEvent = { v: STORE_VERSION, kind: 'add', task };
      lines.push(JSON.stringify(evt));
    }
    const body = lines.length > 0 ? lines.join('\n') + '\n' : '';
    atomicWriteSync(this.filePath, body, false);
    this.appendedLines = lines.length;
    log.debug('TaskStore: compacted', { tasks: lines.length });
  }

  /** Return the total bytes currently on disk (0 if file does not exist). */
  fileSize(): number {
    if (!existsSync(this.filePath)) return 0;
    try {
      return statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  // ── internal ─────────────────────────────────────────────────────────────

  private appendEvent(event: StoreEvent): void {
    try {
      appendFileSync(this.filePath, JSON.stringify(event) + '\n', 'utf-8');
      this.appendedLines++;
      if (this.appendedLines > this.compactThreshold) {
        this.compact();
      }
    } catch (err) {
      log.error('TaskStore: failed to append event', {
        kind: event.kind,
        error: String(err)
      });
    }
  }

  private applyEvent(event: StoreEvent): void {
    switch (event.kind) {
      case 'add':
        this.tasks.set(event.task.id, { ...event.task });
        return;
      case 'update': {
        const existing = this.tasks.get(event.id);
        if (existing) Object.assign(existing, event.patch);
        return;
      }
      case 'delete':
        this.tasks.delete(event.id);
        return;
    }
  }
}
