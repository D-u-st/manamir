// FailoverExecutor (P-78) — wraps multiple ApiExecutor instances with priority-based failover
// On error (rate limit, 500, timeout): tries the next provider.
// After 3 failures on a provider, puts it on cooldown for 60s.

import { ApiExecutor } from './api-executor';
import { hooks } from '../hooks';
import { log } from '../utils/logger';
import type { StreamEventResult, ExecutorCallbacks } from './types';

export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  priority: number; // lower = preferred
}

interface ProviderState {
  config: ProviderConfig;
  executor: ApiExecutor;
  failures: number;
  cooldownUntil: number; // timestamp
}

export class FailoverExecutor {
  private providers: ProviderState[];
  private currentIndex = 0;

  constructor(
    configs: ProviderConfig[],
    private executorOptions: {
      maxTokens?: number;
      temperature?: number;
      timeoutMs?: number;
      systemPrompt?: string;
      maxTurns?: number;
    } = {}
  ) {
    // Sort by priority (lower first)
    const sorted = [...configs].sort((a, b) => a.priority - b.priority);

    this.providers = sorted.map((cfg) => ({
      config: cfg,
      executor: new ApiExecutor({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        ...this.executorOptions
      }),
      failures: 0,
      cooldownUntil: 0
    }));

    if (this.providers.length === 0) {
      throw new Error('FailoverExecutor: at least one provider is required');
    }
  }

  async execute(prompt: string, callbacks?: ExecutorCallbacks): Promise<StreamEventResult> {
    const now = Date.now();
    const tried = new Set<number>();
    const errors: { provider: string; error: string }[] = [];

    while (tried.size < this.providers.length) {
      // Find next available provider (not on cooldown, not already tried)
      const idx = this.findAvailableProvider(now, tried);
      if (idx === -1) {
        // All providers exhausted or on cooldown — try the one with earliest cooldown end
        const earliest = this.findEarliestCooldownProvider(tried);
        if (earliest === -1) break;
        // Wait out cooldown
        const waitMs = this.providers[earliest].cooldownUntil - now;
        if (waitMs > 0) {
          log.warn('FailoverExecutor: all providers on cooldown, waiting', {
            provider: this.providers[earliest].config.name,
            waitMs
          });
          await new Promise((r) => setTimeout(r, waitMs));
        }
        // Reset this provider's cooldown and retry
        this.providers[earliest].cooldownUntil = 0;
        this.providers[earliest].failures = 0;
        tried.delete(earliest);
        continue;
      }

      tried.add(idx);
      const provider = this.providers[idx];

      try {
        log.info('FailoverExecutor: trying provider', {
          name: provider.config.name,
          model: provider.config.model,
          attempt: tried.size
        });

        const result = await provider.executor.execute(prompt, callbacks);

        // Success — reset failure count, stick with this provider
        provider.failures = 0;
        this.currentIndex = idx;
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRetryable = this.isRetryableError(msg);

        provider.failures++;
        errors.push({ provider: provider.config.name, error: msg.slice(0, 200) });
        log.warn('FailoverExecutor: provider failed', {
          name: provider.config.name,
          failures: provider.failures,
          retryable: isRetryable,
          error: msg.slice(0, 200)
        });

        await hooks.emit('executor:error', {
          provider: provider.config.name,
          error: msg,
          failures: provider.failures
        });

        // Cooldown after 3 failures
        if (provider.failures >= 3) {
          provider.cooldownUntil = Date.now() + 60_000;
          log.warn('FailoverExecutor: provider on cooldown', {
            name: provider.config.name,
            cooldownUntilMs: 60_000
          });
        }

        if (!isRetryable) {
          // Non-retryable error — still try next provider
          continue;
        }
      }
    }

    const details = errors.map((e) => `${e.provider}: ${e.error}`).join('; ');
    throw new Error(`FailoverExecutor: all providers failed — ${details}`);
  }

  private findAvailableProvider(now: number, tried: Set<number>): number {
    for (let i = 0; i < this.providers.length; i++) {
      if (tried.has(i)) continue;
      if (this.providers[i].cooldownUntil > now) continue;
      return i;
    }
    return -1;
  }

  private findEarliestCooldownProvider(tried: Set<number>): number {
    let earliest = -1;
    let earliestTime = Infinity;
    for (let i = 0; i < this.providers.length; i++) {
      if (tried.has(i)) continue;
      if (this.providers[i].cooldownUntil < earliestTime) {
        earliestTime = this.providers[i].cooldownUntil;
        earliest = i;
      }
    }
    return earliest;
  }

  private isRetryableError(msg: string): boolean {
    return msg.includes('rate_limit') ||
           msg.includes('429') ||
           msg.includes('503') ||
           msg.includes('500') ||
           msg.includes('overloaded') ||
           msg.includes('timeout') ||
           msg.includes('ECONNREFUSED') ||
           msg.includes('ETIMEDOUT');
  }

  /** Set tools on all underlying executors */
  setTools(tools: Parameters<ApiExecutor['setTools']>[0], executor: Parameters<ApiExecutor['setTools']>[1]): void {
    for (const p of this.providers) {
      p.executor.setTools(tools, executor);
    }
  }

  /** Clear history on all executors */
  clearHistory(): void {
    for (const p of this.providers) {
      p.executor.clearHistory();
    }
  }

  kill(): void {
    for (const p of this.providers) {
      p.executor.kill();
    }
  }

  get isRunning(): boolean {
    return this.providers.some((p) => p.executor.isRunning);
  }

  get currentProvider(): string {
    return this.providers[this.currentIndex]?.config.name ?? 'none';
  }
}
