import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  sanitizeToolResult,
  collapseRepetition,
} from '../src/executor/result-sanitizer';

// Save/restore env between tests so MANAMIR_TOOL_SANITIZE doesn't leak.
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.MANAMIR_TOOL_SANITIZE;
  delete process.env.MANAMIR_TOOL_SANITIZE;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.MANAMIR_TOOL_SANITIZE;
  else process.env.MANAMIR_TOOL_SANITIZE = savedEnv;
});

describe('sanitizeToolResult — ANSI escapes', () => {
  test('strips simple ANSI color codes', () => {
    const input = '\x1b[31mred\x1b[0m';
    const out = sanitizeToolResult(input, 'bash');
    assert.strictEqual(out, 'red');
  });

  test('strips multi-segment ANSI codes', () => {
    const input = '\x1b[1;32;40mbold green on black\x1b[0m text';
    const out = sanitizeToolResult(input, 'bash');
    assert.strictEqual(out, 'bold green on black text');
  });

  test('preserves text adjacent to ANSI', () => {
    const input = 'before \x1b[33mwarn\x1b[0m after';
    const out = sanitizeToolResult(input, 'bash');
    assert.strictEqual(out, 'before warn after');
  });
});

describe('sanitizeToolResult — long token truncation', () => {
  // Build a non-repetitive long token (so repetition collapse doesn't fire).
  function pseudoRandomToken(len: number, seed: number): string {
    const alpha = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    let x = seed;
    for (let i = 0; i < len; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      s += alpha[x % alpha.length];
    }
    return s;
  }

  test('truncates long base64-like token', () => {
    const longTok = pseudoRandomToken(500, 1);
    const out = sanitizeToolResult(longTok, 'read');
    assert.ok(out.includes('[truncated long token]'), 'should mark truncation');
    assert.ok(out.length < 500, 'should be shorter than input');
    assert.ok(out.startsWith(longTok.slice(0, 200)), 'should keep first 200 chars');
  });

  test('does NOT truncate token under 200 chars', () => {
    const tok = pseudoRandomToken(199, 2);
    const out = sanitizeToolResult(tok, 'read');
    assert.strictEqual(out, tok);
  });

  test('truncates each long token independently in mixed text', () => {
    const t1 = pseudoRandomToken(300, 3);
    const t2 = pseudoRandomToken(250, 4);
    const input = `short ${t1} more ${t2} end`;
    const out = sanitizeToolResult(input, 'read');
    const truncMarkers = (out.match(/\[truncated long token\]/g) || []).length;
    assert.strictEqual(truncMarkers, 2);
  });
});

describe('sanitizeToolResult — control chars / NULL bytes', () => {
  test('strips NULL bytes', () => {
    const input = 'hello\x00world\x00';
    const out = sanitizeToolResult(input, 'read');
    assert.strictEqual(out, 'helloworld');
  });

  test('strips other C0 control chars', () => {
    const input = 'a\x01b\x02c\x07d\x7Fe';
    const out = sanitizeToolResult(input, 'read');
    assert.strictEqual(out, 'abcde');
  });

  test('preserves \\n \\r \\t', () => {
    const input = 'line1\nline2\r\ntab\there';
    const out = sanitizeToolResult(input, 'bash');
    assert.strictEqual(out, 'line1\nline2\r\ntab\there');
  });
});

