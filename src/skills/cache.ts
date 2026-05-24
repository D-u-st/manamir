// mtime/size-validated cache for SKILL.md parsing.
//
// Each entry keyed by absolute file path. On every lookup, we stat() the file;
// if mtime/size still match, we return the cached parsed body without re-reading.
// This makes auto-discovery cheap on repeated calls.

import { existsSync, statSync } from 'fs';
import type { Source } from './types';

interface CacheRecord<T> {
  mtimeMs: number;
  size: number;
  value: T;
  loadedAt: number;
  source: Source;
}

const cache = new Map<string, CacheRecord<unknown>>();
const MAX_ENTRIES = 256;

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  invalidations: number;
}

const stats: CacheStats = { size: 0, hits: 0, misses: 0, invalidations: 0 };

export function getCached<T>(path: string): T | null {
  const rec = cache.get(path);
  if (!rec) {
    stats.misses++;
    return null;
  }
  if (!existsSync(path)) {
    cache.delete(path);
    stats.invalidations++;
    return null;
  }
  try {
    const st = statSync(path);
    if (st.mtimeMs !== rec.mtimeMs || st.size !== rec.size) {
      cache.delete(path);
      stats.invalidations++;
      stats.misses++;
      return null;
    }
  } catch {
    cache.delete(path);
    stats.invalidations++;
    return null;
  }
  // Touch (LRU)
  cache.delete(path);
  cache.set(path, rec);
  stats.hits++;
  return rec.value as T;
}

export function setCached<T>(path: string, value: T, source: Source = 'user'): void {
  if (!existsSync(path)) return;
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  cache.set(path, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    value,
    loadedAt: Date.now(),
    source,
  });
  // Bound size — drop oldest
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  stats.size = cache.size;
}

export function invalidateCached(path?: string): void {
  if (path) {
    if (cache.delete(path)) stats.invalidations++;
  } else {
    stats.invalidations += cache.size;
    cache.clear();
  }
  stats.size = cache.size;
}

export function getCacheStats(): Readonly<CacheStats> {
  return { ...stats, size: cache.size };
}

export function resetCacheStats(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.invalidations = 0;
}
