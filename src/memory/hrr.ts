// Holographic Reduced Representations (HRR) algebraic memory module
// Vector-based compositional memory: bind/unbind/bundle on Float32Array vectors.
// Supports queries like "小明的猫的名字" by chained unbind on bound symbol vectors.
//
// References:
//   - Plate (1995), "Holographic Reduced Representations"
//   - HRR primitives: circular convolution (bind), circular correlation (unbind),
//     element-wise sum + normalize (bundle), cosine similarity for cleanup.
//
// MVP constraints: pure-JS naive O(n^2) convolution, no FFT, no Bun APIs.

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { writeFile, rename } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, resolve, dirname } from 'path';
import { log } from '../utils/logger';

// ---------------------------------------------------------------------------
// HRR primitives (pure functions)
// ---------------------------------------------------------------------------

/**
 * Generate a random vector of the given dimension whose components are
 * Gaussian-distributed (mean 0) and whose overall L2 norm is 1.
 *
 * Uses the Box-Muller transform on Math.random() for the Gaussian samples.
 */
export function randomVector(dim: number): Float32Array {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`randomVector: dim must be a positive integer, got ${dim}`);
  }

  const out = new Float32Array(dim);

  // Box-Muller produces samples in pairs.
  for (let i = 0; i < dim; i += 2) {
    // Avoid log(0) by clamping u1 strictly above 0.
    let u1 = Math.random();
    if (u1 < 1e-12) u1 = 1e-12;
    const u2 = Math.random();

    const mag = Math.sqrt(-2.0 * Math.log(u1));
    const z0 = mag * Math.cos(2.0 * Math.PI * u2);
    const z1 = mag * Math.sin(2.0 * Math.PI * u2);

    out[i] = z0;
    if (i + 1 < dim) out[i + 1] = z1;
  }

  return normalize(out);
}

/**
 * In-place L2 normalization. Returns the same array for chaining.
 * If the vector is the zero vector, it is left untouched.
 */
function normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  if (sumSq <= 0) return v;
  const inv = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < v.length; i++) v[i] = v[i] * inv;
  return v;
}

/**
 * Circular convolution (HRR binding).
 *   c[i] = sum_{k=0..n-1} a[k] * b[(i - k) mod n]
 *
 * Naive O(n^2) implementation — fine for dim ~ 512.
 */
export function bind(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length !== b.length) {
    throw new Error(`bind: dim mismatch (${a.length} vs ${b.length})`);
  }
  const n = a.length;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < n; k++) {
      // ((i - k) % n + n) % n keeps the index non-negative.
      const idx = ((i - k) % n + n) % n;
      acc += a[k] * b[idx];
    }
    c[i] = acc;
  }
  return c;
}

/**
 * Circular correlation (HRR unbinding) — approximate inverse of bind.
 *
 * Defined so that if c = bind(a, b), then unbind(c, b) ≈ a:
 *   out[j] = sum_{k=0..n-1} b[k] * c[(k + j) mod n]
 *
 * Derivation: with bind c[i] = sum_k a[k] * b[(i-k) mod n], substitute
 * into out[j] and the b-autocorrelation peaks at j = k, leaving a[j].
 *
 * Result is L2-normalized for cleanup.
 */
export function unbind(c: Float32Array, b: Float32Array): Float32Array {
  if (c.length !== b.length) {
    throw new Error(`unbind: dim mismatch (${c.length} vs ${b.length})`);
  }
  const n = c.length;
  const out = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    let acc = 0;
    for (let k = 0; k < n; k++) {
      const idx = (k + j) % n;
      acc += b[k] * c[idx];
    }
    out[j] = acc;
  }
  return normalize(out);
}

/**
 * Bundling (superposition): element-wise sum then L2 normalize.
 * Throws if no vectors are provided or if dims disagree.
 */
