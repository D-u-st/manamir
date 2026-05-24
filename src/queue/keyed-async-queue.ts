// KeyedAsyncQueue
// Same session = serial execution (prevent race conditions)
// Different sessions = concurrent execution (maximize throughput)
//
// Usage:
//   queue.enqueue(sessionId, () => processMessage(msg))
//   → messages for same session run one-at-a-time
//   → messages for different sessions run in parallel

import { log } from '../utils/logger';

export class KeyedAsyncQueue {
  private chains: Map<string, Promise<void>> = new Map();
  private sizes: Map<string, number> = new Map();

  enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const currentSize = this.sizes.get(key) || 0;
    this.sizes.set(key, currentSize + 1);

    // Chain onto existing promise for this key (serial within key)
    const prev = this.chains.get(key) || Promise.resolve();

    const next = prev
      .then(() => fn())
      .finally(() => {
        const newSize = (this.sizes.get(key) || 1) - 1;
        if (newSize <= 0) {
          this.chains.delete(key);
          this.sizes.delete(key);
        } else {
          this.sizes.set(key, newSize);
        }
      });

    // Store the chain (void version — we don't want to propagate errors to next in chain)
    this.chains.set(key, next.then(() => {}, () => {}));

    return next;
  }

  getQueueSize(key: string): number {
    return this.sizes.get(key) || 0;
  }

  get activeKeys(): number {
    return this.chains.size;
  }
}
