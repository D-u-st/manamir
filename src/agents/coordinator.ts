// AgentCoordinator (P-33, P-34) — orchestrates sub-agents through 4 phases:
//   Research → Synthesis → Implementation → Verification
//
// Each phase spawns a fresh SubAgent with role-specific system prompt and tools.
// Context flows forward: research output feeds synthesis, plan feeds implementation, etc.

import { EventEmitter } from 'events';
import { SubAgent } from './sub-agent';
import { Mailbox } from './mailbox';
import { log } from '../utils/logger';
import type {
  AgentConfig,
  AgentResult,
  CoordinatorPhase,
  PhaseResult,
  CoordinatorResult
} from './types';

// -- Role-specific system prompts --
// V1 Phase C2: exported so session.ts can spawn factual-verifier SubAgent
// directly (without going through Coordinator.execute pipeline).

export const ROLE_PROMPTS: Record<string, string> = {
  researcher: `You are a Research Agent. Your job is to investigate and gather information.
- Use tools (read, grep, glob, bash) to understand the current state
- Identify relevant files, dependencies, and potential impact areas
- Summarize findings clearly and factually
- Flag risks, edge cases, and unknowns
- Do NOT modify any files — read-only investigation only`,

  synthesizer: `You are a Synthesis Agent. You analyze research and produce action plans.
- Analyze the research findings provided to you
- Design a solution that addresses the task requirements
- Produce a step-by-step plan with specific file paths and changes
- Identify the order of operations and dependencies between steps
- Be specific: name exact files, functions, and line numbers
- Do NOT execute changes — only plan them`,

  implementer: `You are an Implementation Agent. You execute a plan step by step.
- Follow the plan, making the required changes
- Write clean code that fits the existing codebase style
- Read target files before editing
- Verify each change works before moving to the next step
- If a plan step is unclear, adapt and note the deviation
- Report a summary of all changes made`,

  reviewer: `You are a Verification Agent. You check that implementation is correct.
- Read each modified file and verify changes are correct
- Run any available tests or build commands
- Check for regressions or unintended side effects
- Look for common mistakes: typos, missing imports, broken references
- Produce a clear report: what passed, what failed, what needs fixing`,

  // factual verifier for DS chat output.
  // Different from `reviewer` (which verifies file changes) — this verifies
  // the FACTUAL CLAIMS in DS's natural-language answer for a given user turn.
  // Triggered by api-executor heuristic (high-risk turn) — NOT every turn.
  
  'factual-verifier': `You are a Factual Verifier. You audit a previous AI assistant turn for hallucination, fabricated sources, and tool-misuse.

You will receive: (1) the user's question, (2) the assistant's answer, (3) the toolsUsed list. Your job is to check 5 things:

1. **URLs / GitHub repos / paths cited in the answer** — were they returned by a tool result this turn? Or invented from training memory? (NEVER trust unverified URLs — fabricated repos are common DS failure mode.)
2. **"Search-style" claims (versions, latest news, current facts)** — did toolsUsed actually contain web_search / web_fetch? If the answer claims facts but toolsUsed is empty or only [bash], that's suspicious.
3. **[Source: ...] citations** — present and consistent with toolsUsed? Missing citations on factual claims = FAIL.
4. **Forbidden surrender phrases** — did the answer contain "我无法访问/工具集有限/我的知识截止/建议你自行搜索"? If yes, the assistant denied tools it has access to = FAIL.
5. **Hallucinated specifics** — version numbers, function signatures, library names that don't appear in any tool result this turn.

If anything is unclear, you may use web_search / web_fetch / read / grep to spot-check ONE specific claim (don't audit-search every claim — just the most suspicious one).

**OUTPUT FORMAT (strict — parser depends on it):**
\`\`\`
VERDICT: PASS | FAIL
REASON: <one short sentence on what passed/failed>
FIX: <if FAIL, one short sentence telling the assistant how to redo the turn>
\`\`\`
Use PASS only if all 5 checks above are clean. When in doubt → FAIL with specific reason.`
};

// -- Default tool restrictions per role --

const ROLE_TOOLS: Record<string, string[]> = {
  researcher: ['bash', 'read', 'glob', 'grep'],           // read-only tools
  synthesizer: [],                                          // all tools (needs read for context)
  implementer: ['bash', 'read', 'write', 'glob', 'grep', 'edit'],  // full write access
  reviewer: ['bash', 'read', 'glob', 'grep'],              // read-only + bash for tests
  // V1 Phase B: factual verifier needs web_search/web_fetch to spot-check
  // suspicious claims (versions, URLs, news). NO bash — we don't want it
  // running shell commands during a chat-output audit. NO write/edit.
  'factual-verifier': ['web_search', 'web_fetch', 'read', 'grep']
};

