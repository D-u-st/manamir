// Command handler — /status, /tools, /stop, /reset, /history, /ws, /task, /auto, /cost, /cron
// Extracted from index.ts

import { state, stateSnapshot } from '../core/state';
import { getAllTools } from '../tools';
import { planTask } from '../autonomous/planner';
import { AgentCoordinator, type CoordinatorOptions } from '../agents/coordinator';
import { runDoctor, formatDoctorResults } from '../tools/doctor';
import { buildStatus } from '../utils/status-builder';
import { dateKey } from '../utils/cost-tracker';
import { getCheapModel } from '../executor/cheap-router';
import type { IncomingMessage } from '../channel/types';
import type { DiscordChannel } from '../channel/discord';
import type { SessionManager } from '../session/manager';
import type { Scheduler } from '../autonomous/scheduler';
import type { AutonomousWorker } from '../autonomous/worker';
import type { Cron } from '../autonomous/cron';
import type { UserCron } from '../autonomous/user-cron';
import type { WsServer } from '../comms/ws-server';
import type { PermissionManager, PermissionLevel } from '../security/permissions';
import type { ManamirConfig } from '../config';
import type { CostTracker } from '../utils/cost-tracker';
import type { MemoryStore } from '../memory/store';

export interface CommandHandlerDeps {
  sessionManager: SessionManager;
  discord: DiscordChannel;
  config: ManamirConfig;
  getWsServer: () => WsServer | null;
  getScheduler: () => Scheduler | null;
  getAutonomousWorker: () => AutonomousWorker | null;
  getCron: () => Cron | null;
  getPermissions: () => PermissionManager | null;
  getUserCron?: () => UserCron | null;
  getCostTracker?: () => CostTracker | null;
  getMemoryStore?: () => MemoryStore | null;
}

