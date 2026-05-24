// AuthExecutor (P-01 Agent Loop + P-03 StreamingToolExecutor)
// Replaces tmux send-keys with `claude --print --output-format stream-json`
// Uses Max subscription auth — free execution
//
// Stream protocol: NDJSON (newline-delimited JSON)
// Each line = one StreamEvent object

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { log } from '../utils/logger';
import { withRetry } from '../utils/retry';
import type { StreamEvent, StreamEventResult, ExecutorCallbacks } from './types';
import type { SessionId } from '../types';

export interface ExecutorOptions {
  cliPath: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  resumeSessionId?: string;  // resume existing Claude session
}

export class AuthExecutor extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = '';
  private abortController: AbortController | null = null;

  // Stream idle watchdog (P-46)
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly WATCHDOG_TIMEOUT_MS = 120_000; // 2 min no data = dead

  constructor(private options: ExecutorOptions) {
    super();
  }

  async execute(prompt: string, callbacks?: ExecutorCallbacks): Promise<StreamEventResult> {
    return withRetry(
      () => this._executeOnce(prompt, callbacks),
      {
        maxRetries: 2,
        baseDelayMs: 2000,
        shouldRetry: (err) => {
          const msg = String(err);
          // Retry on transient errors, not auth/permission failures
          return msg.includes('ECONNRESET') ||
                 msg.includes('overloaded') ||
                 msg.includes('rate_limit') ||
                 msg.includes('529');
        }
      }
    );
  }

  private _executeOnce(prompt: string, callbacks?: ExecutorCallbacks): Promise<StreamEventResult> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs(prompt);

      log.info('Executor: spawning claude', { args: args.join(' ') });

      const proc = spawn(this.options.cliPath, args, {
        cwd: this.options.cwd || process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.process = proc;
      this.buffer = '';
      this.abortController = new AbortController();

      let stderr = '';
      let completed = false;

      // Timeout watchdog
      const timeout = setTimeout(() => {
        if (!completed) {
          this.kill();
          reject(new Error(`Executor timeout after ${this.options.timeoutMs || 1_800_000}ms`));
        }
      }, this.options.timeoutMs || 1_800_000);

      // Start stream idle watchdog (P-46)
      this.resetWatchdog(() => {
        if (!completed) {
          log.warn('Executor: stream idle watchdog triggered');
          this.kill();
          reject(new Error('Stream idle timeout — no data for 2 minutes'));
        }
      });

      proc.stdout!.on('data', (chunk: Buffer) => {
        this.resetWatchdog(() => {
          if (!completed) {
            this.kill();
            reject(new Error('Stream idle timeout'));
          }
        });

        this.buffer += chunk.toString();
        this.processBuffer(callbacks);
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        completed = true;
        clearTimeout(timeout);
        this.clearWatchdog();
        this.process = null;

        // Process any remaining buffer
        this.processBuffer(callbacks);

        // Find the result event from accumulated events
        const resultEvent = this.findResultEvent();

        if (resultEvent) {
          if (resultEvent.is_error || resultEvent.subtype === 'error') {
            callbacks?.onError?.(new Error(resultEvent.result));
            reject(new Error(resultEvent.result));
          } else {
            callbacks?.onComplete?.(resultEvent);
            resolve(resultEvent);
          }
        } else if (code !== 0) {
          const error = new Error(`Claude CLI exited with code ${code}: ${stderr.trim()}`);
          callbacks?.onError?.(error);
          reject(error);
        } else {
          // No result event but clean exit — construct one from accumulated text
          const result: StreamEventResult = {
            type: 'result',
            subtype: 'success',
            result: this.accumulatedText,
            session_id: this.currentSessionId || '',
            is_error: false
          };
          callbacks?.onComplete?.(result);
          resolve(result);
        }
      });

      proc.on('error', (err) => {
        completed = true;
        clearTimeout(timeout);
        this.clearWatchdog();
        callbacks?.onError?.(err);
        reject(err);
      });

      // Write prompt to stdin and close
      proc.stdin!.write(prompt);
      proc.stdin!.end();
    });
  }

  private buildArgs(prompt: string): string[] {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose'
    ];

    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    if (this.options.maxTurns) {
      args.push('--max-turns', String(this.options.maxTurns));
    }

    if (this.options.resumeSessionId) {
      args.push('--resume', this.options.resumeSessionId);
    }

    if (this.options.systemPrompt) {
      args.push('--system-prompt', this.options.systemPrompt);
    }

    if (this.options.allowedTools) {
      for (const tool of this.options.allowedTools) {
        args.push('--allowedTools', tool);
      }
    }

    // Prompt goes via stdin, not as arg (avoids shell escaping issues, P-37)
    args.push('-p', '-');

    return args;
  }

  // Accumulated state for constructing result when no explicit result event
  private accumulatedText: string = '';
  private currentSessionId: string = '';
  private lastResultEvent: StreamEventResult | null = null;

  private processBuffer(callbacks?: ExecutorCallbacks): void {
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed) as StreamEvent;
        this.handleEvent(event, callbacks);
      } catch {
        // Not JSON — could be stderr leak or progress indicator, ignore
        log.debug('Non-JSON line from claude:', { line: trimmed });
      }
    }
  }

  private handleEvent(event: StreamEvent, callbacks?: ExecutorCallbacks): void {
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          this.currentSessionId = event.session_id;
          log.info('Executor: session initialized', { sessionId: event.session_id });
        }
        break;

      case 'assistant':
        if (event.subtype === 'text') {
          this.accumulatedText += event.text;
          callbacks?.onText?.(event.text);
          this.emit('text', event.text);
        } else if (event.subtype === 'tool_use') {
          callbacks?.onToolUse?.(event.tool, event.input);
          this.emit('tool_use', event.tool, event.input);
        }
        break;

      case 'tool':
        if (event.subtype === 'result') {
          callbacks?.onToolResult?.(event.tool, event.content, !!event.is_error);
          this.emit('tool_result', event.tool, event.content, !!event.is_error);
        }
        break;

      case 'result':
        this.lastResultEvent = event as StreamEventResult;
        break;
    }
  }

  private findResultEvent(): StreamEventResult | null {
    return this.lastResultEvent;
  }

  // Stream idle watchdog (P-46)
  private resetWatchdog(onTimeout: () => void): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(onTimeout, this.WATCHDOG_TIMEOUT_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  kill(): void {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      // Force kill after 5s if still alive
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }
    this.clearWatchdog();
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
