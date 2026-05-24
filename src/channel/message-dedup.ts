// Discord message deduplication
// Discord WebSocket reconnects (RESUME) may replay messages we've already
// processed, leading to duplicate responses. We dedupe by Discord message ID.
//
// Persists to JSONL on disk for crash recovery. Old entries (> windowMs)
// are pruned during load and during isDuplicate calls.

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';
import { atomicWrite } from '../utils/atomic-write';
import { log } from '../utils/logger';

export interface DedupEntry {
  messageId: string;
  channelId: string;
  userId: string;
  receivedAt: number;
  contentHash: string; // sha1 of content for sanity check
}

export interface MessageDedupOptions {
  /** How long to remember a message in ms (default: 1 hour) */
  windowMs?: number;
  /** Hard cap on memory; oldest evicted when over (default: 5000) */
  maxEntries?: number;
  /** JSONL file for crash recovery (default: ./data/dedup.jsonl) */
  persistPath?: string;
  /** Auto-persist cadence in ms (default: 60_000). Set 0 to disable auto-flush. */
  flushIntervalMs?: number;
}

interface DedupMessage {
  id: string;
  channelId: string;
  userId: string;
  content: string;
}

const DEFAULT_WINDOW_MS = 3_600_000; // 1 hour
const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_PERSIST_PATH = './data/dedup.jsonl';
const DEFAULT_FLUSH_INTERVAL_MS = 60_000;

export class MessageDedup {
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly persistPath: string;
  private readonly flushIntervalMs: number;

  // Map preserves insertion order — convenient for LRU-by-receivedAt eviction.
  // Key: messageId. Value: DedupEntry.
  private entries: Map<string, DedupEntry> = new Map();

  private totalSeen = 0;
  private duplicatesRejected = 0;
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MessageDedupOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.persistPath = options.persistPath ?? DEFAULT_PERSIST_PATH;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  /**
   * Check if a message has been seen in the configured window.
   * Returns true if duplicate (caller should skip), false if new (caller should process).
   * Records the message internally on a 'new' verdict.
   */
  isDuplicate(message: DedupMessage): boolean {
    this.totalSeen++;

    // Opportunistic prune of stale entries on each call (cheap when nothing
    // is stale; bounded by maxEntries).
    this.pruneStale();

    const existing = this.entries.get(message.id);
    if (existing) {
      const computed = hashContent(message.content);
      if (existing.contentHash !== computed) {
        log.warn('MessageDedup: content mismatch on duplicate id', {
          messageId: message.id,
          existingHash: existing.contentHash,
          incomingHash: computed
        });
      }
      this.duplicatesRejected++;
      return true;
    }

    this.recordInternal(message);
    return false;
  }

  /** Mark explicitly without checking (e.g. on re-emit) */
  record(message: DedupMessage): void {
    this.recordInternal(message);
  }

  /** Stats for /status display */
  stats(): { totalSeen: number; duplicatesRejected: number; windowSize: number } {
    return {
      totalSeen: this.totalSeen,
      duplicatesRejected: this.duplicatesRejected,
      windowSize: this.entries.size
    };
  }

  /**
   * Persist current state to disk (JSONL) using atomic write.
   * Snapshots the live entries map; safe under concurrent isDuplicate calls
   * because Node is single-threaded and we serialize before the await.
   */
  async flush(): Promise<void> {
    // Snapshot synchronously to avoid races with mutators between awaits.
    this.pruneStale();
    const snapshot: DedupEntry[] = Array.from(this.entries.values());
    const lines = snapshot.map((e) => JSON.stringify(e)).join('\n');
    const content = lines.length > 0 ? lines + '\n' : '';
    await atomicWrite(this.persistPath, content);
    this.dirty = false;
  }

  /**
   * Load existing state from disk on startup. Stale entries (older than
   * windowMs) are pruned. Malformed lines are skipped with a warning.
   */
  async load(): Promise<void> {
    if (!existsSync(this.persistPath)) {
      // Ensure directory exists for later flush().
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      return;
    }

    let raw: string;
    try {
      raw = readFileSync(this.persistPath, 'utf-8');
    } catch (err) {
      log.warn('MessageDedup: failed to read persist file', {
        path: this.persistPath,
        error: String(err)
      });
      return;
    }

    const now = Date.now();
    const lines = raw.split('\n');
    let loaded = 0;
    let skipped = 0;
    let pruned = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Partial / corrupt line — skip silently rather than abort load.
        skipped++;
        continue;
      }

      const entry = parseEntry(parsed);
      if (entry === null) {
        skipped++;
        continue;
      }

      if (now - entry.receivedAt > this.windowMs) {
        pruned++;
        continue;
      }

      this.entries.set(entry.messageId, entry);
      loaded++;
    }

    // Enforce maxEntries on load too, in case the file grew beyond it offline.
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }

    if (skipped > 0 || pruned > 0) {
      log.info('MessageDedup: loaded with prune', {
        loaded,
        skipped,
        pruned,
        path: this.persistPath
      });
    } else if (loaded > 0) {
      log.info('MessageDedup: loaded', { loaded, path: this.persistPath });
    }
  }

  /**
   * Start the auto-flush interval. Called by the host adapter after load().
   * Idempotent — safe to call twice.
   */
  startAutoFlush(): void {
    if (this.flushTimer !== null) return;
    if (this.flushIntervalMs <= 0) return;

    this.flushTimer = setInterval(() => {
      if (!this.dirty) return;
      this.flush().catch((err) => {
        log.warn('MessageDedup: auto-flush failed', { error: String(err) });
      });
    }, this.flushIntervalMs);

    // Don't keep the event loop alive solely for the flush timer.
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  /** Stop the auto-flush interval. */
  stopAutoFlush(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // --- internals ---

  private recordInternal(message: DedupMessage): void {
    const now = Date.now();
    const entry: DedupEntry = {
      messageId: message.id,
      channelId: message.channelId,
      userId: message.userId,
      receivedAt: now,
      contentHash: hashContent(message.content)
    };

    // Re-record: delete first so insertion order reflects newest position.
    if (this.entries.has(message.id)) {
      this.entries.delete(message.id);
    }
    this.entries.set(message.id, entry);
    this.dirty = true;

    // LRU eviction by insertion order (which we keep aligned with receivedAt
    // by deleting + re-adding above).
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  private pruneStale(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    // Iterate in insertion order; stop at the first non-stale entry.
    // Map preserves insertion order, so older entries are at the front
    // (we re-insert on record, so receivedAt is monotonic-ish).
    for (const [key, entry] of this.entries) {
      if (entry.receivedAt > cutoff) break;
      this.entries.delete(key);
      this.dirty = true;
    }
  }
}

// --- helpers ---

function hashContent(content: string): string {
  // sha1 over UTF-8 bytes. Empty string hashes to a deterministic constant.
  return createHash('sha1').update(content, 'utf-8').digest('hex');
}

function parseEntry(value: unknown): DedupEntry | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.messageId !== 'string') return null;
  if (typeof v.channelId !== 'string') return null;
  if (typeof v.userId !== 'string') return null;
  if (typeof v.receivedAt !== 'number') return null;
  if (typeof v.contentHash !== 'string') return null;
  return {
    messageId: v.messageId,
    channelId: v.channelId,
    userId: v.userId,
    receivedAt: v.receivedAt,
    contentHash: v.contentHash
  };
}
