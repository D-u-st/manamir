// Session — manages one conversation thread
// Supports AuthExecutor (Claude CLI) or ApiExecutor (DeepSeek/OpenAI API with tool use)

import { EventEmitter } from 'events';
import { AuthExecutor, type ExecutorOptions } from '../executor/auth-executor';
import { ApiExecutor, type ApiExecutorOptions } from '../executor/api-executor';
import { SubAgent } from '../agents/sub-agent';
import { ROLE_PROMPTS } from '../agents/coordinator';
import { toFunctionDefinitions, getTool } from '../tools';
import { hooks } from '../hooks';
import { log } from '../utils/logger';
import type { SessionId, ChatMessage, SessionStatus, ExecutorResult } from '../types';
import { messageId as mkMsgId } from '../types';
import type { HistoryStore } from './history';
import type { StreamEventResult } from '../executor/types';
import { loadBoot, formatBootForSystemPrompt } from './boot';

interface Executor {
  execute(prompt: string, callbacks?: {
    onText?: (text: string) => void;
    // toolCallId is OPTIONAL: backends like AuthExecutor (Claude CLI stream) don't
    // emit one. When present, Session pairs use/result by id (race-proof).
    onToolUse?: (tool: string, input: Record<string, unknown>, toolCallId?: string) => void;
    onToolResult?: (tool: string, content: string, isError: boolean, toolCallId?: string) => void;
  }): Promise<StreamEventResult>;
  kill(): void;
  readonly isRunning: boolean;
}

export type ExecutorBackend =
  | { type: 'auth'; options: ExecutorOptions }
  | { type: 'api'; options: ApiExecutorOptions };

export interface SessionOptions {
  id: SessionId;
  channelId: string;
  userId: string;
  backend: ExecutorBackend;
  history: HistoryStore;
  maxHistoryMessages: number;
  /** Optional external executor (e.g. FailoverExecutor) — overrides backend for API mode */
  externalExecutor?: Executor;
}

export class Session extends EventEmitter {
  readonly id: SessionId;
  readonly channelId: string;
  readonly userId: string;
  readonly createdAt: number = Date.now();

  private _status: SessionStatus = 'idle';
  private executor: Executor | null = null;
  private currentExecutionId: number = 0;
  private apiExecutorInstance: ApiExecutor | null = null;
  private claudeSessionId: string | null = null;
  private lastActivity: number = Date.now();
  private toolsUsed: string[] = []; // track tools used in current call
  // Detailed tool call records for the current sendMessage — emitted in
  // executor:complete so selfReview/skillSynth hooks can decide whether to extract
  // a lesson or skill. ok stays null until onToolResult fires.
  //
  // Pairing strategy: when the executor provides a `toolCallId` on both
  // onToolUse and onToolResult (api-executor passes `tc.id`), we pair by id —
  // this is race-proof for parallel same-name tool_calls in one turn. When the
  // id is absent (older backends, AuthExecutor, or any race that drops it) we
  // fall back to FIFO-by-tool-name. Previous LIFO mis-paired ok flags when
  // DeepSeek emitted parallel tool_calls of the same tool.
  private currentToolCalls: Array<{
    tool: string;
    args: unknown;
    ok: boolean | null;
    /** Executor-issued id (e.g. OpenAI tool_calls[i].id). Undefined if backend doesn't supply one. */
    toolCallId?: string;
  }> = [];
  private bootInjected: boolean = false; // BOOT.md is injected once per session

