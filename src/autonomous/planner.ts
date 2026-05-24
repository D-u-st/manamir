// Task Planner (P-auto) — decomposes a big task into subtasks via LLM
import { log } from '../utils/logger';
import type { SessionManager } from '../session/manager';

export interface SubTask {
  description: string;
  estimatedTurns: number;
  dependencies: string[]; // indices or descriptions of prerequisite subtasks
}

const PLAN_PROMPT = `You are a task planner. Break the following task into 3-7 sequential steps.
Return ONLY a JSON array of objects with these fields:
- "description": string (one clear action sentence)
- "estimatedTurns": number (1-10, how many conversation turns this step likely needs)
- "dependencies": string[] (descriptions of steps that must complete first, empty for the first step)

Task: `;

/**
 * Uses SessionManager to send a planning prompt and parse the subtask list.
 * The session used is a dedicated autonomous channel ("__planner__").
 */
export async function planTask(
  description: string,
  sessionManager: SessionManager,
  userId: string
): Promise<SubTask[]> {
  const prompt = PLAN_PROMPT + description;

  log.info('Planner: decomposing task', { description: description.slice(0, 80) });

  const result = await sessionManager.handleMessage('__planner__', userId, prompt);

  if (result.isError) {
    log.error('Planner: LLM call failed', { error: result.content });
    // Fallback: return the original task as a single step
    return [{
      description,
      estimatedTurns: 5,
      dependencies: []
    }];
  }

  try {
    const parsed = extractJson(result.content);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const subtasks: SubTask[] = parsed.map((item: Record<string, unknown>) => ({
        description: String(item.description ?? ''),
        estimatedTurns: Number(item.estimatedTurns ?? 3),
        dependencies: Array.isArray(item.dependencies)
          ? item.dependencies.map(String)
          : []
      }));
      log.info('Planner: decomposed into subtasks', { count: subtasks.length });
      return subtasks;
    }
  } catch (err) {
    log.error('Planner: failed to parse LLM response', { error: String(err) });
  }

  // Fallback: single task
  return [{
    description,
    estimatedTurns: 5,
    dependencies: []
  }];
}

/** Extract JSON array from LLM response that may contain markdown fences */
function extractJson(text: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // noop
  }

  // Try extracting from markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1].trim());
  }

  // Try finding first [ ... ] block
  const bracketMatch = text.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    return JSON.parse(bracketMatch[0]);
  }

  throw new Error('No JSON array found in response');
}
