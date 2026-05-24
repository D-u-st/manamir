import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  randomVector,
  bind,
  unbind,
  bundle,
  cosine,
  HRRMemory
} from '../src/memory/hrr';

describe('hrr — primitives', () => {
  test('randomVector produces a unit-norm Float32Array of the right dim', () => {
    const v = randomVector(512);
    assert.ok(v instanceof Float32Array);
    assert.strictEqual(v.length, 512);

    let sumSq = 0;
    for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
    const norm = Math.sqrt(sumSq);
    assert.ok(Math.abs(norm - 1) < 1e-4, `expected unit norm, got ${norm}`);
  });

  test('cosine of a vector with itself is ~1', () => {
    const v = randomVector(256);
    assert.ok(Math.abs(cosine(v, v) - 1) < 1e-4);
  });

  test('cosine of two independent random vectors is small', () => {
    const a = randomVector(512);
    const b = randomVector(512);
    // For dim=512 random unit vectors, |cos| << 1 with very high probability.
    assert.ok(Math.abs(cosine(a, b)) < 0.2);
  });

  test('bind then unbind recovers the original well above noise floor', () => {
    // For i.i.d. Gaussian unit vectors of dim n, single bind/unbind gives
    // expected cosine ~ 1/sqrt(2) ≈ 0.707 (Plate 1995). The high-recovery
    // (>0.9) regime requires unitary (whitened) vectors, which needs FFT.
    // We verify the recovered vector is comfortably the closest match by
    // averaging across trials to suppress per-trial variance.
    const trials = 8;
    let sumSim = 0;
    for (let t = 0; t < trials; t++) {
      const a = randomVector(512);
      const b = randomVector(512);
      const c = bind(a, b);
      const recovered = unbind(c, b);
      sumSim += cosine(recovered, a);
    }
    const avg = sumSim / trials;
    // Theory predicts ~0.707; require well above the noise floor.
    assert.ok(avg > 0.5, `expected average cosine > 0.5, got ${avg}`);
  });

  test('bind/unbind cleanup recovers correct filler from a 3-fact codebook', () => {
    // The realistic HRR use case: even though raw unbind is noisy (~0.7),
    // the codebook nearest-neighbor cleanup recovers the right filler.
    const role = randomVector(512);
    const right = randomVector(512);
    const decoy1 = randomVector(512);
    const decoy2 = randomVector(512);

    const c = bind(role, right);
    const recovered = unbind(c, role);

    const simRight = cosine(recovered, right);
    const simD1 = cosine(recovered, decoy1);
    const simD2 = cosine(recovered, decoy2);

    assert.ok(simRight > simD1 && simRight > simD2,
      `right=${simRight} d1=${simD1} d2=${simD2}`);
  });

  test('bundle is element-wise sum then normalized', () => {
    const a = randomVector(64);
    const b = randomVector(64);
    const c = randomVector(64);
    const sum = bundle(a, b, c);

    // Each input should still have a positive cosine with the bundle.
    assert.ok(cosine(sum, a) > 0);
    assert.ok(cosine(sum, b) > 0);
    assert.ok(cosine(sum, c) > 0);

    // Bundle should be unit norm.
    let sq = 0;
    for (let i = 0; i < sum.length; i++) sq += sum[i] * sum[i];
    assert.ok(Math.abs(Math.sqrt(sq) - 1) < 1e-4);
  });

  test('bind and unbind throw on dim mismatch', () => {
    const a = randomVector(32);
    const b = randomVector(64);
    assert.throws(() => bind(a, b), /dim mismatch/);
    assert.throws(() => unbind(a, b), /dim mismatch/);
  });
});

describe('hrr — HRRMemory storage', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hrr-test-'));
  });

  after(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('bundle of 3 facts: query each role recovers correct filler', () => {
    const mem = new HRRMemory({ dim: 512, storePath: join(tmpDir, 'facts') });

    const label = mem.store([
      { role: 'name', filler: 'xiaoming' },
      { role: 'age', filler: 'twelve' },
      { role: 'city', filler: 'shanghai' }
    ], 'person1');

    assert.strictEqual(label, 'person1');

    const nameHit = mem.query('person1', 'name', 1);
    assert.strictEqual(nameHit.length, 1);
    assert.strictEqual(nameHit[0].name, 'xiaoming');

    const ageHit = mem.query('person1', 'age', 1);
    assert.strictEqual(ageHit[0].name, 'twelve');

    const cityHit = mem.query('person1', 'city', 1);
    assert.strictEqual(cityHit[0].name, 'shanghai');
  });

  test('contradiction detection: store cat name = mimi, query with luna flags conflict', () => {
    const mem = new HRRMemory({ dim: 512, storePath: join(tmpDir, 'cat') });

    mem.store([{ role: 'cat-name', filler: 'mimi' }], 'cat-fact');

    // Make sure 'luna' exists in the symbol table so the proposed-sim
    // comparison is meaningful.
    mem.getOrCreateSymbol('luna');

    const conflict = mem.detectContradiction('cat-name', 'luna', 'cat-fact');
    assert.strictEqual(conflict.conflict, true);
    assert.strictEqual(conflict.existing, 'mimi');

    // Reaffirming the same filler must not flag.
    const same = mem.detectContradiction('cat-name', 'mimi', 'cat-fact');
    assert.strictEqual(same.conflict, false);
  });

  test('getOrCreateSymbol returns the same vector on repeated calls', () => {
    const mem = new HRRMemory({ dim: 256, storePath: join(tmpDir, 'symbols') });
    const v1 = mem.getOrCreateSymbol('foo');
    const v2 = mem.getOrCreateSymbol('foo');
    assert.strictEqual(v1, v2);
  });

  test('save then load round-trips symbols and bundles', async () => {
    const path = join(tmpDir, 'persist');

    const m1 = new HRRMemory({ dim: 128, storePath: path });
    m1.store([
      { role: 'color', filler: 'red' },
      { role: 'shape', filler: 'square' }
    ], 'thing1');
    await m1.save();

    const m2 = new HRRMemory({ dim: 128, storePath: path });
    const hit = m2.query('thing1', 'color', 1);
    assert.strictEqual(hit.length, 1);
    assert.strictEqual(hit[0].name, 'red');
  });

  test('store auto-generates a label when none is given', () => {
    const mem = new HRRMemory({ dim: 128, storePath: join(tmpDir, 'auto') });
    const label = mem.store([{ role: 'k', filler: 'v' }]);
    assert.ok(typeof label === 'string' && label.length > 0);
    const hit = mem.query(label, 'k', 1);
    assert.strictEqual(hit[0].name, 'v');
  });

  test('query on unknown symbol/role returns empty array', () => {
    const mem = new HRRMemory({ dim: 128, storePath: join(tmpDir, 'empty') });
    assert.deepStrictEqual(mem.query('nope', 'role', 1), []);

    mem.store([{ role: 'real', filler: 'value' }], 'lbl');
    assert.deepStrictEqual(mem.query('lbl', 'unknownRole', 1), []);
  });
});
