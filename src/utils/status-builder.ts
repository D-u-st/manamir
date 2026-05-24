// Multi-section status builder. Used by the /status command in CLI + Discord.
//
// Design goal: snapshot every important live counter the harness exposes,
// then render a fixed-width text block that fits in a Discord code fence
// (~1.5K chars budget) without needing pagination.
//
// All inputs are dependency-injected so tests can pass deterministic values.

import { dateKey } from './cost-tracker';
import type { CostTracker } from './cost-tracker';
import type { Scheduler } from '../autonomous/scheduler';
import type { AutonomousWorker } from '../autonomous/worker';
import type { RateLimitTracker } from '../executor/rate-limit-tracker';
import type { MemoryStore } from '../memory/store';
import type { SkillSummary } from '../skills/types';

export interface StatusInputs {
  /** Bootstrap timestamp (ms epoch). */
  startedAt: number;
  /** ms epoch of "now"; defaults to Date.now() if unset (test override). */
  now?: number;
  /** Active session count + persisted session count. */
  activeSessions: number;
  storedSessions: number;
  /** Memory store; we'll bucket by type for the breakdown line. */
  memoryStore?: MemoryStore | null;
  /** Skills (caller passes whatever listSkills() returned). */
  skills?: SkillSummary[];
  /** Scheduler (for queue counts). */
  scheduler?: Scheduler | null;
  /** Autonomous worker (for running flag). */
  worker?: AutonomousWorker | null;
  /** Cost tracker (today + yesterday cost). */
  costTracker?: CostTracker | null;
  /** Rate-limit tracker (for the rate-limit line). */
  rateLimits?: RateLimitTracker | null;
  /** Optional last-error line ("2h ago - Discord WebSocket reconnect"). */
  lastError?: { message: string; ts: number } | null;
  /** Primary + cheap model labels for the Model line. */
  primaryModel: string;
  cheapModel?: string | null;
  /** Bot connected? Drives the "Bot:" line. */
  botOnline: boolean;
}

export interface StatusReport {
  /** Multi-line plain-text rendering, no markdown. */
  text: string;
  /** Same content but with Discord-style ** bold ** for headings. */
  markdown: string;
}

const HEADER_LINE = '================';

export function buildStatus(inputs: StatusInputs): StatusReport {
  const now = inputs.now ?? Date.now();
  const uptimeMs = Math.max(0, now - inputs.startedAt);

  const lines: string[] = [];
  lines.push('Manamir Status');
  lines.push(HEADER_LINE);

  // Bot section
  const botStatus = inputs.botOnline ? 'Online' : 'Offline';
  lines.push(`Bot:        ${botStatus} (uptime ${formatUptime(uptimeMs)})`);

  // Sessions
  lines.push(
    `Sessions:   ${inputs.activeSessions} active, ${inputs.storedSessions} stored`
  );

  // Memory
  const memBreak = formatMemoryBreakdown(inputs.memoryStore);
  lines.push(`Memory:     ${memBreak}`);

  // Skills
  const skillsLine = formatSkillsLine(inputs.skills);
  lines.push(`Skills:     ${skillsLine}`);

  // Worker line
  lines.push('');
  const workerLine = formatWorkerLine(inputs.worker, inputs.scheduler);
  lines.push(`Worker:     ${workerLine}`);

  // Queue line
  const queueLine = formatQueueLine(inputs.scheduler);
  lines.push(`Queue:      ${queueLine}`);

  // Model
  lines.push('');
  const modelLine = formatModelLine(inputs.primaryModel, inputs.cheapModel ?? null);
  lines.push(`Model:      ${modelLine}`);

  // Cost line
  const costLine = formatCostLine(inputs.costTracker, now);
  lines.push(`Cost today: ${costLine}`);

  // Rate limit line
  const rateLine = formatRateLimitLine(inputs.rateLimits, now);
  lines.push(`Rate limit: ${rateLine}`);

  // Last error
  if (inputs.lastError) {
    lines.push('');
    lines.push(
      `Last error: ${formatRelativeTime(inputs.lastError.ts, now)} - ${inputs.lastError.message}`
    );
  }

  const text = lines.join('\n');
  const markdown = buildMarkdown(lines);
  return { text, markdown };
}

