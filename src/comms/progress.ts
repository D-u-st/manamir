// AgentSummary progress reporting (P-30)
// Tracks per-task progress and sends periodic updates

import type { TaskId, SessionId } from '../types';

export type TaskStage = 'starting' | 'working' | 'reviewing' | 'done';

export interface TaskProgress {
  taskId: TaskId;
  sessionId: SessionId;
  stage: TaskStage;
  percentage: number;    // 0-100
  currentAction: string;
  startedAt: number;
  updatedAt: number;
}

export interface TaskSummary {
  taskId: TaskId;
  sessionId: SessionId;
  durationMs: number;
  numTurns: number;
  costUsd: number;
  description: string;
  stage: 'done';
}

export type ProgressSink = (formatted: string) => void | Promise<void>;

const UPDATE_INTERVAL_MS = 30_000;

export class ProgressTracker {
  private tasks: Map<string, TaskProgress> = new Map(); // keyed by taskId
  private intervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  private sink: ProgressSink | null = null;

  /** Set the output sink for progress updates */
  setSink(sink: ProgressSink): void {
    this.sink = sink;
  }

  /** Start tracking a new task */
  start(taskId: TaskId, sessionId: SessionId, action: string): void {
    const now = Date.now();
    const progress: TaskProgress = {
      taskId,
      sessionId,
      stage: 'starting',
      percentage: 0,
      currentAction: action,
      startedAt: now,
      updatedAt: now
    };
    this.tasks.set(taskId, progress);

    // Start periodic updates
    const interval = setInterval(() => {
      this.emitUpdate(taskId);
    }, UPDATE_INTERVAL_MS);
    this.intervals.set(taskId, interval);

    this.emitUpdate(taskId);
  }

  /** Update progress for a running task */
  update(taskId: TaskId, stage: TaskStage, percentage: number, action: string): void {
    const progress = this.tasks.get(taskId);
    if (!progress) return;

    progress.stage = stage;
    progress.percentage = Math.min(100, Math.max(0, percentage));
    progress.currentAction = action;
    progress.updatedAt = Date.now();
  }

  /** Mark a task as done and emit a summary */
  async complete(
    taskId: TaskId,
    description: string,
    numTurns: number,
    costUsd: number
  ): Promise<TaskSummary | null> {
    const progress = this.tasks.get(taskId);
    if (!progress) return null;

    // Stop periodic updates
    const interval = this.intervals.get(taskId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(taskId);
    }

    const summary: TaskSummary = {
      taskId,
      sessionId: progress.sessionId,
      durationMs: Date.now() - progress.startedAt,
      numTurns,
      costUsd,
      description,
      stage: 'done'
    };

    this.tasks.delete(taskId);

    if (this.sink) {
      await this.sink(this.formatSummary(summary));
    }

    return summary;
  }

  /** Get current progress for a task */
  get(taskId: TaskId): TaskProgress | undefined {
    return this.tasks.get(taskId);
  }

  /** Get all active task progresses */
  getAll(): TaskProgress[] {
    return [...this.tasks.values()];
  }

  /** Stop all tracking (cleanup) */
  stopAll(): void {
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
    this.tasks.clear();
  }

  private async emitUpdate(taskId: TaskId): Promise<void> {
    const progress = this.tasks.get(taskId);
    if (!progress || !this.sink) return;
    await this.sink(this.formatProgress(progress));
  }

  // Compact format for mobile viewing
  private formatProgress(p: TaskProgress): string {
    const elapsed = this.formatDuration(Date.now() - p.startedAt);
    const bar = this.progressBar(p.percentage);
    return `${this.stageIcon(p.stage)} ${bar} ${p.percentage}% | ${p.currentAction} (${elapsed})`;
  }

  private formatSummary(s: TaskSummary): string {
    const dur = this.formatDuration(s.durationMs);
    const cost = s.costUsd > 0 ? ` | $${s.costUsd.toFixed(3)}` : '';
    return `\u2705 Done: ${s.description}\n   ${dur} | ${s.numTurns} turns${cost}`;
  }

  private stageIcon(stage: TaskStage): string {
    switch (stage) {
      case 'starting': return '\u{1F680}';
      case 'working': return '\u{1F528}';
      case 'reviewing': return '\u{1F50D}';
      case 'done': return '\u2705';
    }
  }

  private progressBar(pct: number): string {
    const filled = Math.round(pct / 10);
    return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
  }

  private formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60}m`;
  }
}
