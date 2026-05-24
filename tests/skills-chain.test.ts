// Chain resolver tests — verify {{skill:other}} expansion, missing-ref handling,
// cycle detection, and depth limit.

import { describe, test } from 'node:test';
import assert from 'node:assert';

import { resolveChain, listSkillRefs } from '../src/skills/chain';
import { MAX_CHAIN_DEPTH } from '../src/skills/types';

describe('listSkillRefs', () => {
  test('finds single ref', () => {
    assert.deepStrictEqual(listSkillRefs('hello {{skill:foo}} world'), ['foo']);
  });

  test('finds multiple refs', () => {
    assert.deepStrictEqual(
      listSkillRefs('{{skill:a}} and {{skill:b}} and {{skill:c}}'),
      ['a', 'b', 'c']
    );
  });

  test('deduplicates', () => {
    assert.deepStrictEqual(
      listSkillRefs('{{skill:a}} {{skill:a}} {{skill:b}}'),
      ['a', 'b']
    );
  });

  test('returns empty for no refs', () => {
    assert.deepStrictEqual(listSkillRefs('plain text with no refs'), []);
  });

  test('does not match malformed', () => {
    assert.deepStrictEqual(listSkillRefs('{skill:foo} {{skill: foo}} {{skill:Foo}}'), []);
    // 'Foo' has uppercase → does not match [a-z0-9]
  });
});

describe('resolveChain', () => {
  test('expands a single reference', () => {
    const loader = (n: string) => (n === 'foo' ? 'foo body' : null);
    const r = resolveChain('hello {{skill:foo}} world', loader);
    assert.strictEqual(r.body, 'hello foo body world');
    assert.deepStrictEqual(r.expandedRefs, ['foo']);
    assert.deepStrictEqual(r.missingRefs, []);
  });

  test('expands chain A -> B -> C', () => {
    const skills: Record<string, string> = {
      a: 'A start {{skill:b}} A end',
      b: 'B start {{skill:c}} B end',
      c: 'C content',
    };
    const r = resolveChain('{{skill:a}}', (n) => skills[n] ?? null);
    assert.match(r.body, /A start B start C content B end A end/);
    assert.deepStrictEqual(r.expandedRefs.sort(), ['a', 'b', 'c']);
  });

  test('detects cycle A -> A', () => {
    const skills: Record<string, string> = { a: 'A {{skill:a}} loop' };
    const r = resolveChain('{{skill:a}}', (n) => skills[n] ?? null, 'a');
    // The root passed in already-visiting set prevents re-entry
    assert.ok(r.cyclesDetected.length > 0 || r.body.includes('chain cycle'));
  });

  test('detects cycle A -> B -> A', () => {
    const skills: Record<string, string> = {
      a: 'A {{skill:b}}',
      b: 'B {{skill:a}}',
    };
    const r = resolveChain('{{skill:a}}', (n) => skills[n] ?? null);
    // a is expanded once, then b is expanded, then b tries to expand a (which is visiting)
    assert.ok(r.cyclesDetected.includes('a'), `expected cycle for a, got ${r.cyclesDetected}`);
  });

  test('reports missing refs without erroring', () => {
    const r = resolveChain('hello {{skill:nope}} world', () => null);
    assert.deepStrictEqual(r.missingRefs, ['nope']);
    // Literal tag preserved in output
    assert.match(r.body, /\{\{skill:nope\}\}/);
  });

  test('respects MAX_CHAIN_DEPTH', () => {
    // Build a chain longer than max depth
    const skills: Record<string, string> = {};
    for (let i = 0; i < MAX_CHAIN_DEPTH + 5; i++) {
      const next = i + 1;
      skills[`s${i}`] = `[${i}]{{skill:s${next}}}`;
    }
    skills[`s${MAX_CHAIN_DEPTH + 5}`] = 'TERMINAL';
    const r = resolveChain('{{skill:s0}}', (n) => skills[n] ?? null);
    // We expect at least depthExceeded set or body still contains an unresolved tag
    const hasUnresolved = /\{\{skill:s\d+\}\}/.test(r.body);
    assert.ok(
      hasUnresolved || r.depthExceeded.length > 0,
      `expected depth limit to halt expansion; body=${r.body}`
    );
  });

  test('passes through body unchanged when no refs', () => {
    const r = resolveChain('plain content', () => null);
    assert.strictEqual(r.body, 'plain content');
    assert.deepStrictEqual(r.expandedRefs, []);
  });

  test('multiple refs in same body all expand', () => {
    const skills: Record<string, string> = {
      a: 'A',
      b: 'B',
      c: 'C',
    };
    const r = resolveChain('{{skill:a}}-{{skill:b}}-{{skill:c}}', (n) => skills[n] ?? null);
    assert.strictEqual(r.body, 'A-B-C');
    assert.deepStrictEqual(r.expandedRefs.sort(), ['a', 'b', 'c']);
  });

  test('mixed missing and present refs', () => {
    const r = resolveChain(
      '{{skill:found}} and {{skill:lost}}',
      (n) => (n === 'found' ? 'F!' : null)
    );
    assert.match(r.body, /F! and \{\{skill:lost\}\}/);
    assert.deepStrictEqual(r.expandedRefs, ['found']);
    assert.deepStrictEqual(r.missingRefs, ['lost']);
  });

  test('rootName parameter is treated as visiting (prevents self-reference)', () => {
    const skills: Record<string, string> = { foo: 'foo body {{skill:foo}}' };
    const r = resolveChain(skills.foo, (n) => skills[n] ?? null, 'foo');
    assert.ok(
      r.cyclesDetected.includes('foo') || r.body.includes('chain cycle'),
      'self-ref to root should be flagged as cycle'
    );
  });
});
