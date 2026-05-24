// Hook registry — global singleton event system
// Fires handlers async, logs errors but never crashes the caller.

import { log } from '../utils/logger';
import type { HookEvent, HookHandler } from './types';

class HookRegistry {
  private handlers = new Map<HookEvent, Set<HookHandler>>();

  on(event: HookEvent, handler: HookHandler): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  off(event: HookEvent, handler: HookHandler): void {
    const set = this.handlers.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(event);
    }
  }

  async emit(event: HookEvent, data: Record<string, unknown> = {}): Promise<void> {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;

    const promises: Promise<void>[] = [];
    for (const handler of set) {
      promises.push(
        Promise.resolve()
          .then(() => handler(event, data))
          .catch((err) => {
            log.error('Hook handler error', {
              event,
              error: err instanceof Error ? err.message : String(err)
            });
          })
      );
    }
    await Promise.all(promises);
  }

  /** Remove all handlers (useful for tests / shutdown) */
  clear(): void {
    this.handlers.clear();
  }
}

// Global singleton
export const hooks = new HookRegistry();
