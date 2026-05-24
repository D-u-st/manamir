// Memory types for persistent cross-session knowledge (v2.1)
// 4 memory types: user, feedback, project, reference

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'ocr-history';

export interface Memory {
  /** Unique name / filename stem */
  name: string;
  /** One-line description used for relevance matching */
  description: string;
  /** Memory category */
  type: MemoryType;
  /** The actual memory content (markdown body) */
  content: string;
  /** When this memory was created */
  createdAt: number;
  /** When this memory was last updated */
  updatedAt: number;
}

export interface MemoryConfig {
  /** Directory for memory .md files */
  dataDir: string;
  /** Max memories to inject into system prompt */
  maxMemoriesInPrompt: number;
}