export interface CoordinatorOptions {
  /** API connection shared by all sub-agents */
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Max turns per sub-agent (default 10) */
  maxTurnsPerAgent?: number;
  /** Extra context prepended to all role prompts */
  taskContext?: string;
  /** Skip verification phase (default false) */
  skipVerification?: boolean;
  /** Max retries per failed phase (default 1) */
  maxRetries?: number;
  /** Max concurrent agents in the same phase — reserved for future parallel sub-tasks */
  maxConcurrent?: number;
}

const PHASES: CoordinatorPhase[] = ['research', 'synthesis', 'implementation', 'verification'];
const PHASE_ROLES: Record<CoordinatorPhase, string> = {
  research: 'researcher',
  synthesis: 'synthesizer',
  implementation: 'implementer',
  verification: 'reviewer'
};

let coordCounter = 0;

export class AgentCoordinator extends EventEmitter {
  private currentPhase: CoordinatorPhase | 'idle' | 'complete' | 'failed' = 'idle';
  private activeAgent: SubAgent | null = null;
  private phaseResults: PhaseResult[] = [];
  private aborted = false;
  private readonly coordId: string;
  readonly mailbox = new Mailbox();

  // Track all agents spawned during this coordination for /agent list
  private _activeAgents = new Map<string, SubAgent>();

  constructor(private options: CoordinatorOptions) {
    super();
    this.coordId = `coord_${++coordCounter}_${Date.now()}`;
  }

  /**
   * Run the full 4-phase coordination pipeline.
   */
  async execute(task: string): Promise<CoordinatorResult> {
    const startTime = Date.now();
    this.phaseResults = [];
    this.aborted = false;
    this.mailbox.clear();

    log.info('Coordinator: starting pipeline', {
      id: this.coordId,
      task: task.slice(0, 120)
    });

    const maxRetries = this.options.maxRetries ?? 1;

    try {
      // Phase 1: Research
      const researchResult = await this.runPhaseWithRetry('research', task, maxRetries);
      if (!researchResult || this.aborted) return this.buildResult(task, startTime, false);

      // Phase 2: Synthesis — receives research findings
      const synthesisPrompt = buildSynthesisPrompt(task, researchResult.result.content);
      const synthesisResult = await this.runPhaseWithRetry('synthesis', synthesisPrompt, maxRetries);
      if (!synthesisResult || this.aborted) return this.buildResult(task, startTime, false);

      // Phase 3: Implementation — receives the plan
      const implPrompt = buildImplementationPrompt(task, synthesisResult.result.content);
      const implResult = await this.runPhaseWithRetry('implementation', implPrompt, maxRetries);
      if (!implResult || this.aborted) return this.buildResult(task, startTime, false);

      // Phase 4: Verification (optional)
      if (!this.options.skipVerification) {
        const verifyPrompt = buildVerificationPrompt(
          task,
          synthesisResult.result.content,
          implResult.result.content
        );
        const verifyResult = await this.runPhaseWithRetry('verification', verifyPrompt, maxRetries);
        if (!verifyResult || this.aborted) return this.buildResult(task, startTime, false);
      }

      this.currentPhase = 'complete';
      this.emit('complete', this.phaseResults);
      return this.buildResult(task, startTime, true);

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error('Coordinator: pipeline failed', { id: this.coordId, error: errorMsg });
      this.currentPhase = 'failed';
      return this.buildResult(task, startTime, false);
    }
  }

  /**
   * Spawn a standalone sub-agent for a one-off task (not part of a phase pipeline).
   */
  async spawnAgent(role: string, task: string, overrides?: Partial<AgentConfig>): Promise<AgentResult> {
    const agentId = `${this.coordId}_${role}_${Date.now()}`;
    const config: AgentConfig = {
      id: agentId,
      name: overrides?.name ?? `${role}-agent`,
      role,
      systemPrompt: overrides?.systemPrompt ?? ROLE_PROMPTS[role] ?? '',
      tools: overrides?.tools ?? ROLE_TOOLS[role] ?? [],
      maxTurns: overrides?.maxTurns ?? this.options.maxTurnsPerAgent ?? 10
    };

    const agent = new SubAgent(config, {
      apiKey: this.options.apiKey,
      baseUrl: this.options.baseUrl,
      model: this.options.model,
      maxTokens: this.options.maxTokens,
      temperature: this.options.temperature,
      timeoutMs: this.options.timeoutMs
    });

    this._activeAgents.set(agentId, agent);
    this.mailbox.register(agentId);

    // Forward events
    agent.on('text', (text: string) => this.emit('agent_text', role, text));
    agent.on('tool_use', (tool: string, input: Record<string, unknown>) =>
      this.emit('agent_tool_use', role, tool, input));

    try {
      const result = await agent.run(task);
      return result;
    } finally {
      this._activeAgents.delete(agentId);
      this.mailbox.unregister(agentId);
    }
  }