// ── Formatters (exported for test reuse) ────────────────────────────────────

export function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}

export function formatRelativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatMemoryBreakdown(memStore: MemoryStore | null | undefined): string {
  if (!memStore) return '0 entries';
  let memories;
  try {
    memories = memStore.load();
  } catch {
    return '0 entries (load failed)';
  }
  const counts: Record<string, number> = {};
  for (const m of memories) {
    counts[m.type] = (counts[m.type] ?? 0) + 1;
  }
  const total = memories.length;
  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
  if (total === 0) return '0 entries';
  return `${total} entries (${breakdown})`;
}

function formatSkillsLine(skills: SkillSummary[] | undefined): string {
  if (!skills || skills.length === 0) return '0 installed';
  // Buckets: those whose path is "user/..." vs "system/..." vs other.
  let user = 0;
  let system = 0;
  for (const s of skills) {
    const path = (s.path || '').toLowerCase();
    if (path.startsWith('user/') || path.startsWith('user\\')) user++;
    else if (path.startsWith('system/') || path.startsWith('system\\')) system++;
  }
  const other = skills.length - user - system;
  const buckets: string[] = [];
  if (user > 0) buckets.push(`${user} user`);
  if (system > 0) buckets.push(`${system} system`);
  if (other > 0) buckets.push(`${other} other`);
  const tail = buckets.length > 0 ? ` (${buckets.join(', ')})` : '';
  return `${skills.length} installed${tail}`;
}

function formatWorkerLine(
  worker: AutonomousWorker | null | undefined,
  scheduler: Scheduler | null | undefined
): string {
  if (!worker) return 'Not initialized';
  const status = worker.isRunning ? 'Running' : 'Stopped';
  if (!scheduler) return status;
  const max = scheduler.maxTasksPerHour > 0 ? `/${scheduler.maxTasksPerHour}` : '';
  const used = scheduler.tasksStartedLastHour;
  return `${status}, ${used}${max} tasks this hour`;
}

function formatQueueLine(scheduler: Scheduler | null | undefined): string {
  if (!scheduler) return '0 running, 0 pending, 0 failed';
  const tasks = scheduler.listTasks();
  let running = 0;
  let pending = 0;
  let failed = 0;
  for (const t of tasks) {
    if (t.status === 'running') running++;
    else if (t.status === 'pending') pending++;
    else if (t.status === 'failed') failed++;
  }
  return `${running} running, ${pending} pending, ${failed} failed`;
}

function formatModelLine(primary: string, cheap: string | null): string {
  const cheapPart = cheap && cheap !== primary ? `, ${cheap} (cheap)` : '';
  return `${primary} (primary)${cheapPart}`;
}

function formatCostLine(tracker: CostTracker | null | undefined, now: number): string {
  if (!tracker) return 'unavailable';
  const today = tracker.summarize(dateKey(now), 1);
  const inK = (today.inputTokens / 1000).toFixed(1);
  const outK = (today.outputTokens / 1000).toFixed(1);
  return `$${today.costUsd.toFixed(2)} (${inK}K input, ${outK}K output tokens)`;
}

function formatRateLimitLine(
  tracker: RateLimitTracker | null | undefined,
  now: number
): string {
  if (!tracker) return 'unavailable';
  const snap = tracker.getSnapshot();
  if (!snap.lastUpdated) return 'no data yet';
  const remaining = snap.requestsRemaining;
  const resetAt = snap.requestsResetAt;
  if (remaining === undefined) return 'no data yet';
  if (resetAt === undefined) return `${remaining} req remaining`;
  const minsLeft = Math.max(0, Math.round((resetAt - now) / 60_000));
  return `${remaining} req remaining (resets in ${minsLeft}m)`;
}

function buildMarkdown(plainLines: string[]): string {
  // Bold the title and underline-line.
  const out: string[] = [];
  for (const line of plainLines) {
    if (line === 'Manamir Status') {
      out.push('**Manamir Status**');
      continue;
    }
    if (line === HEADER_LINE) continue; // drop in markdown — bold title is enough
    out.push(line);
  }
  return out.join('\n');
}