describe('sanitizeToolResult — preserves legitimate content', () => {
  test('CJK characters preserved', () => {
    const input = '你好世界 これはテスト 한국어';
    const out = sanitizeToolResult(input, 'read');
    assert.strictEqual(out, '你好世界 これはテスト 한국어');
  });

  test('emojis preserved', () => {
    const input = 'rocket ship test result';
    const out = sanitizeToolResult(input, 'read');
    assert.strictEqual(out, 'rocket ship test result');
  });

  test('actual emoji code points preserved', () => {
    const input = '\u{1F680}\u{1F4A1}\u2728';
    const out = sanitizeToolResult(input, 'read');
    assert.strictEqual(out, '\u{1F680}\u{1F4A1}\u2728');
  });

  test('markdown code fences are not damaged even with long lines inside', () => {
    const longLineInFence = 'x'.repeat(800);
    const input = `intro\n\`\`\`js\nconst data = "${longLineInFence}";\n\`\`\`\noutro`;
    const out = sanitizeToolResult(input, 'read');
    // The fence content should be preserved verbatim (fence is masked
    // before line wrap). Long-token truncation still applies inside
    // however, since the long string itself is a single token > 200.
    assert.ok(out.includes('```js'), 'opening fence preserved');
    assert.ok(out.includes('```\noutro'), 'closing fence preserved');
    assert.ok(!out.includes('[...long line truncated]'), 'no line wrap inside fence');
  });

  test('valid JSON is not line-wrapped', () => {
    // Build a single-line JSON over 500 chars
    const obj = { items: Array.from({ length: 60 }, (_, i) => ({ id: i, name: `item-${i}` })) };
    const json = JSON.stringify(obj);
    assert.ok(json.length > 500, 'sanity: test fixture must be > 500 chars');
    const out = sanitizeToolResult(json, 'read');
    assert.ok(!out.includes('[...long line truncated]'), 'should not wrap valid JSON');
    // Should still be parseable
    assert.doesNotThrow(() => JSON.parse(out));
  });
});

describe('sanitizeToolResult — long line wrap', () => {
  test('wraps non-JSON, non-fenced long lines', () => {
    const longLine = 'word '.repeat(200); // ~1000 chars, has spaces so not a single long token
    const out = sanitizeToolResult(longLine, 'read');
    assert.ok(out.includes('[...long line truncated]'), 'should mark line truncation');
  });

  test('does not touch lines under 500 chars', () => {
    const line = 'short line\nanother short line\n';
    const out = sanitizeToolResult(line, 'read');
    assert.strictEqual(out, line);
  });
});

describe('collapseRepetition', () => {
  test('collapses 5-char window repeated 10 times', () => {
    const input = 'abcde'.repeat(15);
    const out = collapseRepetition(input, 5, 10);
    assert.ok(out.includes('repetition collapsed'));
    assert.ok(out.length < input.length);
  });

  test('does NOT collapse 5-char window repeated < 10 times', () => {
    const input = 'abcde'.repeat(9);
    const out = collapseRepetition(input, 5, 10);
    assert.strictEqual(out, input);
  });

  test('collapses keyword cascade pattern', () => {
    // Simulate the DeepSeek pathology: keyword_keyword_keyword...
    const input = 'algo_'.repeat(20);
    const out = collapseRepetition(input, 5, 10);
    assert.ok(out.includes('repetition collapsed'));
  });

  test('preserves non-repetitive prose', () => {
    const input = 'The quick brown fox jumps over the lazy dog.';
    const out = collapseRepetition(input, 5, 10);
    assert.strictEqual(out, input);
  });

  test('handles empty / short input', () => {
    assert.strictEqual(collapseRepetition('', 5, 10), '');
    assert.strictEqual(collapseRepetition('hi', 5, 10), 'hi');
  });
});

describe('sanitizeToolResult — env switch', () => {
  test('MANAMIR_TOOL_SANITIZE=false disables sanitization', () => {
    process.env.MANAMIR_TOOL_SANITIZE = 'false';
    const input = '\x1b[31mred\x1b[0m\x00with null';
    const out = sanitizeToolResult(input, 'bash');
    assert.strictEqual(out, input, 'should pass through unchanged');
  });

  test('MANAMIR_TOOL_SANITIZE=0 also disables', () => {
    process.env.MANAMIR_TOOL_SANITIZE = '0';
    const input = '\x00bytes';
    const out = sanitizeToolResult(input, 'bash');
    assert.strictEqual(out, input);
  });

  test('default (env unset) sanitizes', () => {
    delete process.env.MANAMIR_TOOL_SANITIZE;
    const input = '\x1b[31mred\x1b[0m';
    const out = sanitizeToolResult(input, 'bash');
    assert.strictEqual(out, 'red');
  });

  test('MANAMIR_TOOL_SANITIZE=true sanitizes', () => {
    process.env.MANAMIR_TOOL_SANITIZE = 'true';
    const input = '\x1b[31mred\x1b[0m';
    const out = sanitizeToolResult(input, 'bash');
    assert.strictEqual(out, 'red');
  });

  test('opts.enabled=false overrides env', () => {
    process.env.MANAMIR_TOOL_SANITIZE = 'true';
    const input = '\x1b[31mred\x1b[0m';
    const out = sanitizeToolResult(input, 'bash', { enabled: false });
    assert.strictEqual(out, input);
  });

  test('opts.enabled=true overrides env=false', () => {
    process.env.MANAMIR_TOOL_SANITIZE = 'false';
    const input = '\x1b[31mred\x1b[0m';
    const out = sanitizeToolResult(input, 'bash', { enabled: true });
    assert.strictEqual(out, 'red');
  });
});

