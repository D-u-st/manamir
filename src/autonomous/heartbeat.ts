// Tick heartbeat (P-21) — periodic health check for autonomous mode
import { EventEmitter } from 'events';
import type { TaskId, SessionId } from '../types';
import { log } from '../utils/logger';

export interface HeartbeatState {
  lastActivityTime: number;
  currentTaskId: TaskId | null;
  executorRunning: boolean;
  tickCount: number;
}

export interface HeartbeatOptions {
  intervalMs: number;      // heartbeat tick interval (default 30s)
  idleThresholdMs: number; // trigger idle check after this much inactivity (default 5min)
}

const DEFAULTS: HeartbeatOptions = {
  intervalMs: 30_000,
  idleThresholdMs: 300_000
};

export class Heartbeat extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Throttle: only log idle warning once per idle period (reset by recordActivity).
  // Without this, every tick (30s) re-logs the warning indefinitely while idle,
  // producing 14000+ duplicate warnings per 4 hours observed in production.
  private idleAlreadyWarned = false;
  private state: HeartbeatState = {
    lastActivityTime: Date.now(),
    currentTaskId: null,
    executorRunning: false,
    tickCount: 0
  };
  private opts: HeartbeatOptions;

  constructor(options: Partial<HeartbeatOptions> = {}) {
    super();
    this.opts = { ...DEFAULTS, ...options };
  }

  start(): void {
    if (this.timer) return;
    this.state.lastActivityTime = Date.now();
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
    log.info('Heartbeat started', { intervalMs: this.opts.intervalMs });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    log.info('Heartbeat stopped');
  }

  recordActivity(): void {
    this.state.lastActivityTime = Date.now();
    this.idleAlreadyWarned = false;
  }

  setTask(taskId: TaskId | null): void {
    this.state.currentTaskId = taskId;
    if (taskId) this.recordActivity();
  }

  setExecutorRunning(running: boolean): void {
    this.state.executorRunning = running;
    if (running) this.recordActivity();
  }

  getState(): Readonly<HeartbeatState> {
    return { ...this.state };
  }

  private tick(): void {
    this.state.tickCount++;
    const idleMs = Date.now() - this.state.lastActivityTime;

    this.emit('tick', this.state);

    if (idleMs >= this.opts.idleThresholdMs) {
      if (!this.idleAlreadyWarned) {
        log.warn('Idle threshold exceeded', { idleMs, thresholdMs: this.opts.idleThresholdMs });
        this.idleAlreadyWarned = true;
      }
      this.emit('idle', { idleMs, state: this.state });
    }
  }
}
