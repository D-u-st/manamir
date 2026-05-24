// End-to-end tests for the hrr_remember + hrr_recall tools.
//
// Each test re-inits HRRMemory into a fresh tempdir to avoid cross-test
// pollution and to keep the on-disk store under control.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { initHrrTool } from '../src/tools';
import { hrrRememberTool } from '../src/tools/builtin/hrr-remember';
import { hrrRecallTool } from '../src/tools/builtin/hrr-recall';

interface RememberOutput {
  label: string;
  factsStored: number;
}

interface RecallOutput {
  hits: Array<{ name: string; similarity: number }>;
}

describe('hrr-tools — hrr_remember + hrr_recall', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hrr-tools-test-'));
    initHrrTool({ dim: 512, storePath: join(tmpDir, 'hrr') });
  });

  after(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('hrr_remember with explicit label returns that label and factsStored', async () => {
    const result = await hrrRememberTool.execute({
      label: 'testbundle',
      facts: [
        { role: 'name', filler: 'xiaoming' },
        { role: 'city', filler: 'shanghai' },
      ],
    });

    assert.strictEqual(result.isError, false, `expected success, got: ${result.content}`);

    const parsed = JSON.parse(result.content) as RememberOutput;
    assert.strictEqual(parsed.label, 'testbundle');
    assert.strictEqual(parsed.factsStored, 2);
  });

  test('hrr_recall recovers the bound filler in the top hit', async () => {
    const result = await hrrRecallTool.execute({
      label: 'testbundle',
      role: 'name',
      topK: 3,
    });

    assert.strictEqual(result.isError, false, `expected success, got: ${result.content}`);

    const parsed = JSON.parse(result.content) as RecallOutput;
    assert.ok(Array.isArray(parsed.hits) && parsed.hits.length > 0, 'expected at least one hit');
    assert.strictEqual(parsed.hits[0].name, 'xiaoming',
      `expected top hit to be 'xiaoming', got hits=${JSON.stringify(parsed.hits)}`);

    // Sanity: another role on the same bundle should resolve the right filler too.
    const cityResult = await hrrRecallTool.execute({
      label: 'testbundle',
      role: 'city',
      topK: 1,
    });
    const cityParsed = JSON.parse(cityResult.content) as RecallOutput;
    assert.strictEqual(cityParsed.hits[0].name, 'shanghai');
  });

  test('hrr_remember without label generates a UUID label', async () => {
    const result = await hrrRememberTool.execute({
      facts: [{ role: 'k', filler: 'v' }],
    });

    assert.strictEqual(result.isError, false, `expected success, got: ${result.content}`);

    const parsed = JSON.parse(result.content) as RememberOutput;
    assert.strictEqual(typeof parsed.label, 'string');
    // UUID v4 shape: 8-4-4-4-12 hex chars
    assert.match(parsed.label, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.strictEqual(parsed.factsStored, 1);

    // And the bundle is queryable by the generated label.
    const recall = await hrrRecallTool.execute({ label: parsed.label, role: 'k', topK: 1 });
    const recallParsed = JSON.parse(recall.content) as RecallOutput;
    assert.strictEqual(recallParsed.hits[0].name, 'v');
  });

  test('hrr_remember rejects empty facts array', async () => {
    const result = await hrrRememberTool.execute({ facts: [] });
    assert.strictEqual(result.isError, true);
  });

  test('hrr_recall rejects missing label', async () => {
    const result = await hrrRecallTool.execute({ label: '', role: 'name' });
    assert.strictEqual(result.isError, true);
  });
});
