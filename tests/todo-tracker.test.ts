import { describe, test } from 'node:test';
import assert from 'node:assert';
import { TodoTracker } from '../src/executor/todo-tracker';

describe('TodoTracker.extractFromMessage', () => {
  test('extracts a single English TODO', () => {
    const t = new TodoTracker();
    const created = t.extractFromMessage('TODO: fix build', 1);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].text, 'fix build');
    assert.strictEqual(created[0].done, false);
    assert.strictEqual(t.getOpen().length, 1);
  });

  test('checkbox: open + done in one message yields one open + one done', () => {
    const t = new TodoTracker();
    const content = '- [ ] deploy\n- [x] done';
    const created = t.extractFromMessage(content, 2);
    assert.strictEqual(created.length, 2);
    const open = t.getOpen();
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].text, 'deploy');
    const all = t.getAll();
    const doneTodos = all.filter(x => x.done);
    assert.strictEqual(doneTodos.length, 1);
    assert.strictEqual(doneTodos[0].text, 'done');
  });

  test('extracts Chinese 待办', () => {
    const t = new TodoTracker();
    const created = t.extractFromMessage('待办：打包', 1);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].text, '打包');
    assert.strictEqual(created[0].done, false);
    assert.strictEqual(t.getOpen().length, 1);
  });

  test('extracts Chinese 需要做', () => {
    const t = new TodoTracker();
    const created = t.extractFromMessage('需要做: 写文档', 1);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].text, '写文档');
  });

  test('case-insensitive todo: matches', () => {
    const t = new TodoTracker();
    t.extractFromMessage('todo: lowercase one', 1);
    assert.strictEqual(t.getOpen().length, 1);
  });

  test('does not duplicate identical open todos across messages', () => {
    const t = new TodoTracker();
    t.extractFromMessage('TODO: fix build', 1);
    t.extractFromMessage('TODO: fix build', 2);
    assert.strictEqual(t.getOpen().length, 1);
  });
});

describe('TodoTracker.markDone', () => {
  test('mark done by text prefix match — found', () => {
    const t = new TodoTracker();
    t.extractFromMessage('TODO: fix the bug then deploy', 1);
    const ok = t.markDone('fix the bug');
    assert.strictEqual(ok, true);
    assert.strictEqual(t.getOpen().length, 0);
  });

  test('mark done by exact id', () => {
    const t = new TodoTracker();
    t.extractFromMessage('TODO: write tests', 1);
    const id = t.getOpen()[0].id;
    const ok = t.markDone(id);
    assert.strictEqual(ok, true);
    assert.strictEqual(t.getOpen().length, 0);
  });

  test('returns false when no match', () => {
    const t = new TodoTracker();
    t.extractFromMessage('TODO: alpha', 1);
    assert.strictEqual(t.markDone('beta'), false);
    assert.strictEqual(t.markDone(''), false);
  });
});

describe('TodoTracker.formatForInjection', () => {
  test('returns empty string when no open todos', () => {
    const t = new TodoTracker();
    assert.strictEqual(t.formatForInjection(), '');
  });

  test('returns empty string after every todo is done', () => {
    const t = new TodoTracker();
    t.extractFromMessage('TODO: x', 1);
    t.markDone('x');
    assert.strictEqual(t.formatForInjection(), '');
  });

  test('formats two todos as a pending-todos XML block', () => {
    const t = new TodoTracker();
    t.extractFromMessage('TODO: alpha', 1);
    t.extractFromMessage('TODO: beta', 2);
    const out = t.formatForInjection();
    assert.match(out, /^<pending-todos count="2">/);
    assert.match(out, /- alpha/);
    assert.match(out, /- beta/);
    assert.match(out, /<\/pending-todos>$/);
  });
});
