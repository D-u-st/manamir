// Autonomous Worker (P-auto) — main loop for autonomous task execution
import { EventEmitter } from 'events';
import { Scheduler } from './scheduler';
import { Heartbeat } from './heartbeat';
import { log } from '../utils/logger';
import type { SessionManager } from '../session/manager';

export interface WorkerOptions {
  /** Channel ID used for autonomous task execution */
  channelId: string;
  /** User ID for autonomous messages */
  userId: string;
  /** Heartbeat tick interval in ms (default 10s) */
  tickIntervalMs: number;
}

const DEFAULTS: WorkerOptions = {
  channelId: '__autonomous__',
  userId: '__system__',
  tickIntervalMs: 10_000
};

export class AutonomousWorker extends EventEmitter {
  private heartbeat: Heartbeat;
  private scheduler: Scheduler;
  private sessionManager: SessionManager;
  private opts: WorkerOptions;
  private running = false;
  private processing = false;
  private consecutiveErrors = 0;

  constructor(
    scheduler: Scheduler,
    sessionManager: SessionManager,
    options: Partial<WorkerOptions> = {}
  ) {
    super();
    this.scheduler = scheduler;
    this.sessionManager = sessionManager;
    this.opts = { ...DEFAULTS, ...options };

    this.heartbeat = new Heartbeat({
      intervalMs: this.opts.tickIntervalMs,
      idleThresholdMs: 300_000
    });

    this.heartbeat.on('tick', () => this.onTick());
    this.heartbeat.on('idle', () => {
      this.emit('idle');
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.heartbeat.start();
    log.info('AutonomousWorker: started', {
      channelId: this.opts.channelId,
      tickIntervalMs: this.opts.tickIntervalMs
    });
    this.emit('started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.heartbeat.stop();
    log.info('AutonomousWorker: stopped');
    this.emit('stopped');
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async onTick(): Promise<void> {
    if (!this.running || this.processing) return;
    if (!this.scheduler.canExecute) return;

    const task = this.scheduler.getNextTask();
    if (!task) return;

    // Run gate checks
    const gatesOk = await this.scheduler.checkGates();
    if (!gatesOk) return;

    this.processing = true;
    this.heartbeat.recordActivity();

    try {
      this.scheduler.markRunning(task.id);
      this.emit('task_start', task);
      log.info('AutonomousWorker: executing task', {
        id: task.id,
        description: task.description.slice(0, 80)
      });

      const result = await this.sessionManager.handleMessage(
        this.opts.channelId,
        this.opts.userId,
        task.description
      );

      this.heartbeat.recordActivity();

      if (result.isError) {
        this.scheduler.markFailed(task.id, result.content);
        this.consecutiveErrors++;
        this.emit('task_error', task, result.content);
      } else {
        this.scheduler.markCompleted(task.id, result.content);
        this.consecutiveErrors = 0;
        this.emit('task_complete', task, result);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.scheduler.markFailed(task.id, errorMsg);
      this.consecutiveErrors++;
      this.emit('task_error', task, errorMsg);
      log.error('AutonomousWorker: task execution threw', { id: task.id, error: errorMsg });
    } finally {
      this.processing = false;

      // Backoff on consecutive failures, then normal pause between tasks
      if (this.running && this.scheduler.pendingCount > 0) {
        if (this.consecutiveErrors > 0) {
          const backoffMs = Math.min(
            this.scheduler.pauseBetweenTasksMs * Math.pow(2, this.consecutiveErrors),
            300_000
          );
          log.info('AutonomousWorker: backing off after failures', {
            consecutiveErrors: this.consecutiveErrors,
            backoffMs
          });
          await this.delay(backoffMs);
        } else {
          await this.delay(this.scheduler.pauseBetweenTasksMs);
        }
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