export function bundle(...vecs: Float32Array[]): Float32Array {
  if (vecs.length === 0) {
    throw new Error('bundle: at least one vector required');
  }
  const n = vecs[0].length;
  const out = new Float32Array(n);
  for (let v = 0; v < vecs.length; v++) {
    const cur = vecs[v];
    if (cur.length !== n) {
      throw new Error(`bundle: dim mismatch at index ${v} (${cur.length} vs ${n})`);
    }
    for (let i = 0; i < n; i++) out[i] += cur[i];
  }
  return normalize(out);
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 if either vector has zero norm.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------
// HRRMemory storage layer
// ---------------------------------------------------------------------------

export interface HRRMemoryOptions {
  /** Vector dimensionality (default 512). */
  dim?: number;
  /** Directory in which to persist hrr-store.json (default ./data/hrr). */
  storePath?: string;
}

export interface HRRQueryHit {
  name: string;
  similarity: number;
}

export interface HRRContradiction {
  conflict: boolean;
  existing?: string;
}

interface PersistedShape {
  dim: number;
  symbols: Record<string, number[]>;
  bundles: Record<string, number[]>;
}

const DEFAULT_DIM = 512;
const DEFAULT_STORE_PATH = './data/hrr';
const STORE_FILENAME = 'hrr-store.json';

/**
 * HRRMemory — interns symbol vectors, binds role/filler pairs, bundles
 * facts under a label, and supports compositional queries via unbind.
 */
export class HRRMemory {
  readonly dim: number;
  readonly storePath: string;

  private symbols: Map<string, Float32Array> = new Map();
  private bundles: Map<string, Float32Array> = new Map();

  constructor(opts: HRRMemoryOptions = {}) {
    this.dim = opts.dim ?? DEFAULT_DIM;
    this.storePath = resolve(opts.storePath ?? DEFAULT_STORE_PATH);

    if (!existsSync(this.storePath)) {
      mkdirSync(this.storePath, { recursive: true });
    }

    // Best-effort load on construction; failures leave us with empty state.
    try {
      this.load();
    } catch (err) {
      log.warn('HRRMemory: load on construct failed (starting empty)', {
        error: String(err)
      });
    }
  }

  /**
   * Return the symbol vector for `name`, creating + persisting a new random
   * one if it does not yet exist. Vectors are cached by name.
   */
  getOrCreateSymbol(name: string): Float32Array {
    const existing = this.symbols.get(name);
    if (existing) return existing;

    const fresh = randomVector(this.dim);
    this.symbols.set(name, fresh);
    log.debug('HRRMemory: minted symbol', { name, dim: this.dim });
    return fresh;
  }

  /**
   * Bind each role/filler pair, bundle them all, and store under `label`.
   * If `label` is omitted, a UUID is generated. Returns the label used.
   * Persists the updated store to disk asynchronously (fire-and-forget,
   * any error is logged).
   */
  store(facts: Array<{ role: string; filler: string }>, label?: string): string {
    if (!Array.isArray(facts) || facts.length === 0) {
      throw new Error('HRRMemory.store: facts must be a non-empty array');
    }

    const bound: Float32Array[] = [];
    for (const fact of facts) {
      if (!fact.role || !fact.filler) {
        throw new Error('HRRMemory.store: each fact must have role and filler');
      }
      const roleVec = this.getOrCreateSymbol(fact.role);
      const fillerVec = this.getOrCreateSymbol(fact.filler);
      bound.push(bind(roleVec, fillerVec));
    }

    const composite = bundle(...bound);
    const finalLabel = label ?? randomUUID();
    this.bundles.set(finalLabel, composite);

    // Make sure the label itself is also a known symbol — useful when
    // chaining queries that treat labels as fillers in higher-order facts.
    this.getOrCreateSymbol(finalLabel);

    log.info('HRRMemory: stored bundle', {
      label: finalLabel,
      facts: facts.length
    });

    // Note: we do NOT auto-persist here. Callers should `await save()` after
    // a batch of stores. This keeps the API synchronous and avoids unhandled
    // promise rejections during process shutdown / test teardown.
    return finalLabel;
  }

  /**
   * Unbind `roleName` from the bundle stored under `symbolName` and return
   * the topK known symbols ranked by cosine similarity (highest first).
   *
   * If the symbol/bundle is not found, returns an empty array.
   */
  query(symbolName: string, roleName: string, topK: number = 3): HRRQueryHit[] {
    const bundleVec = this.bundles.get(symbolName);
    if (!bundleVec) {
      log.debug('HRRMemory.query: no bundle for symbol', { symbolName });
      return [];
    }

    const roleVec = this.symbols.get(roleName);
    if (!roleVec) {
      log.debug('HRRMemory.query: unknown role', { roleName });
      return [];
    }

    const noisy = unbind(bundleVec, roleVec);

    const scored: HRRQueryHit[] = [];
    for (const [name, vec] of this.symbols) {
      // Skip the role itself — it can never be the answer to its own query.
      if (name === roleName) continue;
      // Skip bundle labels — their random vectors weren't bound as fillers,
      // so matching against them is noise that pollutes cleanup.
      if (this.bundles.has(name)) continue;
      scored.push({ name, similarity: cosine(noisy, vec) });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    const k = topK > 0 ? topK : 1;
    return scored.slice(0, k);
  }

  /**
   * Detect whether storing (role, filler) under `label` would conflict with
   * an existing binding. Conflict iff:
   *   - the bundle already binds `role` to some "winner"
   *   - the winner is NOT `filler`
   *   - the winner's similarity is comfortably above the proposed filler's
   *     similarity (delta > 0.05) AND above an absolute floor (0.2).
   *
   * Returns { conflict: false } if no bundle exists for the label or if
   * the proposed filler matches the winner.
   */
  detectContradiction(
    role: string,
    filler: string,
    label: string
  ): HRRContradiction {
    const bundleVec = this.bundles.get(label);
    if (!bundleVec) return { conflict: false };

    const roleVec = this.symbols.get(role);
    if (!roleVec) return { conflict: false };

    const noisy = unbind(bundleVec, roleVec);

    let bestName: string | null = null;
    let bestSim = -Infinity;
    for (const [name, vec] of this.symbols) {
      if (name === role) continue;
      // Skip bundle labels — same reason as in query().
      if (this.bundles.has(name)) continue;
      const sim = cosine(noisy, vec);
      if (sim > bestSim) {
        bestSim = sim;
        bestName = name;
      }
    }

    if (bestName === null) return { conflict: false };
    if (bestName === filler) return { conflict: false };

    const proposedVec = this.symbols.get(filler);
    const proposedSim = proposedVec ? cosine(noisy, proposedVec) : -Infinity;

    const ABS_FLOOR = 0.2;
    const DELTA = 0.05;

    if (bestSim >= ABS_FLOOR && bestSim - proposedSim > DELTA) {
      return { conflict: true, existing: bestName };
    }
    return { conflict: false };
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Atomically write the symbol table + labeled bundles to
   * `${storePath}/hrr-store.json`. Writes to a `.tmp` sibling first then
   * renames into place.
   */
  async save(): Promise<void> {
    const filepath = join(this.storePath, STORE_FILENAME);
    const tmpPath = filepath + '.tmp';

    const symbols: Record<string, number[]> = {};
    for (const [name, vec] of this.symbols) {
      symbols[name] = Array.from(vec);
    }
    const bundles: Record<string, number[]> = {};
    for (const [name, vec] of this.bundles) {
      bundles[name] = Array.from(vec);
    }

    const payload: PersistedShape = { dim: this.dim, symbols, bundles };

    if (!existsSync(dirname(filepath))) {
      mkdirSync(dirname(filepath), { recursive: true });
    }

    await writeFile(tmpPath, JSON.stringify(payload), 'utf-8');
    await rename(tmpPath, filepath);

    log.debug('HRRMemory: saved', {
      filepath,
      symbols: this.symbols.size,
      bundles: this.bundles.size
    });
  }

  /**
   * Synchronously load symbol table + bundles from disk if the file exists.
   * If the persisted dim differs from this instance's dim, the load is
   * aborted with a warning (mismatched-dim vectors are unusable).
   */
  load(): void {
    const filepath = join(this.storePath, STORE_FILENAME);
    if (!existsSync(filepath)) return;

    const raw = readFileSync(filepath, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedShape;

    if (parsed.dim !== this.dim) {
      log.warn('HRRMemory.load: dim mismatch, ignoring persisted store', {
        persistedDim: parsed.dim,
        currentDim: this.dim
      });
      return;
    }

    this.symbols.clear();
    this.bundles.clear();

    for (const [name, arr] of Object.entries(parsed.symbols ?? {})) {
      this.symbols.set(name, Float32Array.from(arr));
    }
    for (const [name, arr] of Object.entries(parsed.bundles ?? {})) {
      this.bundles.set(name, Float32Array.from(arr));
    }

    log.info('HRRMemory: loaded', {
      filepath,
      symbols: this.symbols.size,
      bundles: this.bundles.size
    });
  }
}
