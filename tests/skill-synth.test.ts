// Tests for the SkillSynth-style skill extractor.
//
// Strategy:
// - Point SKILLS_DIR at a fresh tempdir per test via setSkillsDir.
// - Stub global.fetch with a controllable mock that records calls.
// - Drive proposeSkillFromTrace directly for the "pure" paths.
// - Drive wireSkillSynthExtractor + hooks.emit for end-to-end save.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { hooks } from '../src/hooks';
import { setSkillsDir, listSkills, saveSkill, computeSkillDir } from '../src/skills/store';
import {
  proposeSkillFromTrace,
  wireSkillSynthExtractor,
  resetSkillSynthHealth,
  type ToolCallSummary,
  type SkillSynthConfig,
} from '../src/skills/skill-synth';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let originalFetch: typeof fetch;
let fetchCalls: FetchCall[] = [];
let nextResponse: { ok: boolean; status: number; json: unknown } = {
  ok: true,
  status: 200,
  json: {},
};
let tempDir: string;

const baseConfig: SkillSynthConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.example.com',
  model: 'test-model',
  minToolCalls: 3,
  category: 'auto-extracted',
};

function installFetchStub(): void {
  originalFetch = global.fetch;
  fetchCalls = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    return {
      ok: nextResponse.ok,
      status: nextResponse.status,
      json: async () => nextResponse.json,
    } as Response;
  }) as typeof fetch;
}

function restoreFetch(): void {
  global.fetch = originalFetch;
}

function modelEnvelope(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

function makeTrace(n: number, allOk = true): ToolCallSummary[] {
  const out: ToolCallSummary[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      tool: ['Read', 'Grep', 'Edit'][i % 3],
      args: { path: `/tmp/file-${i}.ts` },
      ok: allOk || i !== n - 1,
    });
  }
  return out;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skillSynth-test-'));
  setSkillsDir(tempDir);
  installFetchStub();
  resetSkillSynthHealth();
  hooks.clear();
});

afterEach(() => {
  restoreFetch();
  hooks.clear();
  if (existsSync(tempDir)) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore — Windows occasionally locks files
    }
  }
});

describe('proposeSkillFromTrace', () => {
  test('returns a proposal when model says extract=true', async () => {
    nextResponse = {
      ok: true,
      status: 200,
      json: modelEnvelope(
        JSON.stringify({
          extract: true,
          name: 'refactor-imports',
          description: 'Reorder imports across a TS module',
          body: '## When to use\nWhen imports drift.\n## Steps\n1. Read\n2. Grep\n3. Edit',
          tags: ['typescript', 'imports'],
        })
      ),
    };

    const result = await proposeSkillFromTrace(
      { prompt: 'Sort imports', toolCalls: makeTrace(4) },
      baseConfig
    );

    assert.ok(result, 'expected a proposal');
    assert.strictEqual(result!.name, 'refactor-imports');
    assert.strictEqual(result!.category, 'auto-extracted');
    assert.deepStrictEqual(result!.tags, ['typescript', 'imports']);
    assert.strictEqual(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.endsWith('/v1/chat/completions'));
  });

  test('returns null when model says extract=false', async () => {
    nextResponse = {
      ok: true,
      status: 200,
      json: modelEnvelope(JSON.stringify({ extract: false })),
    };

    const result = await proposeSkillFromTrace(
      { prompt: 'Do the thing', toolCalls: makeTrace(4) },
      baseConfig
    );

    assert.strictEqual(result, null);
    assert.strictEqual(fetchCalls.length, 1);
  });

  test('rejects invalid kebab-case name', async () => {
    nextResponse = {
      ok: true,
      status: 200,
      json: modelEnvelope(
        JSON.stringify({
          extract: true,
          name: 'BadName!!',
          description: 'desc',
          body: '## When to use\n...\n## Steps\n1. ...',
        })
      ),
    };

    const result = await proposeSkillFromTrace(
      { prompt: 'p', toolCalls: makeTrace(4) },
      baseConfig
    );

    assert.strictEqual(result, null);
  });

  test('rejects names with path traversal', async () => {
    nextResponse = {
      ok: true,
      status: 200,
      json: modelEnvelope(
        JSON.stringify({
          extract: true,
          name: '../escape',
          description: 'd',
          body: 'b',
        })
      ),
    };

    const result = await proposeSkillFromTrace(
      { prompt: 'p', toolCalls: makeTrace(4) },
      baseConfig
    );

    assert.strictEqual(result, null);
  });

  test('skips API call when below minToolCalls threshold', async () => {
    const result = await proposeSkillFromTrace(
      { prompt: 'tiny', toolCalls: makeTrace(2) },
      baseConfig
    );
    assert.strictEqual(result, null);
    assert.strictEqual(fetchCalls.length, 0, 'no fetch should happen for short traces');
  });

  test('skips API call when any tool call failed', async () => {
    const trace = makeTrace(4);
    trace[2].ok = false;
    const result = await proposeSkillFromTrace(
      { prompt: 'p', toolCalls: trace },
      baseConfig
    );
    assert.strictEqual(result, null);
    assert.strictEqual(fetchCalls.length, 0);
  });
});

