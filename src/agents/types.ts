// Agent type definitions (P-10, P-27, P-34)

export interface AgentConfig {
  id: string;
  name: string;
  role: string;           // e.g. 'researcher', 'implementer', 'reviewer'
  systemPrompt: string;   // role-specific instructions
  tools: string[];        // which tools this agent can use (empty = all)
  maxTurns: number;
}

export interface AgentResult {
  agentId: string;
  content: string;
  toolsUsed: string[];
  turns: number;
  durationMs: number;
  isError: boolean;
}

export type CoordinatorPhase = 'research' | 'synthesis' | 'implementation' | 'verification';

export interface PhaseResult {
  phase: CoordinatorPhase;
  agentId: string;
  result: AgentResult;
}

export interface CoordinatorResult {
  task: string;
  phases: PhaseResult[];
  finalContent: string;
  totalDurationMs: number;
  success: boolean;
}

export interface MailboxMessage {
  id: string;
  fromId: string;
  toId: string;        // '*' for broadcast
  content: string;
  timestamp: number;
  read: boolean;
}