  private async runPhaseWithRetry(
    phase: CoordinatorPhase,
    prompt: string,
    maxRetries: number
  ): Promise<PhaseResult | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.aborted) return null;

      const result = await this.runPhase(phase, prompt);

      if (!result.result.isError) return result;

      if (attempt < maxRetries) {
        log.warn('Coordinator: phase failed, retrying', {
          phase, attempt: attempt + 1, maxRetries
        });
        prompt = `${prompt}\n\n[Previous attempt failed: ${result.result.content.slice(0, 500)}]\nTry a different approach.`;
      } else {
        log.error('Coordinator: phase exhausted retries', { phase });
        return null;
      }
    }
    return null;
  }

  private async runPhase(phase: CoordinatorPhase, prompt: string): Promise<PhaseResult> {
    this.currentPhase = phase;
    const role = PHASE_ROLES[phase];
    const agentId = `${this.coordId}_${role}_${Date.now()}`;

    log.info('Coordinator: starting phase', { phase, role, agentId });
    this.emit('phase_start', phase, role);

    const config: AgentConfig = {
      id: agentId,
      name: `${role}-agent`,
      role,
      systemPrompt: this.buildRolePrompt(role),
      tools: ROLE_TOOLS[role] ?? [],
      maxTurns: this.options.maxTurnsPerAgent ?? 10
    };

    const agent = new SubAgent(config, {
      apiKey: this.options.apiKey,
      baseUrl: this.options.baseUrl,
      model: this.options.model,
      maxTokens: this.options.maxTokens,
      temperature: this.options.temperature,
      timeoutMs: this.options.timeoutMs
    });

    this.activeAgent = agent;
    this._activeAgents.set(agentId, agent);
    this.mailbox.register(agentId);

    // Forward sub-agent events
    agent.on('text', (text: string) => this.emit('agent_text', phase, text));
    agent.on('tool_use', (tool: string, input: Record<string, unknown>) =>
      this.emit('agent_tool_use', phase, tool, input));
    agent.on('tool_result', (tool: string, content: string, isError: boolean) =>
      this.emit('agent_tool_result', phase, tool, content, isError));

    const agentResult = await agent.run(prompt);

    // Clean up
    this.activeAgent = null;
    this._activeAgents.delete(agentId);
    this.mailbox.unregister(agentId);

    const phaseResult: PhaseResult = { phase, agentId, result: agentResult };
    this.phaseResults.push(phaseResult);

    log.info('Coordinator: phase completed', {
      phase, role,
      durationMs: agentResult.durationMs,
      isError: agentResult.isError,
      toolsUsed: agentResult.toolsUsed
    });

    this.emit('phase_complete', phase, agentResult);
    return phaseResult;
  }

  private buildRolePrompt(role: string): string {
    const base = ROLE_PROMPTS[role] ?? '';
    if (!this.options.taskContext) return base;
    return `${base}\n\n# Context\n${this.options.taskContext}`;
  }

  private buildResult(task: string, startTime: number, success: boolean): CoordinatorResult {
    const lastPhase = this.phaseResults[this.phaseResults.length - 1];
    return {
      task,
      phases: this.phaseResults,
      finalContent: lastPhase?.result.content ?? '[No phases completed]',
      totalDurationMs: Date.now() - startTime,
      success
    };
  }

  /** Abort current pipeline, kills active sub-agent */
  abort(): void {
    this.aborted = true;
    if (this.activeAgent?.isRunning) {
      this.activeAgent.kill();
    }
    for (const agent of this._activeAgents.values()) {
      if (agent.isRunning) agent.kill();
    }
    this.currentPhase = 'failed';
    log.info('Coordinator: aborted', { id: this.coordId });
  }

  get phase(): string {
    return this.currentPhase;
  }

  get isRunning(): boolean {
    return this.currentPhase !== 'idle' &&
           this.currentPhase !== 'complete' &&
           this.currentPhase !== 'failed';
  }

  get results(): PhaseResult[] {
    return [...this.phaseResults];
  }

  get activeAgents(): { id: string; role: string; running: boolean }[] {
    return [...this._activeAgents.entries()].map(([id, agent]) => ({
      id,
      role: agent.config.role,
      running: agent.isRunning
    }));
  }
}

// -- Inter-phase prompt builders --

function buildSynthesisPrompt(task: string, researchFindings: string): string {
  return `# Task
${task}

# Research Findings
The research agent investigated and produced:

${researchFindings}

# Your Job
Create a detailed step-by-step implementation plan based on the research above. Be specific about files, functions, and changes.`;
}

function buildImplementationPrompt(task: string, plan: string): string {
  return `# Task
${task}

# Implementation Plan
Execute this plan step by step:

${plan}

# Instructions
For each step: read the target file, make the change, verify it works. Report all changes when done.`;
}

function buildVerificationPrompt(task: string, plan: string, implReport: string): string {
  return `# Original Task
${task}

# Plan
${plan}

# Implementation Report
${implReport}

# Your Job
Verify all changes were applied correctly. Read modified files, run tests/builds, check for errors. Report what passed and what needs fixing.`;
}