describe('wireSkillSynthExtractor (end-to-end via hooks)', () => {
  test('saves a new skill on a successful extraction', async () => {
    nextResponse = {
      ok: true,
      status: 200,
      json: modelEnvelope(
        JSON.stringify({
          extract: true,
          name: 'sequence-skill',
          description: 'A multi-step pattern for X',
          body: '## When to use\nWhen X happens.\n## Steps\n1. Read\n2. Grep\n3. Edit',
          tags: ['demo'],
        })
      ),
    };

    wireSkillSynthExtractor(baseConfig);

    await hooks.emit('executor:complete', {
      prompt: 'Please do the multi-step thing',
      toolCalls: makeTrace(4),
    });

    // Wait for the setTimeout(...,0) + async chain to settle
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(fetchCalls.length, 1, 'one fetch call expected');

    const skills = listSkills();
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].name, 'sequence-skill');
    assert.strictEqual(skills[0].category, 'auto-extracted');

    const expectedDir = computeSkillDir('sequence-skill', 'auto-extracted');
    assert.ok(existsSync(join(expectedDir, 'SKILL.md')), 'SKILL.md should exist on disk');
  });

  test('does not call API when toolCalls is below threshold', async () => {
    wireSkillSynthExtractor(baseConfig);

    await hooks.emit('executor:complete', {
      prompt: 'short',
      toolCalls: makeTrace(2),
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(listSkills().length, 0);
  });

  test('does not call API when any tool call failed', async () => {
    wireSkillSynthExtractor(baseConfig);

    const trace = makeTrace(4);
    trace[1].ok = false;

    await hooks.emit('executor:complete', {
      prompt: 'failed flow',
      toolCalls: trace,
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(listSkills().length, 0);
  });

  test('skips extraction when a skill with the same name already exists', async () => {
    // Pre-seed a skill that will collide
    const now = Date.now();
    await saveSkill({
      frontmatter: {
        name: 'sequence-skill',
        description: 'Existing skill that already covers this',
        category: 'auto-extracted',
        createdAt: now,
        updatedAt: now,
      },
      body: '## Existing\nbody',
      directoryPath: computeSkillDir('sequence-skill', 'auto-extracted'),
    });
    assert.strictEqual(listSkills().length, 1);

    nextResponse = {
      ok: true,
      status: 200,
      json: modelEnvelope(
        JSON.stringify({
          extract: true,
          name: 'sequence-skill',
          description: 'A duplicate proposal',
          body: '## When to use\n...\n## Steps\n1. ...',
        })
      ),
    };

    wireSkillSynthExtractor(baseConfig);

    await hooks.emit('executor:complete', {
      prompt: 'Please do the multi-step thing',
      toolCalls: makeTrace(4),
    });

    await new Promise((r) => setTimeout(r, 50));

    // Still exactly one skill — original, not overwritten.
    const skills = listSkills();
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].description, 'Existing skill that already covers this');
  });

  test('skips extraction on fuzzy description match with existing skill', async () => {
    const now = Date.now();
    await saveSkill({
      frontmatter: {
        name: 'pre-existing',
        description: 'Reorder imports across a TS module to keep grouping consistent',
        category: 'auto-extracted',
        createdAt: now,
        updatedAt: now,
      },
      body: '## body',
      directoryPath: computeSkillDir('pre-existing', 'auto-extracted'),
    });

    nextResponse = {
      ok: true,
      status: 200,
      json: modelEnvelope(
        JSON.stringify({
          extract: true,
          name: 'fresh-name',
          description: 'Reorder imports across a TS module to keep grouping consistent for X',
          body: '## When to use\n...\n## Steps\n1. ...',
        })
      ),
    };

    wireSkillSynthExtractor(baseConfig);

    await hooks.emit('executor:complete', {
      prompt: 'Sort imports',
      toolCalls: makeTrace(4),
    });

    await new Promise((r) => setTimeout(r, 50));

    const skills = listSkills();
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].name, 'pre-existing');
  });
});
