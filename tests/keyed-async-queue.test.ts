import { describe, test } from 'node:test';
import assert from 'node:assert';
import { KeyedAsyncQueue } from '../src/queue/keyed-async-queue';

describe('KeyedAsyncQueue', () => {
  test('runs a single task and returns its result', async () => {
    const queue = new KeyedAsyncQueue();
    const result = await queue.enqueue('k1', async () => 42);
    assert.strictEqual(result, 42);
  });

  test('runs tasks for the same key serially', async () => {
    const queue = new KeyedAsyncQueue();
    const order: number[] = [];

    const p1 = queue.enqueue('k1', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });
    const p2 = queue.enqueue('k1', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, [1, 2]);
  });

  test('runs tasks for different keys concurrently', async () => {
    const queue = new KeyedAsyncQueue();
    const order: string[] = [];

    const p1 = queue.enqueue('a', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push('a');
    });
    const p2 = queue.enqueue('b', async () => {
      order.push('b');
    });

    await Promise.all([p1, p2]);
    // 'b' should finish first since 'a' has a delay
    assert.strictEqual(order[0], 'b');
    assert.strictEqual(order[1], 'a');
  });

  test('getQueueSize reflects pending tasks', async () => {
    const queue = new KeyedAsyncQueue();
    let resolve1!: () => void;
    const blocker = new Promise<void>(r => { resolve1 = r; });

    const p1 = queue.enqueue('k', () => blocker);
    const p2 = queue.enqueue('k', async () => {});

    assert.strictEqual(queue.getQueueSize('k'), 2);

    resolve1();
    await Promise.all([p1, p2]);

    assert.strictEqual(queue.getQueueSize('k'), 0);
  });

  test('activeKeys counts keys with pending work', async () => {
    const queue = new KeyedAsyncQueue();
    let resolve1!: () => void;
    const blocker = new Promise<void>(r => { resolve1 = r; });

    const p1 = queue.enqueue('x', () => blocker);
    const p2 = queue.enqueue('y', () => blocker);

    assert.strictEqual(queue.activeKeys, 2);

    resolve1();
    await Promise.all([p1, p2]);

    assert.strictEqual(queue.activeKeys, 0);
  });

  test('error in one task does not block next task in same key', async () => {
    const queue = new KeyedAsyncQueue();

    const p1 = queue.enqueue('k', async () => {
      throw new Error('boom');
    });

    const p2 = queue.enqueue('k', async () => 'ok');

    await assert.rejects(p1, { message: 'boom' });
    const result = await p2;
    assert.strictEqual(result, 'ok');
  });

  test('getQueueSize returns 0 for unknown key', () => {
    const queue = new KeyedAsyncQueue();
    assert.strictEqual(queue.getQueueSize('unknown'), 0);
  });
});
