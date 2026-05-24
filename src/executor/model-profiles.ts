// Per-model behavior profiles
// Different models need different constraints to work well in the agent loop.

export interface ModelProfile {
  maxTurns: number;
  systemPromptHints: string;
  firstTurnToolsOnly: string[] | null;  // null = all tools
  aggressiveToolUse: boolean;  // if true, add "only use tools when explicitly needed"
  behaviorPrompt: string;  // model-specific behavioral directives injected into system prompt
}

const DEEPSEEK_BEHAVIOR = `# DeepSeek Efficiency Directives (MANDATORY)
- NEVER use more than 3 tool calls for simple tasks. Most tasks need 1-2 calls.
- Combine operations into single bash commands with && instead of multiple separate calls.
- Do NOT verify your own work — if you wrote a file, trust it was written. Do not read it back.
- Do NOT explore the filesystem before acting. If told to write X to file Y, just write it.
- Keep responses to 1-3 sentences. No lengthy explanations unless asked.
- When reading a file before editing, use offset/limit to read only the relevant section.`;

const GPT_BEHAVIOR = `# GPT Behavioral Directives

<tool_persistence>
If a tool call fails or returns unexpected results, retry with corrected parameters before giving up.
Never say "I can't" without first attempting the operation with tools.
</tool_persistence>

<mandatory_tool_use>
For any task involving files, processes, or system state: you MUST use tools to accomplish it.
Never simulate or imagine tool output. Always execute and report real results.
</mandatory_tool_use>

<act_dont_ask>
When the user gives a clear instruction, execute it immediately. Do not ask for confirmation.
Only ask clarifying questions when the request is genuinely ambiguous.
</act_dont_ask>

<prerequisite_checks>
Before modifying a file, read it first to understand current state.
Before running a destructive command, verify the target exists.
</prerequisite_checks>

<verification>
After multi-step operations, verify the final state matches expectations.
Report what changed and what the current state is.
</verification>

<missing_context>
If you lack information needed to complete a task, use tools to discover it (grep, glob, read).
Do not guess at file paths, config values, or system state.
</missing_context>`;

const GEMINI_BEHAVIOR = `# Gemini Behavioral Directives
- Always use absolute paths. Never use relative paths like ./file or ../dir.
- Verify file existence before editing — read first, then write.
- When multiple independent operations are needed, describe them all clearly.
- Always use non-interactive flags for commands (e.g. -y, --yes, --non-interactive).
- Do not use interactive editors (vim, nano) — use the write tool instead.
- Prefer structured output: use explicit section headers in responses.`;

const CLAUDE_BEHAVIOR = '';

const PROFILES: Record<string, ModelProfile> = {
  'deepseek-chat': {
    maxTurns: 8,
    systemPromptHints: 'Be concise. Finish tasks in as few steps as possible. Always provide a final text summary.',
    firstTurnToolsOnly: ['bash', 'read'],
    aggressiveToolUse: true,
    behaviorPrompt: DEEPSEEK_BEHAVIOR
  },
  'deepseek-reasoner': {
    maxTurns: 6,
    systemPromptHints: 'Think step by step. Use tools only when necessary. Provide a clear final answer.',
    firstTurnToolsOnly: ['bash', 'read'],
    aggressiveToolUse: true,
    behaviorPrompt: DEEPSEEK_BEHAVIOR
  },
  'claude-sonnet': {
    maxTurns: 15,
    systemPromptHints: '',
    firstTurnToolsOnly: null,
    aggressiveToolUse: false,
    behaviorPrompt: CLAUDE_BEHAVIOR
  },
  'claude-opus': {
    maxTurns: 15,
    systemPromptHints: '',
    firstTurnToolsOnly: null,
    aggressiveToolUse: false,
    behaviorPrompt: CLAUDE_BEHAVIOR
  },
  'gpt-4o': {
    maxTurns: 12,
    systemPromptHints: 'Be efficient with tool usage. Summarize results clearly.',
    firstTurnToolsOnly: null,
    aggressiveToolUse: false,
    behaviorPrompt: GPT_BEHAVIOR
  },
  'gpt-4': {
    maxTurns: 12,
    systemPromptHints: 'Be efficient with tool usage. Summarize results clearly.',
    firstTurnToolsOnly: null,
    aggressiveToolUse: false,
    behaviorPrompt: GPT_BEHAVIOR
  },
  'o1': {
    maxTurns: 10,
    systemPromptHints: '',
    firstTurnToolsOnly: null,
    aggressiveToolUse: false,
    behaviorPrompt: GPT_BEHAVIOR
  },
  'o3': {
    maxTurns: 10,
    systemPromptHints: '',
    firstTurnToolsOnly: null,
    aggressiveToolUse: false,
    behaviorPrompt: GPT_BEHAVIOR
  },
  'gemini': {
    maxTurns: 12,
    systemPromptHints: 'Be precise and action-oriented.',
    firstTurnToolsOnly: null,
    aggressiveToolUse: false,
    behaviorPrompt: GEMINI_BEHAVIOR
  }
};

const DEFAULT_PROFILE: ModelProfile = {
  maxTurns: 10,
  systemPromptHints: '',
  firstTurnToolsOnly: null,
  aggressiveToolUse: false,
  behaviorPrompt: ''
};

/** Get model profile by name. Matches by prefix (e.g. "deepseek-chat-v3" → "deepseek-chat"). */
export function getModelProfile(modelName: string): ModelProfile {
  // Exact match first
  if (PROFILES[modelName]) return PROFILES[modelName];

  // Prefix match: longest matching key wins
  let bestMatch: string | null = null;
  for (const key of Object.keys(PROFILES)) {
    if (modelName.startsWith(key)) {
      if (!bestMatch || key.length > bestMatch.length) {
        bestMatch = key;
      }
    }
  }

  return bestMatch ? PROFILES[bestMatch] : DEFAULT_PROFILE;
}