export function createCommandHandler(deps: CommandHandlerDeps) {
  const {
    sessionManager,
    discord,
    config,
    getWsServer,
    getScheduler,
    getAutonomousWorker,
    getCron,
    getPermissions,
    getUserCron,
    getCostTracker,
    getMemoryStore
  } = deps;

  // Active coordinators tracked for /agent list
  const activeCoordinators = new Map<string, AgentCoordinator>();

  /** Check permission; returns true if denied (and sends denial message) */
  const guardPerm = async (msg: IncomingMessage, action: Parameters<PermissionManager['guard']>[1]): Promise<boolean> => {
    const perms = getPermissions();
    if (!perms) return false; // no permission system = allow all
    const denial = perms.guard(msg.userId, action);
    if (denial) {
      await discord.send({ channelId: msg.channelId, content: denial });
      return true;
    }
    return false;
  };

  return async (msg: IncomingMessage): Promise<void> => {
    const parts = msg.content.split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case '/status': {
        let skills: Array<{ name: string; description: string; path: string }> = [];
        try {
          const { listSkills } = await import('../skills/store');
          skills = listSkills();
        } catch {
          skills = [];
        }
        const storedSessions = sessionManager.historyStore.listSessions().length;
        const memoryStore = getMemoryStore?.() ?? null;
        const costTracker = getCostTracker?.() ?? null;
        const report = buildStatus({
          startedAt: state.startedAt,
          activeSessions: sessionManager.stats.activeSessions,
          storedSessions,
          memoryStore,
          skills,
          scheduler: getScheduler(),
          worker: getAutonomousWorker(),
          costTracker,
          rateLimits: null,
          primaryModel: config.executor.model || config.claude.model || 'unknown',
          cheapModel: getCheapModel(),
          botOnline: true
        });
        await discord.send({
          channelId: msg.channelId,
          content: '```\n' + report.text + '\n```'
        });
        break;
      }
      case '/cost': {
        const tracker = getCostTracker?.();
        if (!tracker) {
          await discord.send({ channelId: msg.channelId, content: 'Cost tracking not initialized.' });
          break;
        }
        const sub = (parts[1] || 'today').toLowerCase();
        if (sub === 'reset') {
          if (await guardPerm(msg, 'manage_permissions')) break;
          if (parts[2] !== '--confirm') {
            await discord.send({ channelId: msg.channelId, content: 'Add `--confirm` to wipe cost history.' });
            break;
          }
          tracker.reset();
          await discord.send({ channelId: msg.channelId, content: 'Cost history reset.' });
          break;
        }
        const today = dateKey(Date.now());
        if (sub === 'week') {
          const block = tracker.formatSummary(today, 7, 'Last 7 days');
          await discord.send({ channelId: msg.channelId, content: '```\n' + block + '\n```' });
          break;
        }
        if (sub === 'month') {
          const block = tracker.formatSummary(today, 30, 'Last 30 days');
          await discord.send({ channelId: msg.channelId, content: '```\n' + block + '\n```' });
          break;
        }
        const todayBlock = tracker.formatSummary(today, 1, `Today (${today})`);
        const yesterday = dateKey(Date.now() - 86_400_000);
        const cmp = tracker.compareDays(yesterday, today);
        const arrow = cmp.deltaUsd > 0 ? '+' : '';
        const cmpLine = cmp.earlierUsd > 0
          ? `\n  Compared to yesterday: ${arrow}${cmp.deltaPct.toFixed(0)}%`
          : '';
        const week = tracker.summarize(today, 7).costUsd;
        const month = tracker.summarize(today, 30).costUsd;
        const body =
          `${todayBlock}${cmpLine}\n\nWeek total:  $${week.toFixed(2)}\nMonth total: $${month.toFixed(2)}`;
        await discord.send({ channelId: msg.channelId, content: '```\n' + body + '\n```' });
        break;
      }

      case '/tools': {
        const tools = getAllTools();
        const list = tools.map(t => `- **${t.name}** — ${t.description} ${t.readonly ? '(read-only)' : '(write)'}`);
        await discord.send({
          channelId: msg.channelId,
          content: `**Available Tools (${tools.length})**\n${list.join('\n')}`
        });
        break;
      }

      case '/stop': {
        const interrupted = sessionManager.interruptSession(msg.channelId);
        await discord.send({
          channelId: msg.channelId,
          content: interrupted ? 'Session interrupted.' : 'No active session.'
        });
        break;
      }

      case '/reset': {
        sessionManager.destroySession(msg.channelId);
        await discord.send({
          channelId: msg.channelId,
          content: 'Session destroyed. Next message starts fresh.'
        });
        break;
      }

      case '/history': {
        const session = sessionManager.getSession(msg.channelId);
        if (!session) {
          await discord.send({ channelId: msg.channelId, content: 'No active session.' });
          break;
        }
        const history = session.getHistory(10);
        const summary = history.map(m =>
          `[${m.role}] ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`
        ).join('\n');
        await discord.send({
          channelId: msg.channelId,
          content: summary || 'No messages yet.'
        });
        break;
      }

      case '/ws': {
        const wsServer = getWsServer();
        const port = wsServer?.getPort() ?? 'N/A';
        await discord.send({
          channelId: msg.channelId,
          content: [
            '**WebSocket Server**',
            `Port: ${port}`,
            `Status: ${wsServer ? 'running' : 'stopped'}`,
            `Endpoint: ws://localhost:${port}/ws`
          ].join('\n')
        });
        break;
      }

      case '/task': {
        if (await guardPerm(msg, 'manage_tasks')) break;
        const scheduler = getScheduler();
        const subCmd = parts[1];
        if (!scheduler) {
          await discord.send({ channelId: msg.channelId, content: 'Scheduler not initialized.' });
          break;
        }

        if (subCmd === 'add') {
          const description = parts.slice(2).join(' ');
          if (!description) {
            await discord.send({ channelId: msg.channelId, content: 'Usage: /task add <description>' });
            break;
          }
          const task = scheduler.addTask(description);
          await discord.send({
            channelId: msg.channelId,
            content: `Task queued: **${task.id}**\n> ${description}`
          });
        } else if (subCmd === 'plan') {
          const description = parts.slice(2).join(' ');
          if (!description) {
            await discord.send({ channelId: msg.channelId, content: 'Usage: /task plan <description>' });
            break;
          }
          await discord.send({ channelId: msg.channelId, content: 'Planning task decomposition...' });
          const subtasks = await planTask(description, sessionManager, msg.userId);
          for (const st of subtasks) {
            scheduler.addTask(st.description);
          }
          const list = subtasks.map((st, i) => `${i + 1}. ${st.description} (~${st.estimatedTurns} turns)`).join('\n');
          await discord.send({
            channelId: msg.channelId,
            content: `**Planned ${subtasks.length} subtasks:**\n${list}`
          });
        } else if (subCmd === 'list') {
          const tasks = scheduler.listTasks();
          if (tasks.length === 0) {
            await discord.send({ channelId: msg.channelId, content: 'No tasks.' });
            break;
          }
          const lines = tasks.map(t =>
            `\`${t.id}\` [${t.status}] P${t.priority} — ${t.description.slice(0, 60)}`
          );
          await discord.send({
            channelId: msg.channelId,
            content: `**Tasks (${tasks.length})**\n${lines.join('\n')}`
          });
        } else if (subCmd === 'cancel') {
          const targetId = parts[2];
          if (!targetId) {
            await discord.send({ channelId: msg.channelId, content: 'Usage: /task cancel <id>' });
            break;
          }
          const cancelled = scheduler.cancelTask(targetId);
          await discord.send({
            channelId: msg.channelId,
            content: cancelled ? `Task ${targetId} cancelled.` : `Task ${targetId} not found or already done.`
          });
        } else {
          await discord.send({
            channelId: msg.channelId,
            content: 'Usage: /task add|plan|list|cancel'
          });
        }
        break;
      }

      case '/auto': {
        const autonomousWorker = getAutonomousWorker();
        const scheduler = getScheduler();
        const subCmd = parts[1];
        if (!autonomousWorker || !scheduler) {
          await discord.send({ channelId: msg.channelId, content: 'Autonomous worker not initialized.' });
          break;
        }

        if (subCmd === 'start') {
          if (await guardPerm(msg, 'auto_start')) break;
          if (autonomousWorker.isRunning) {
            await discord.send({ channelId: msg.channelId, content: 'Autonomous worker is already running.' });
          } else {
            autonomousWorker.start();
            await discord.send({ channelId: msg.channelId, content: 'Autonomous worker started.' });
          }
        } else if (subCmd === 'stop') {
          if (await guardPerm(msg, 'auto_stop')) break;
          if (!autonomousWorker.isRunning) {
            await discord.send({ channelId: msg.channelId, content: 'Autonomous worker is not running.' });
          } else {
            autonomousWorker.stop();
            await discord.send({ channelId: msg.channelId, content: 'Autonomous worker stopped.' });
          }
        } else if (subCmd === 'add') {
          if (await guardPerm(msg, 'manage_tasks')) break;
          const description = parts.slice(2).join(' ');
          if (!description) {
            await discord.send({ channelId: msg.channelId, content: 'Usage: `/auto add <prompt>`' });
            break;
          }
          const t = scheduler.addTask(description);
          await discord.send({
            channelId: msg.channelId,
            content: `Queued autonomous task **${t.id}**\n> ${description.slice(0, 200)}`
          });
        } else if (subCmd === 'list') {
          const tasks = scheduler.listTasks();
          if (tasks.length === 0) {
            await discord.send({ channelId: msg.channelId, content: 'No tasks queued.' });
            break;
          }
          const lines = tasks.slice(0, 25).map(t =>
            `\`${t.id}\` [${t.status}] P${t.priority} — ${t.description.slice(0, 60)}`
          );
          const more = tasks.length > 25 ? `\n_(showing 25 of ${tasks.length})_` : '';
          await discord.send({
            channelId: msg.channelId,
            content: `**Tasks (${tasks.length})**\n${lines.join('\n')}${more}`
          });
        } else if (subCmd === 'cancel') {
          if (await guardPerm(msg, 'manage_tasks')) break;
          const id = parts[2];
          if (!id) {
            await discord.send({ channelId: msg.channelId, content: 'Usage: `/auto cancel <id>`' });
            break;
          }
          const ok = scheduler.cancelTask(id);
          await discord.send({
            channelId: msg.channelId,
            content: ok ? `Task ${id} cancelled.` : `Task ${id} not found or already done.`
          });
        } else if (subCmd === 'pause') {
          if (await guardPerm(msg, 'auto_stop')) break;
          scheduler.pause();
          await discord.send({ channelId: msg.channelId, content: 'Scheduler paused (worker keeps polling but holds tasks).' });
        } else if (subCmd === 'resume') {
          if (await guardPerm(msg, 'auto_start')) break;
          scheduler.resume();
          await discord.send({ channelId: msg.channelId, content: 'Scheduler resumed.' });
        } else if (subCmd === 'status' || subCmd === undefined) {
          const tasks = scheduler.listTasks();
          let pending = 0, running = 0, done = 0, failed = 0, cancelled = 0;
          for (const t of tasks) {
            if (t.status === 'pending') pending++;
            else if (t.status === 'running') running++;
            else if (t.status === 'completed') done++;
            else if (t.status === 'failed') failed++;
            else if (t.status === 'cancelled') cancelled++;
          }
          const rateMax = scheduler.maxTasksPerHour > 0 ? String(scheduler.maxTasksPerHour) : 'inf';
          await discord.send({
            channelId: msg.channelId,
            content: [
              '**Autonomous Mode**',
              `Worker: ${autonomousWorker.isRunning ? 'running' : 'stopped'} (paused=${scheduler.isPaused})`,
              `Queue: pending=${pending} running=${running} done=${done} failed=${failed} cancelled=${cancelled}`,
              `Rate: ${scheduler.tasksStartedLastHour}/${rateMax} per hour`
            ].join('\n')
          });
        } else {
          await discord.send({
            channelId: msg.channelId,
            content: 'Usage: `/auto add|list|cancel|pause|resume|start|stop|status`'
          });
        }
        break;
      }

      case '/cron': {
        if (await guardPerm(msg, 'cron_manage')) break;
        const cron = getCron();
        const userCron = getUserCron?.() ?? null;
        const subCmd = parts[1];

        if (subCmd === 'add') {
          // Format: /cron add <name> <m> <h> <d> <mo> <dow> <prompt...>
          if (!userCron) {
            await discord.send({ channelId: msg.channelId, content: 'User cron not initialized.' });
            break;
          }
          if (parts.length < 9) {
            await discord.send({
              channelId: msg.channelId,
              content: 'Usage: `/cron add <name> <m> <h> <d> <mo> <dow> <prompt>` (e.g. `/cron add daily-check 0 8 * * * 检查 nginx 错误`)'
            });
            break;
          }
          const name = parts[2];
          const schedule = parts.slice(3, 8).join(' ');
          const prompt = parts.slice(8).join(' ');
          const ok = userCron.add(name, schedule, prompt);
          await discord.send({
            channelId: msg.channelId,
            content: ok
              ? `Cron entry **${name}** added (\`${schedule}\`).`
              : `Failed: invalid schedule expression \`${schedule}\` or missing fields.`
          });
        } else if (subCmd === 'list') {
          const userEntries = userCron?.list() ?? [];
          const sysJobs = cron?.listJobs() ?? [];
          if (userEntries.length === 0 && sysJobs.length === 0) {
            await discord.send({ channelId: msg.channelId, content: 'No cron entries.' });
            break;
          }
          const lines: string[] = [];
          if (userEntries.length > 0) {
            lines.push(`**User cron (${userEntries.length})**`);
            for (const e of userEntries) {
              const next = e.nextRunAt ? new Date(e.nextRunAt).toISOString() : 'unknown';
              lines.push(`\`${e.name}\` [${e.enabled ? 'on' : 'off'}] \`${e.schedule}\` next=${next} runs=${e.runCount ?? 0}`);
              lines.push(`  > ${e.prompt.slice(0, 100)}`);
            }
          }
          if (sysJobs.length > 0) {
            if (lines.length > 0) lines.push('');
            lines.push(`**System cron (${sysJobs.length})**`);
            for (const j of sysJobs) {
              const lastRun = j.lastRunTime ? new Date(j.lastRunTime).toISOString() : 'never';
              const nextRun = new Date(j.nextRunTime).toISOString();
              lines.push(`\`${j.name}\` — every ${formatDuration(j.intervalMs)} | runs: ${j.runCount} | last: ${lastRun} | next: ${nextRun}`);
            }
          }
          await discord.send({ channelId: msg.channelId, content: lines.join('\n') });
        } else if (subCmd === 'remove') {
          const name = parts[2];
          if (!name) {
            await discord.send({ channelId: msg.channelId, content: 'Usage: `/cron remove <name>`' });
            break;
          }
          const removedUser = userCron?.remove(name) ?? false;
          if (removedUser) {
            await discord.send({ channelId: msg.channelId, content: `User cron entry \`${name}\` removed.` });
            break;
          }
          if (cron?.getJob(name)) {
            cron.removeJob(name);
            await discord.send({ channelId: msg.channelId, content: `System cron job \`${name}\` removed.` });
          } else {
            await discord.send({ channelId: msg.channelId, content: `Cron entry \`${name}\` not found.` });
          }
        } else {
          await discord.send({
            channelId: msg.channelId,
            content: 'Usage: `/cron add <name> <m> <h> <d> <mo> <dow> <prompt>` | `/cron list` | `/cron remove <name>`'
          });
        }
        break;
      }

      case '/perm': {
        if (await guardPerm(msg, 'manage_permissions')) break;
        const perms = getPermissions();
        const subCmd = parts[1];
        if (!perms) {
          await discord.send({ channelId: msg.channelId, content: 'Permission system not initialized.' });
          break;
        }

        if (subCmd === 'list') {
          const users = perms.listUsers();
          if (users.length === 0) {
            await discord.send({ channelId: msg.channelId, content: 'No user permissions configured.' });
            break;
          }
          const lines = users.map(u => `\`${u.userId}\` — ${u.level}`);
          await discord.send({
            channelId: msg.channelId,
            content: `**User Permissions**\n${lines.join('\n')}`
          });
        } else if (subCmd === 'set') {
          const targetUser = parts[2];
          const level = parts[3] as PermissionLevel | undefined;
          if (!targetUser || !level || !['admin', 'user', 'readonly'].includes(level)) {
            await discord.send({ channelId: msg.channelId, content: 'Usage: /perm set <userId> <admin|user|readonly>' });
            break;
          }
          perms.setLevel(targetUser, level);
          await discord.send({ channelId: msg.channelId, content: `Set \`${targetUser}\` to \`${level}\`.` });
        } else if (subCmd === 'check') {
          const targetUser = parts[2] || msg.userId;
          const level = perms.getLevel(targetUser);
          await discord.send({ channelId: msg.channelId, content: `User \`${targetUser}\`: \`${level}\`` });
        } else {
          await discord.send({
            channelId: msg.channelId,
            content: 'Usage: /perm list|set <userId> <level>|check [userId]'
          });
        }
        break;
      }

      case '/agent': {
        if (await guardPerm(msg, 'manage_tasks')) break;
        const subCmd = parts[1];

        if (subCmd === 'spawn') {
          // /agent spawn <role> <task...>
          const role = parts[2];
          const taskDesc = parts.slice(3).join(' ');
          if (!role || !taskDesc) {
            await discord.send({ channelId: msg.channelId, content: 'Usage: /agent spawn <role> <task>' });
            break;
          }

          const coordOpts: CoordinatorOptions = {
            apiKey: config.executor.apiKey || '',
            baseUrl: config.executor.baseUrl || 'https://api.deepseek.com',
            model: config.executor.model || 'deepseek-chat',
            maxTokens: config.executor.maxTokens,
            temperature: config.executor.temperature,
            maxTurnsPerAgent: config.agents.maxTurnsPerAgent
          };
          const coordinator = new AgentCoordinator(coordOpts);
          const coordId = `spawn_${Date.now()}`;
          activeCoordinators.set(coordId, coordinator);

          await discord.send({ channelId: msg.channelId, content: `Spawning **${role}** agent...` });

          const result = await coordinator.spawnAgent(role, taskDesc);
          activeCoordinators.delete(coordId);

          const status = result.isError ? 'FAILED' : 'OK';
          const toolsSummary = result.toolsUsed.length > 0
            ? `\nTools: ${result.toolsUsed.join(', ')}`
            : '';
          await discord.send({
            channelId: msg.channelId,
            content: `**Agent ${role}** [${status}] (${result.turns} turns, ${formatDuration(result.durationMs)})${toolsSummary}\n\n${result.content.slice(0, 1800)}`
          });

        } else if (subCmd === 'coordinate') {
          // /agent coordinate <task...>
          const taskDesc = parts.slice(2).join(' ');
          if (!taskDesc) {
            await discord.send({ channelId: msg.channelId, content: 'Usage: /agent coordinate <task>' });
            break;
          }

          const coordOpts: CoordinatorOptions = {
            apiKey: config.executor.apiKey || '',
            baseUrl: config.executor.baseUrl || 'https://api.deepseek.com',
            model: config.executor.model || 'deepseek-chat',
            maxTokens: config.executor.maxTokens,
            temperature: config.executor.temperature,
            maxTurnsPerAgent: config.agents.maxTurnsPerAgent
          };
          const coordinator = new AgentCoordinator(coordOpts);
          const coordId = `coord_${Date.now()}`;
          activeCoordinators.set(coordId, coordinator);

          coordinator.on('phase_start', (phase: string, role: string) => {
            discord.send({ channelId: msg.channelId, content: `Phase **${phase}** started (${role} agent)...` });
          });

          await discord.send({ channelId: msg.channelId, content: `Starting 4-phase coordination...\nTask: ${taskDesc.slice(0, 200)}` });

          const result = await coordinator.execute(taskDesc);
          activeCoordinators.delete(coordId);

          const phaseSummary = result.phases.map(p =>
            `- **${p.phase}**: ${p.result.isError ? 'FAILED' : 'OK'} (${p.result.turns} turns, ${formatDuration(p.result.durationMs)})`
          ).join('\n');

          await discord.send({
            channelId: msg.channelId,
            content: [
              `**Coordination ${result.success ? 'Complete' : 'Failed'}** (${formatDuration(result.totalDurationMs)})`,
              phaseSummary,
              '',
              result.finalContent.slice(0, 1500)
            ].join('\n')
          });

        } else if (subCmd === 'list') {
          if (activeCoordinators.size === 0) {
            await discord.send({ channelId: msg.channelId, content: 'No active agents.' });
            break;
          }
          const lines: string[] = [];
          for (const [id, coord] of activeCoordinators) {
            const agents = coord.activeAgents;
            const agentInfo = agents.length > 0
              ? agents.map(a => `${a.role}${a.running ? ' (running)' : ''}`).join(', ')
              : 'no sub-agents active';
            lines.push(`\`${id}\` phase: ${coord.phase} | agents: ${agentInfo}`);
          }
          await discord.send({
            channelId: msg.channelId,
            content: `**Active Coordinators (${activeCoordinators.size})**\n${lines.join('\n')}`
          });

        } else {
          await discord.send({
            channelId: msg.channelId,
            content: 'Usage: /agent spawn <role> <task> | /agent coordinate <task> | /agent list'
          });
        }
        break;
      }

      case '/doctor': {
        const fix = parts.includes('--fix');
        await discord.send({ channelId: msg.channelId, content: 'Running diagnostics...' });
        const wsServer = getWsServer();
        const results = await runDoctor({
          fix,
          config: {
            discordToken: config.discord.token,
            apiKey: config.executor.apiKey,
            apiBaseUrl: config.executor.baseUrl,
            apiModel: config.executor.model,
            sessionDataDir: config.session.dataDir,
            logDir: config.logging.dir,
            wsPort: wsServer?.getPort()
          },
          discordConnected: true,
          wsHealthy: wsServer !== null
        });
        await discord.send({
          channelId: msg.channelId,
          content: `**Manamir Doctor**\n\`\`\`\n${formatDoctorResults(results)}\n\`\`\``
        });
        break;
      }

      default:
        await discord.send({
          channelId: msg.channelId,
          content: 'Commands: /status, /cost, /tools, /stop, /reset, /history, /ws, /task, /auto, /cron, /perm, /agent, /doctor'
        });
    }
  };
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
