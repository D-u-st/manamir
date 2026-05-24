// Exponential backoff retry (P-05)
// With jitter to prevent thundering herd

import { log } from './logger';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === opts.maxRetries) break;
      if (opts.shouldRetry && !opts.shouldRetry(error)) break;

      // Exponential backoff with jitter
      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5),
        opts.maxDelayMs
      );

      log.warn(`Retry ${attempt + 1}/${opts.maxRetries} after ${Math.round(delay)}ms`, {
        error: String(error)
      });

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
