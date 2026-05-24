// SubAgent (P-10, P-27) — a self-contained agent with its own ApiExecutor.
// Each sub-agent has isolated conversation history and optionally restricted tool access.

import { EventEmitter } from 'events';
import { ApiExecutor } from '../executor/api-executor';
import { getAllTools, getTool, toFunctionDefinitionsFiltered, toFunctionDefinitions } from '../tools';
import { log } from '../utils/logger';
import type { AgentConfig, AgentResult } from './types';
import type { StreamEventResult, ToolDefinition as ExecToolDef } from '../executor/types';

export class SubAgent extends EventEmitter {
  readonly config: AgentConfig;
  private executor: ApiExecutor;
  private _running = false;
  private _toolsUsed: string[] = [];

  constructor(
    config: AgentConfig,
    apiOptions: {
      apiKey: string;
      baseUrl: string;
      model: string;
      maxTokens?: number;
      temperature?: number;
      timeoutMs?: number;
    }
  ) {
    super();
    this.config = config;

    this.executor = new ApiExecutor({
      ...apiOptions,
      systemPrompt: config.systemPrompt,
      maxTurns: config.maxTurns
    });

    // Wire tools — restricted to config.tools if specified, otherwise all
    const toolDefs = config.tools.length > 0
      ? toFunctionDefinitionsFiltered(config.tools)
      : toFunctionDefinitions();

    this.executor.setTools(
      toolDefs,
      async (name, args) => {
        // Enforce tool restriction even if the model hallucinates a tool name
        if (config.tools.length > 0 && !config.tools.includes(name)) {
          return { content: `Tool '${name}' is not available to this agent. Available: ${config.tools.join(', ')}`, isError: true };
        }
        const tool = getTool(name);
        if (!tool) {
          return { content: `Unknown tool: ${name}`, isError: true };
        }
        this._toolsUsed.push(name);
        return tool.execute(args);
      }
    );
  }

  async run(prompt: string): Promise<AgentResult> {
    this._running = true;
    this._toolsUsed = [];
    const startTime = Date.now();

    log.info('SubAgent: starting', {
      id: this.config.id,
      role: this.config.role,
      name: this.config.name
    });

    try {
      const result: StreamEventResult = await this.executor.execute(prompt, {
        onText: (text) => this.emit('text', text),
        onToolUse: (tool, input) => {
          this.emit('tool_use', tool, input);
        },
        onToolResult: (tool, content, isError) => {
          this.emit('tool_result', tool, content, isError);
        }
      });

      const agentResult: AgentResult = {
        agentId: this.config.id,
        content: result.result,
        toolsUsed: [...new Set(this._toolsUsed)],
        turns: result.num_turns ?? 1,
        durationMs: Date.now() - startTime,
        isError: result.is_error ?? false
      };

      log.info('SubAgent: completed', {
        id: this.config.id,
        role: this.config.role,
        turns: agentResult.turns,
        durationMs: agentResult.durationMs,
        toolsUsed: agentResult.toolsUsed
      });

      return agentResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error('SubAgent: failed', { id: this.config.id, error: errorMsg });

      return {
        agentId: this.config.id,
        content: `Error: ${errorMsg}`,
        toolsUsed: [...new Set(this._toolsUsed)],
        turns: 0,
        durationMs: Date.now() - startTime,
        isError: true
      };
    } finally {
      this._running = false;
    }
  }

  kill(): void {
    this.executor.kill();
    this._running = false;
  }

  clearHistory(): void {
    this.executor.clearHistory();
  }

  get isRunning(): boolean {
    return this._running;
  }
}
