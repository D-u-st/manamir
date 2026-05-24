// Task Scheduler (P-auto) — manages autonomous task queue with gate-checked execution
import { EventEmitter } from 'events';
import { GateChain } from './gate-chain';
import { log } from '../utils/logger';
import { TaskStore } from './task-store';

export type AutoTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AutoTask {
  id: string;
  description: string;
  priority: number; // lower = higher priority
  status: AutoTaskStatus;
  createdAt: number;
  scheduledAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  result: string | null;
  error: string | null;
  parentId: string | null;
  metadata?: Record<string, unknown>;
}

export interface SchedulerOptions {
  maxConcurrentTasks?: number;
  pauseBetweenTasksMs?: number;
  /** Optional persistent store. When set, all task state changes are durable. */
  store?: TaskStore | null;
  /** Per-hour cap on task starts. <= 0 disables. */
  maxTasksPerHour?: number;
  /** When false, gate checks are skipped (still callable for diagnostics). */
  requireGate?: boolean;
}

const DEFAULTS: Required<Omit<SchedulerOptions, 'store'>> = {
  maxConcurrentTasks: 1,
  pauseBetweenTasksMs: 5000,
  maxTasksPerHour: 0,
  requireGate: true
};

let autoTaskCounter = 0;

export class Scheduler extends EventEmitter {
  private tasks = new Map<string, AutoTask>();
  private opts: Required<Omit<SchedulerOptions, 'store'>>;
  private gateChain: GateChain;
  private runningCount = 0;
  private paused = false;
  private store: TaskStore | null;
  private startTimestamps: number[] = [];

  constructor(
    gateChain: GateChain,
    options: SchedulerOptions = {}
  ) {
    super();
    const { store, ...rest } = options;
    this.opts = { ...DEFAULTS, ...rest };
    this.gateChain = gateChain;
    this.store = store ?? null;

    // Restore any pre-existing tasks from disk.
    if (this.store) {
      for (const task of this.store.getAll()) {
        this.tasks.set(task.id, task);
      }
    }
  }

  addTask(
    description: string,
    options: {
      priority?: number;
      scheduledAt?: number;
      parentId?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): AutoTask {
    const id = `auto_${++autoTaskCounter}_${Date.now()}`;

    const task: AutoTask = {
      id,
      description,
      priority: options.priority ?? 100,
      status: 'pending',
      createdAt: Date.now(),
      scheduledAt: options.scheduledAt ?? null,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      parentId: options.parentId ?? null,
      metadata: options.metadata
    };

    this.tasks.set(id, task);
    this.store?.recordAdd(task);
    this.emit('task_added', task);
    log.info('Scheduler: task added', { id, description: description.slice(0, 80), priority: task.priority });

    return task;
  }

  /** Get the next pending task by priority, respecting scheduledAt */
  getNextTask(): AutoTask | null {
    const now = Date.now();
    const pending = [...this.tasks.values()]
      .filter(t =>
        t.status === 'pending' &&
        (t.scheduledAt === null || t.scheduledAt <= now)
      )
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

    return pending[0] ?? null;
  }

  /** Run gate checks before executing a task. Honours requireGate. */
  async checkGates(): Promise<boolean> {
    if (!this.opts.requireGate) return true;
    const result = await this.gateChain.run();
    if (!result.passed) {
      log.info('Scheduler: gate blocked', { failedGate: result.failedGate });
    }
    return result.passed;
  }

  /** Mark a task as running */
  markRunning(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending') return false;

    const startedAt = Date.now();
    task.status = 'running';
    task.startedAt = startedAt;
    this.runningCount++;
    this.startTimestamps.push(startedAt);
    this.pruneStartTimestamps(startedAt);
    this.store?.recordUpdate(taskId, { status: 'running', startedAt });
    this.emit('task_start', task);
    log.info('Scheduler: task started', { id: taskId });
    return true;
  }

  /** Mark a task as completed with result */
  markCompleted(taskId: string, result: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;

    const completedAt = Date.now();
    task.status = 'completed';
    task.completedAt = completedAt;
    task.result = result;
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.store?.recordUpdate(taskId, { status: 'completed', completedAt, result });
    this.emit('task_complete', task);
    log.info('Scheduler: task completed', {
      id: taskId,
      durationMs: completedAt - (task.startedAt ?? task.createdAt)
    });
    return true;
  }

  /** Mark a task as failed */
  markFailed(taskId: string, error: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;

    const completedAt = Date.now();
    task.status = 'failed';
    task.completedAt = completedAt;
    task.error = error;
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.store?.recordUpdate(taskId, { status: 'failed', completedAt, error });
    this.emit('task_error', task);
    log.error('Scheduler: task failed', { id: taskId, error });
    return true;
  }

  /** Cancel a pending or running task */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return false;
    }

    const wasRunning = task.status === 'running';
    const completedAt = Date.now();
    task.status = 'cancelled';
    task.completedAt = completedAt;
    if (wasRunning) {
      this.runningCount = Math.max(0, this.runningCount - 1);
    }

    this.store?.recordUpdate(taskId, { status: 'cancelled', completedAt });
    this.emit('task_cancelled', task);
    log.info('Scheduler: task cancelled', { id: taskId });
    return true;
  }

  getTask(taskId: string): AutoTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(statusFilter?: AutoTaskStatus): AutoTask[] {
    const all = [...this.tasks.values()];
    if (statusFilter) {
      return all.filter(t => t.status === statusFilter);
    }
    return all;
  }

  get canExecute(): boolean {
    if (this.paused) return false;
    if (this.runningCount >= this.opts.maxConcurrentTasks) return false;
    if (this.opts.maxTasksPerHour > 0) {
      this.pruneStartTimestamps(Date.now());
      if (this.startTimestamps.length >= this.opts.maxTasksPerHour) return false;
    }
    return true;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** How many task starts have happened in the last rolling hour. */
  get tasksStartedLastHour(): number {
    this.pruneStartTimestamps(Date.now());
    return this.startTimestamps.length;
  }

  get maxTasksPerHour(): number {
    return this.opts.maxTasksPerHour;
  }

  get pendingCount(): number {
    return [...this.tasks.values()].filter(t => t.status === 'pending').length;
  }

  get activeCount(): number {
    return this.runningCount;
  }

  get pauseBetweenTasksMs(): number {
    return this.opts.pauseBetweenTasksMs;
  }

  pause(): void {
    this.paused = true;
    log.info('Scheduler: paused');
  }

  resume(): void {
    this.paused = false;
    log.info('Scheduler: resumed');
  }

  /** Prune completed/failed/cancelled tasks older than maxAge */
  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [id, task] of this.tasks) {
      if (
        (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') &&
        task.completedAt !== null &&
        task.completedAt < cutoff
      ) {
        this.tasks.delete(id);
        this.store?.recordDelete(id);
        pruned++;
      }
    }
    return pruned;
  }

  private pruneStartTimestamps(now: number): void {
    const cutoff = now - 3_600_000;
    while (this.startTimestamps.length > 0 && this.startTimestamps[0] < cutoff) {
      this.startTimestamps.shift();
    }
  }
}