  constructor(private options: SessionOptions) {
    super();
    this.id = options.id;
    this.channelId = options.channelId;
    this.userId = options.userId;

    if (options.externalExecutor) {
      // Use injected executor (e.g. FailoverExecutor)
      this.apiExecutorInstance = options.externalExecutor as ApiExecutor;
    } else if (options.backend.type === 'api') {
      this.apiExecutorInstance = new ApiExecutor(options.backend.options);
      // Wire up tool system
      this.apiExecutorInstance.setTools(
        toFunctionDefinitions(),
        async (name, args) => {
          const tool = getTool(name);
          if (!tool) {
            return { content: `Unknown tool: ${name}`, isError: true };
          }
          return tool.execute(args);
        }
      );

      // Wire factual-verifier hook.
      // When api-executor heuristic detects high-risk turn (URL without
      // web_search / forbidden surrender phrase / version no tool / long
      // answer no tool), spawn a `factual-verifier` SubAgent to audit the
      // assistant's output, then parse VERDICT (PASS/FAIL/REASON/FIX).
      // Phase C2 just returns the verdict — Phase C3 will use FAIL to
      // inject correction back into conversation history for retry.
      const apiOpts = options.backend.options as ApiExecutorOptions;
      this.apiExecutorInstance.setFactualVerifierHook(
        async (userMsg, assistantMsg, toolsUsed, triggerReason) => {
          const verifierPrompt =
            `User asked:\n${userMsg}\n\n` +
            `Assistant answered:\n${assistantMsg}\n\n` +
            `toolsUsed: [${toolsUsed.join(', ') || 'none'}]\n\n` +
            `Trigger reason: ${triggerReason}\n\n` +
            `Audit the answer per your 5 checks. Output ONLY the strict VERDICT block.`;
          const agent = new SubAgent(
            {
              id: `verifier_${Date.now()}`,
              name: 'factual-verifier',
              role: 'factual-verifier',
              systemPrompt: ROLE_PROMPTS['factual-verifier'] ?? '',
              tools: ['web_search', 'web_fetch', 'read', 'grep'],
              maxTurns: 4,
            },
            {
              apiKey: apiOpts.apiKey,
              baseUrl: apiOpts.baseUrl,
              model: apiOpts.model,
              maxTokens: 1024,
              temperature: 0.2,
              timeoutMs: 30_000,
            }
          );
          const result = await agent.run(verifierPrompt);
          const verdictMatch = /VERDICT:\s*(PASS|FAIL)/i.exec(result.content);
          const reasonMatch = /REASON:\s*(.+?)(?:\n|$)/i.exec(result.content);
          const fixMatch = /FIX:\s*(.+?)(?:\n|$)/i.exec(result.content);
          return {
            verdict: (verdictMatch?.[1].toUpperCase() === 'PASS' ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL',
            reason: reasonMatch?.[1]?.trim(),
            fix: fixMatch?.[1]?.trim(),
          };
        }
      );
    }
  }

  get status(): SessionStatus { return this._status; }
  get backendType(): string { return this.options.backend.type; }

  async sendMessage(content: string): Promise<ExecutorResult> {
    this._status = 'running';
    this.lastActivity = Date.now();
    this.toolsUsed = [];
    this.currentToolCalls = [];

    const userMsg: ChatMessage = {
      id: mkMsgId(`msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`),
      role: 'user',
      content,
      timestamp: Date.now(),
      sessionId: this.id
    };
    this.options.history.append(userMsg);

    // BOOT.md: on the first sendMessage of this session, prepend BOOT.md
    // contents to the prompt so the agent always reads project bootstrap
    // instructions before processing the user's first request. We use the
    // process working directory (or BOOT_MD_PATH env override).
    let promptToSend = content;
    if (!this.bootInjected) {
      const bootContent = loadBoot({ projectRoot: process.cwd() });
      if (bootContent !== null) {
        promptToSend = `${formatBootForSystemPrompt(bootContent)}\n\n${content}`;
        log.info('BOOT.md injected', {
          sessionId: this.id,
          charCount: bootContent.length
        });
      }
      // Mark as attempted regardless of outcome — only inject once per session.
      this.bootInjected = true;
    }

    const executionId = ++this.currentExecutionId;
    const executor = this.createExecutor();
    this.executor = executor;
    const startTime = Date.now();

    await hooks.emit('executor:start', { sessionId: this.id, content });

    try {
      const result = await executor.execute(promptToSend, {
        onText: (text) => {
          this.emit('text', text);
        },
        onToolUse: (tool, input, toolCallId) => {
          // Wrap in try/catch — if an observer throws here, onToolResult
          // would never get a chance to flip ok, falsely marking the call
          // as failed in downstream selfReview/skillSynth hooks.
          try {
            this.toolsUsed.push(tool);
            this.currentToolCalls.push({ tool, args: input, ok: null, toolCallId });
            this.emit('tool_use', tool, input);
          } catch (err) {
            log.warn('Session: onToolUse observer threw', {
              sessionId: this.id,
              tool,
              error: String(err)
            });
          }
          log.debug('Session: tool use', { sessionId: this.id, tool });
        },
        onToolResult: (tool, resultContent, isError, toolCallId) => {
          try {
            // Preferred pairing: by toolCallId when both sides have one — this
            // is race-proof for parallel same-name tool_calls. Falls back to
            // FIFO-by-tool-name when the id is missing on either side.
            let matched = false;
            if (toolCallId) {
              for (let i = 0; i < this.currentToolCalls.length; i++) {
                const c = this.currentToolCalls[i];
                if (c.toolCallId === toolCallId && c.ok === null) {
                  c.ok = !isError;
                  matched = true;
                  break;
                }
              }
            }
            if (!matched) {
              // FIFO fallback: stamp ok on the FIRST unresolved call matching
              // this tool name. Parallel tool_calls of the same tool would
              // mis-pair under LIFO.
              for (let i = 0; i < this.currentToolCalls.length; i++) {
                const c = this.currentToolCalls[i];
                if (c.tool === tool && c.ok === null) {
                  c.ok = !isError;
                  break;
                }
              }
            }
            this.emit('tool_result', tool, resultContent, isError);
          } catch (err) {
            log.warn('Session: onToolResult observer threw', {
              sessionId: this.id,
              tool,
              error: String(err)
            });
          }
        }
      });

      if (result.session_id) {
        this.claudeSessionId = result.session_id;
      }

      // Build response with tool usage summary
      let responseContent = result.result;
      if (this.toolsUsed.length > 0) {
        const uniqueTools = [...new Set(this.toolsUsed)];
        const turns = result.num_turns || 1;
        responseContent += `\n\n_Used: ${uniqueTools.join(', ')} (${this.toolsUsed.length} calls, ${turns} turns)_`;
      }

      const assistantMsg: ChatMessage = {
        id: mkMsgId(`msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`),
        role: 'assistant',
        content: result.result,
        timestamp: Date.now(),
        sessionId: this.id,
        metadata: {
          costUsd: result.cost_usd,
          durationMs: result.duration_ms,
          numTurns: result.num_turns,
          toolsUsed: this.toolsUsed
        }
      };
      this.options.history.append(assistantMsg);

      this._status = 'idle';
      this.lastActivity = Date.now();

      // Emit full payload so selfReview/skillSynth hooks have what they need.
      // Without these fields they silently no-op (the original C-1 bug).
      const finalText = result.result || '';
      const terminated =
        finalText.startsWith('[Stopped:') ||
        finalText.startsWith('[Agent loop reached');
      // Resolve any tool calls that never got an onToolResult (rare: observer
      // exception, transport drop) as failed so selfReview's heuristics treat
      // them like genuine failures rather than silently as success.
      const finalisedCalls = this.currentToolCalls.map((c) => ({
        tool: c.tool,
        args: c.args,
        ok: c.ok === null ? false : c.ok
      }));
      await hooks.emit('executor:complete', {
        sessionId: this.id,
        durationMs: Date.now() - startTime,
        numTurns: result.num_turns,
        prompt: content,
        result: finalText,
        turnCount: result.num_turns,
        toolCalls: finalisedCalls,
        toolResults: finalisedCalls.map((c) => ({ isError: !c.ok })),
        terminated
      });

      return {
        sessionId: this.id,
        content: responseContent,
        costUsd: result.cost_usd,
        durationMs: Date.now() - startTime,
        numTurns: result.num_turns || 1,
        isError: false
      };
    } catch (error) {
      this._status = 'error';
      await hooks.emit('executor:error', {
        sessionId: this.id,
        error: error instanceof Error ? error.message : String(error)
      });
      log.error('Session: execution failed', {
        sessionId: this.id,
        error: String(error)
      });

      return {
        sessionId: this.id,
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: Date.now() - startTime,
        numTurns: 0,
        isError: true
      };
    } finally {
      if (this.currentExecutionId === executionId) {
        this.executor = null;
      }
    }
  }

  private createExecutor(): Executor {
    const backend = this.options.backend;

    if (backend.type === 'api') {
      return this.apiExecutorInstance!;
    }

    return new AuthExecutor({
      ...backend.options,
      resumeSessionId: this.claudeSessionId || undefined
    });
  }

  interrupt(): void {
    if (this.executor?.isRunning) {
      this.executor.kill();
      this._status = 'idle';
      log.info('Session: interrupted', { sessionId: this.id });
    }
  }

  getHistory(limit?: number): ChatMessage[] {
    return this.options.history.load(this.id, limit || this.options.maxHistoryMessages);
  }

  /**
   * Seed the underlying ApiExecutor's conversationHistory with prior messages
   * so the next sendMessage() call has full context. Used by
   * SessionManager.adoptSession when a user resumes an old session.
   *
   * No-op for non-API backends (auth/Claude CLI uses --resume instead).
   */
  preloadHistory(messages: ChatMessage[]): void {
    if (!this.apiExecutorInstance) return;
    if (typeof this.apiExecutorInstance.preloadHistory !== 'function') return;
    const mapped = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));
    this.apiExecutorInstance.preloadHistory(mapped);
  }

  get idleDurationMs(): number {
    return Date.now() - this.lastActivity;
  }

  destroy(): void {
    this.interrupt();
    this._status = 'stopped';
    this.apiExecutorInstance = null;
    this.removeAllListeners();
  }
}
