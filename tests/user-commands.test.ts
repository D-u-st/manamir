// Tests for src/cli/user-commands.ts
//
// Strategy: write fixture .md files into a tmp project dir and call
// loadUserCommands(cwd) so we never touch the user's real ~/.manamir.

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseCommandFile,
  applyArgs,
  splitArgs,
  loadUserCommands,
  renderUserCommand,
  getUserCommandPaths,
  BUILTIN_COMMANDS,
  MAX_COMMAND_BYTES,
  VALID_NAME_RE,
} from '../src/cli/user-commands';

async function makeTmpProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'manamir-cmd-'));
  await mkdir(join(root, '.manamir', 'commands'), { recursive: true });
  return root;
}

describe('parseCommandFile', () => {
  test('parses standard frontmatter + body', () => {
    const out = parseCommandFile(
      ['---', 'name: review', 'description: Review the diff', '---', 'Body line 1', 'Body line 2', ''].join('\n')
    );
    assert.ok(out);
    assert.equal(out!.name, 'review');
    assert.equal(out!.description, 'Review the diff');
    assert.equal(out!.body, 'Body line 1\nBody line 2');
  });

  test('falls back to filename when frontmatter omits name', () => {
    const out = parseCommandFile('Just a body, no frontmatter.', 'mycmd');
    assert.ok(out);
    assert.equal(out!.name, 'mycmd');
    assert.equal(out!.description, '');
    assert.equal(out!.body, 'Just a body, no frontmatter.');
  });

  test('returns null when neither frontmatter nor fallback', () => {
    const out = parseCommandFile('No name anywhere.');
    assert.equal(out, null);
  });

  test('handles CRLF line endings', () => {
    const text = ['---', 'name: crlf', 'description: cr', '---', 'body'].join('\r\n');
    const out = parseCommandFile(text);
    assert.ok(out);
    assert.equal(out!.name, 'crlf');
    assert.equal(out!.body, 'body');
  });

  test('strips quoted frontmatter values', () => {
    const out = parseCommandFile(['---', 'name: q', 'description: "has: colon, and quotes"', '---', 'b'].join('\n'));
    assert.ok(out);
    assert.equal(out!.description, 'has: colon, and quotes');
  });

  test('lower-cases name from frontmatter', () => {
    const out = parseCommandFile(['---', 'name: Review', '---', 'b'].join('\n'));
    assert.ok(out);
    assert.equal(out!.name, 'review');
  });

  test('ignores frontmatter comments and blank lines', () => {
    const out = parseCommandFile(
      ['---', '# this is a comment', '', 'name: ok', '# another', 'description: x', '---', 'body'].join('\n')
    );
    assert.ok(out);
    assert.equal(out!.name, 'ok');
    assert.equal(out!.description, 'x');
  });
});

describe('applyArgs / splitArgs', () => {
  test('{{args}} replaced with full joined args', () => {
    assert.equal(applyArgs('Run on {{args}} now', ['src/a.ts', 'src/b.ts']), 'Run on src/a.ts src/b.ts now');
  });

  test('{{args}} replaced with empty string when no args', () => {
    assert.equal(applyArgs('Run on {{args}}!', []), 'Run on !');
  });

  test('positional {{arg1}} {{arg2}} work', () => {
    assert.equal(applyArgs('first={{arg1}} second={{arg2}} third={{arg3}}', ['a', 'b']), 'first=a second=b third=');
  });

  test('whitespace inside placeholder allowed', () => {
    assert.equal(applyArgs('{{ args }} and {{ arg1 }}', ['x']), 'x and x');
  });

  test('user-supplied placeholder text is NOT recursively substituted', () => {
    assert.equal(applyArgs('{{args}}', ['{{args}}']), '{{args}}');
  });

  test('splitArgs collapses runs of whitespace, drops empties', () => {
    assert.deepEqual(splitArgs('  a   b\tc  '), ['a', 'b', 'c']);
    assert.deepEqual(splitArgs(''), []);
  });
});