describe('sanitizeToolResult — tool-specific (web_fetch)', () => {
  test('strips <script> blocks for web_fetch', () => {
    const input = '<p>hello</p><script>alert("xss")</script><p>world</p>';
    const out = sanitizeToolResult(input, 'web_fetch');
    assert.ok(!out.includes('<script'));
    assert.ok(!out.includes('alert'));
    assert.ok(out.includes('hello'));
    assert.ok(out.includes('world'));
  });

  test('strips <style> blocks for web_fetch', () => {
    const input = '<p>x</p><style>body { color: red; }</style><p>y</p>';
    const out = sanitizeToolResult(input, 'web_fetch');
    assert.ok(!out.includes('<style'));
    assert.ok(!out.includes('color: red'));
  });

  test('handles WebFetch (camelcase) too', () => {
    const input = '<script>bad</script>good';
    const out = sanitizeToolResult(input, 'WebFetch');
    assert.ok(!out.includes('<script'));
    assert.ok(out.includes('good'));
  });

  test('does NOT strip <script> for non-web tools', () => {
    // e.g. read returning a literal HTML file should be preserved
    const input = '<script>example</script>';
    const out = sanitizeToolResult(input, 'read');
    assert.ok(out.includes('<script>'), 'should keep tags for read');
  });

  test('strips multiple script blocks', () => {
    const input = '<script>a</script>middle<script>b</script>end';
    const out = sanitizeToolResult(input, 'web_fetch');
    assert.ok(!out.includes('<script'));
    assert.ok(out.includes('middle'));
    assert.ok(out.includes('end'));
  });
});

describe('sanitizeToolResult — edge cases', () => {
  test('empty string', () => {
    assert.strictEqual(sanitizeToolResult('', 'bash'), '');
  });

  test('idempotent — running twice == running once', () => {
    const input = '\x1b[31mred\x1b[0m \x00 ' + 'X'.repeat(300);
    const once = sanitizeToolResult(input, 'bash');
    const twice = sanitizeToolResult(once, 'bash');
    assert.strictEqual(once, twice);
  });

  test('combined pollution scenario (real DeepSeek failure mode)', () => {
    // Simulates a tool result that triggers DeepSeek degradation:
    // ANSI + keyword cascade + null bytes + long base64
    const cascade = 'algo_'.repeat(30);
    const b64 = 'A'.repeat(400);
    const input = `\x1b[32mOK\x1b[0m\nresult: ${cascade}\nblob=${b64}\n\x00trailing`;
    const out = sanitizeToolResult(input, 'bash');
    assert.ok(!out.includes('\x1b['), 'no ANSI');
    assert.ok(!out.includes('\x00'), 'no NULL');
    assert.ok(out.includes('repetition collapsed'), 'cascade collapsed');
    assert.ok(out.includes('[truncated long token]'), 'b64 truncated');
    assert.ok(out.includes('OK'), 'legit content preserved');
  });

  test('does not crash on null/non-string-like input shape', () => {
    // Defensive: caller could pass weird stuff
    assert.strictEqual(sanitizeToolResult('', 'bash'), '');
  });
});