describe('loadUserCommands — directory scan', () => {
  test('does not throw when no .manamir/commands exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manamir-empty-'));
    try {
      const res = loadUserCommands(root);
      // Nothing to load (we set HOME via env? no — we just rely on the fact
      // the test runner's home dir likely has no ~/.manamir/commands).
      // We only assert the function did not throw and returned a Map.
      assert.ok(res.commands instanceof Map);
      assert.ok(Array.isArray(res.warnings));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('loads a single .md command from project dir', async () => {
    const root = await makeTmpProject();
    try {
      await writeFile(
        join(root, '.manamir', 'commands', 'review.md'),
        ['---', 'name: review', 'description: Review the diff', '---', 'Please review {{args}}.'].join('\n')
      );
      const res = loadUserCommands(root);
      const cmd = res.commands.get('review');
      assert.ok(cmd, `expected review to load; warnings=${res.warnings.join('|')}`);
      assert.equal(cmd!.description, 'Review the diff');
      assert.equal(cmd!.scope, 'project');
      assert.equal(cmd!.body, 'Please review {{args}}.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects file shadowing built-in command', async () => {
    const root = await makeTmpProject();
    try {
      await writeFile(
        join(root, '.manamir', 'commands', 'exit.md'),
        ['---', 'name: exit', 'description: nope', '---', 'body'].join('\n')
      );
      const res = loadUserCommands(root);
      assert.equal(res.commands.has('exit'), false);
      assert.ok(res.warnings.some((w) => w.includes('built-in')), `warnings=${res.warnings.join('|')}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects every built-in name', () => {
    // Sanity: the regex must accept all built-in names so the only reason
    // they're rejected is the BUILTIN_COMMANDS guard.
    for (const n of BUILTIN_COMMANDS) {
      assert.ok(VALID_NAME_RE.test(n), `built-in ${n} should match VALID_NAME_RE`);
    }
  });

  test('rejects invalid command names', async () => {
    const root = await makeTmpProject();
    try {
      // Frontmatter name takes priority — try a few variants. Note: parser
      // lowercases names, so `My-Command` is valid (becomes `my-command`),
      // but underscores, leading digit, and spaces are not.
      await writeFile(
        join(root, '.manamir', 'commands', 'bad1.md'),
        ['---', 'name: my_command', '---', 'b'].join('\n')
      );
      await writeFile(
        join(root, '.manamir', 'commands', 'bad2.md'),
        ['---', 'name: 1foo', '---', 'b'].join('\n')
      );
      await writeFile(
        join(root, '.manamir', 'commands', 'bad3.md'),
        ['---', 'name: foo bar', '---', 'b'].join('\n')
      );
      const res = loadUserCommands(root);
      assert.equal(res.commands.size, 0);
      assert.equal(res.warnings.filter((w) => w.includes('invalid command name')).length, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('accepts mixed-case frontmatter names by lowercasing', async () => {
    const root = await makeTmpProject();
    try {
      await writeFile(
        join(root, '.manamir', 'commands', 'mc.md'),
        ['---', 'name: My-Command', '---', 'b'].join('\n')
      );
      const res = loadUserCommands(root);
      assert.ok(res.commands.has('my-command'), `warnings=${res.warnings.join('|')}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects oversized files', async () => {
    const root = await makeTmpProject();
    try {
      const big = ['---', 'name: big', '---', ''].join('\n') + 'x'.repeat(MAX_COMMAND_BYTES + 100);
      await writeFile(join(root, '.manamir', 'commands', 'big.md'), big);
      const res = loadUserCommands(root);
      assert.equal(res.commands.has('big'), false);
      assert.ok(res.warnings.some((w) => w.includes('too large')), `warnings=${res.warnings.join('|')}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ignores non-.md files', async () => {
    const root = await makeTmpProject();
    try {
      await writeFile(join(root, '.manamir', 'commands', 'readme.txt'), 'not a command');
      await writeFile(join(root, '.manamir', 'commands', 'config.json'), '{}');
      const res = loadUserCommands(root);
      assert.equal(res.commands.size, 0);
      assert.equal(res.warnings.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('walks up to find project .manamir/commands', async () => {
    const root = await makeTmpProject();
    try {
      const deep = join(root, 'src', 'nested', 'deep');
      await mkdir(deep, { recursive: true });
      await writeFile(
        join(root, '.manamir', 'commands', 'walked.md'),
        ['---', 'name: walked', '---', 'found me'].join('\n')
      );
      const res = loadUserCommands(deep);
      assert.ok(res.commands.has('walked'), `warnings=${res.warnings.join('|')}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses filename as fallback name when frontmatter omits it', async () => {
    const root = await makeTmpProject();
    try {
      await writeFile(join(root, '.manamir', 'commands', 'noname.md'), 'just a body');
      const res = loadUserCommands(root);
      const cmd = res.commands.get('noname');
      assert.ok(cmd, `expected noname to load; warnings=${res.warnings.join('|')}`);
      assert.equal(cmd!.body, 'just a body');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('renderUserCommand', () => {
  test('renders body with args', async () => {
    const root = await makeTmpProject();
    try {
      await writeFile(
        join(root, '.manamir', 'commands', 'r.md'),
        ['---', 'name: r', '---', 'Args were: {{args}}'].join('\n')
      );
      const res = loadUserCommands(root);
      const cmd = res.commands.get('r')!;
      assert.equal(renderUserCommand(cmd, ['hello', 'world']), 'Args were: hello world');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('getUserCommandPaths', () => {
  test('returns empty array when no dirs exist', async () => {
    // Use a tmp dir with no .manamir anywhere up the tree.
    const root = await mkdtemp(join(tmpdir(), 'manamir-nopaths-'));
    try {
      const paths = getUserCommandPaths(root);
      // Global may or may not exist depending on the test runner's $HOME.
      // We only assert nothing in the chain came from the project search.
      assert.equal(paths.filter((p) => p.scope === 'project').length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
