// Proxy setup MUST be first — patches ws/fetch before anything that uses them
import './proxy-setup';

// Manamir CLI — interactive REPL channel for the agent core.
// Reuses SessionManager + APIExecutor + tools; only the I/O surface differs
// from the Discord channel.

import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { loadConfig, validateConfig } from './config';
import { configureLogger, setLoggerConsoleSilent, log } from './utils/logger';
import { SessionManager } from './session/manager';
import { initMemoryTool } from './tools';
import { state } from './core/state';
import { acquireLock, releaseLock, isLockHeld } from './core/lock';
import { hooks } from './hooks';
import { wireSelfReview } from './autonomous/self-review';
import { wireSkillSynthExtractor } from './skills/skill-synth';
import { setOcrMemoryStore, setOcrPostprocessConfig, terminateAllWorkers } from './multimodal/image-processor';
import { initMoaTool } from './tools';
import { MemoryStore } from './memory/store';
import { setPlanModeOverride, getPlanModeOverride } from './executor/plan-mode-detector';
import { GateChain } from './autonomous/gate-chain';
import { Scheduler } from './autonomous/scheduler';
import { AutonomousWorker } from './autonomous/worker';
import { TaskStore } from './autonomous/task-store';
import { UserCron } from './autonomous/user-cron';
import { CostTracker, setGlobalCostTracker, dateKey } from './utils/cost-tracker';
import { buildStatus } from './utils/status-builder';
import { getCheapModel } from './executor/cheap-router';
import { join } from 'path';
import { loadUserCommands, renderUserCommand, splitArgs, type UserCommand } from './cli/user-commands';

const CLI_CHANNEL = 'cli-local';
const CLI_USER = 'cli-user';

// ANSI escape codes — minimal palette
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

function printHelp(userCommands: ReadonlyMap<string, UserCommand>): void {
  stdout.write(
    `\n${C.bold}Built-in commands:${C.reset}\n` +
    `  ${C.cyan}/exit${C.reset}     quit\n` +
    `  ${C.cyan}/clear${C.reset}    drop the current session and start fresh\n` +
    `  ${C.cyan}/new${C.reset}      drop the current session and start fresh (alias for /clear)\n` +
    `  ${C.cyan}/sessions${C.reset} list past sessions, sorted by last activity\n` +
    `  ${C.cyan}/resume <id|N>${C.reset}  resume a past session by id or by /sessions number\n` +
    `  ${C.cyan}/status${C.reset}   multi-section status (worker, queue, cost, rate)\n` +
    `  ${C.cyan}/cost [today|week|month|reset]${C.reset}   show API cost\n` +
    `  ${C.cyan}/skills${C.reset}   list available skills\n` +
    `  ${C.cyan}/auto add|list|cancel|pause|resume|status${C.reset}   autonomous queue\n` +
    `  ${C.cyan}/cron add|list|remove${C.reset}   user-defined cron tasks\n` +
    `  ${C.cyan}/plan [on|off]${C.reset}  force/disable plan-mode for next message (toggle if no arg)\n` +
    `  ${C.cyan}/image <path>${C.reset}  OCR a local image and print the extracted text\n` +
    `  ${C.cyan}/help${C.reset}     show this help\n` +
    `  ${C.cyan}/interrupt${C.reset}  cancel the in-flight response (or press Ctrl+C)\n`
  );
  if (userCommands.size > 0) {
    stdout.write(`\n${C.bold}User commands:${C.reset}\n`);
    // Sort by name for stable display.
    const sorted = [...userCommands.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const c of sorted) {
      const desc = c.description || '(no description)';
      const tag = c.scope === 'project' ? `${C.dim}[project]${C.reset}` : `${C.dim}[global]${C.reset}`;
      stdout.write(`  ${C.cyan}/${c.name}${C.reset} ${tag}  ${C.dim}${desc}${C.reset}\n`);
    }
  } else {
    stdout.write(
      `\n${C.dim}(no user commands — drop a .md file in ~/.manamir/commands/ or` +
        ` <project>/.manamir/commands/)${C.reset}\n`
    );
  }
  stdout.write('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '\u2026';
}

function formatRelativeTime(ts: number): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

async function loadSkillsSafe(): Promise<Array<{ name: string; description: string; path: string }>> {
  try {
    const { listSkills } = await import('./skills/store');
    return listSkills();
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    process.stderr.write('Configuration errors:\n');
    errors.forEach((e) => process.stderr.write(`  - ${e}\n`));
    process.exit(1);
  }

  // CLI: logger writes to file only — silence console output so that warnings
  // (Retry 1/2 etc) don't shred the readline prompt or the streaming display.
  configureLogger('info', config.logging.dir);
  setLoggerConsoleSilent(true);

  // CLI uses its own lock so it can coexist with the Discord bot if both
  // are pointed at the same data dir (sessions/memory will share, lock won't
  // conflict). Override via MANAMIR_CLI_LOCK if you want stricter mutex.
  const cliLockPath = process.env.MANAMIR_CLI_LOCK || './data/manamir-cli.lock';
  if (!acquireLock(cliLockPath)) {
    process.stderr.write('Another Manamir CLI is already running. Exiting.\n');
    process.exit(1);
  }

  state.config = config;
  initMemoryTool(config.memory.dataDir, config.memory.maxMemoriesInPrompt);

  const memoryStore = new MemoryStore({
    dataDir: config.memory.dataDir,
    maxMemoriesInPrompt: config.memory.maxMemoriesInPrompt,
  });

  const sessionManager = new SessionManager(config);
  sessionManager.start();

  // --- Cost tracker (singleton, picked up by api-executor) ---
  const costTracker = new CostTracker({
    dataDir: join(config.autonomous.dataDir, '..', 'cost')
  });
  setGlobalCostTracker(costTracker);

  // --- Autonomous: Scheduler + Worker + UserCron ---
  const taskStore = new TaskStore({ dataDir: config.autonomous.dataDir });
  const restored = taskStore.load();
  if (restored.restored > 0 || restored.markedFailed > 0) {
    log.info('CLI: task store restored', restored);
  }
  const gateChain = new GateChain();
  gateChain
    .add('lock', async () => isLockHeld())
    .add('not_shutting_down', async () => !state.isShuttingDown);
  const scheduler = new Scheduler(gateChain, {
    maxConcurrentTasks: config.autonomous.maxConcurrentTasks,
    pauseBetweenTasksMs: config.autonomous.pauseBetweenTasksMs,
    maxTasksPerHour: config.autonomous.maxTasksPerHour,
    requireGate: config.autonomous.requireGate,
    store: taskStore
  });
  const autonomousWorker = new AutonomousWorker(scheduler, sessionManager, {
    channelId: config.autonomous.channelId,
    userId: config.autonomous.userId,
    tickIntervalMs: 10_000
  });
  const userCron = new UserCron({
    dataDir: config.autonomous.dataDir,
    scheduler
  });

  // Start autonomous + cron only when configuration looks usable. Refuse
  // silently in CLI mode (logged) to match the documented safety contract.
  const canStartAutonomous =
    config.autonomous.enabled &&
    (config.executor.type !== 'api' || Boolean(config.executor.apiKey));
  if (canStartAutonomous) {
    autonomousWorker.start();
    userCron.start();
    log.info('CLI: autonomous worker + user cron started');
  } else if (config.autonomous.enabled) {
    log.warn('CLI: autonomous enabled but missing API key — refusing to start');
  }

  // Wire task completion → hooks → notifications
  autonomousWorker.on('task_complete', (task) => {
    void hooks.emit('autonomous:task_complete', { task });
  });
  autonomousWorker.on('task_error', (task, error) => {
    void hooks.emit('autonomous:task_error', { task, error: String(error) });
  });

  if (
    config.executor.type === 'api' &&
    config.executor.apiKey &&
    config.executor.baseUrl &&
    config.executor.model
  ) {
    wireSelfReview({
      apiKey: config.executor.apiKey,
      baseUrl: config.executor.baseUrl,
      model: config.executor.model,
      memoryStore,
    });
    wireSkillSynthExtractor({
      apiKey: config.executor.apiKey,
      baseUrl: config.executor.baseUrl,
      model: config.executor.model,
    });
    setOcrPostprocessConfig({
      apiKey: config.executor.apiKey,
      baseUrl: config.executor.baseUrl,
      model: config.executor.model,
    });
    // MoA: same-model multi-perspective (see index.ts for rationale).
    const ds = {
      provider: 'deepseek',
      baseUrl: config.executor.baseUrl,
      apiKey: config.executor.apiKey,
      model: config.executor.model,
    };
    initMoaTool({
      referenceModels: [ds, ds, ds],
      aggregatorModel: ds,
      referenceTemp: 0.8,
      aggregatorTemp: 0.3,
    });
  }
  // OCR memory persistence is backend-agnostic — wire unconditionally.
  setOcrMemoryStore(memoryStore);

  const modelName =
    config.executor.model || config.claude.model || 'unknown';
  stdout.write(
    `${C.bold}Manamir CLI${C.reset} ${C.dim}(${modelName})${C.reset}\n` +
      `Type ${C.cyan}/help${C.reset} for commands, ${C.cyan}/exit${C.reset} to quit.\n\n`
  );

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  // Streaming state per turn
  let currentTurn: {
    streaming: boolean;
    sawTextThisTurn: boolean;
    toolLines: number;
  } = { streaming: false, sawTextThisTurn: false, toolLines: 0 };

  const onText = (chunk: string): void => {
    if (!currentTurn.streaming) return;
    if (!currentTurn.sawTextThisTurn) {
      // Open the assistant block on the first text token
      stdout.write(`${C.green}`);
      currentTurn.sawTextThisTurn = true;
    }
    stdout.write(chunk);
  };

  const onToolUse = (tool: string, input: Record<string, unknown>): void => {
    if (!currentTurn.streaming) return;
    // Close any open text block before printing the tool line
    if (currentTurn.sawTextThisTurn) {
      stdout.write(`${C.reset}\n`);
      currentTurn.sawTextThisTurn = false;
    }
    let argPreview: string;
    try {
      argPreview = JSON.stringify(input);
    } catch {
      argPreview = String(input);
    }
    if (argPreview.length > 100) argPreview = argPreview.slice(0, 97) + '...';
    stdout.write(`${C.yellow}\u{1F527} ${tool}${C.dim} ${argPreview}${C.reset}\n`);
    currentTurn.toolLines++;
  };

  const onToolResult = (
    _tool: string,
    resultContent: string,
    isError: boolean
  ): void => {
    if (!currentTurn.streaming) return;
    const preview = resultContent.slice(0, 200).replace(/\n/g, ' ');
    const more = resultContent.length > 200 ? '...' : '';
    const icon = isError ? `${C.red}\u274C` : `${C.gray}\u2713`;
    stdout.write(`${icon} ${preview}${more}${C.reset}\n`);
  };

  // Subscribe to session events lazily — the session may not exist until the
  // first message is sent. We re-resolve on every turn to handle /clear.
  const subscribeSession = (): (() => void) => {
    const session = sessionManager.getSession(CLI_CHANNEL);
    if (!session) return () => {};
    session.on('text', onText);
    session.on('tool_use', onToolUse);
    session.on('tool_result', onToolResult);
    return () => {
      session.off('text', onText);
      session.off('tool_use', onToolUse);
      session.off('tool_result', onToolResult);
    };
  };

  // Allow Ctrl+C during a turn to interrupt instead of killing the process.
  // Two consecutive Ctrl+C at idle prompt → exit (avoids the "use /exit" loop).
  let interrupted = false;
  let lastSigintAtIdle = 0;
  rl.on('SIGINT', () => {
    if (currentTurn.streaming) {
      if (interrupted) return; // already interrupting, don't spam
      interrupted = true;
      sessionManager.interruptSession(CLI_CHANNEL);
      stdout.write(`\n${C.yellow}[interrupted]${C.reset}\n`);
      return;
    }
    const now = Date.now();
    if (now - lastSigintAtIdle < 1500) {
      // Two Ctrl+C within 1.5s at the prompt → exit cleanly
      stdout.write(`\n`);
      rl.close();
      return;
    }
    lastSigintAtIdle = now;
    stdout.write(`\n${C.dim}(Ctrl+C again to exit, or type /exit)${C.reset}\n`);
    rl.prompt();
  });

  // Track the most recent /sessions listing so /resume <N> can map a number
  // back to a session id without re-reading the directory each time.
  let lastSessionListing: string[] = [];

  // Load user-defined slash commands from ~/.manamir/commands and
  // <project>/.manamir/commands. Any warnings from loading are surfaced
  // to the file log only — keep the prompt clean. The map is read on every
  // /help so that adding a new command file during the session shows up
  // without restart (we re-load lazily — see below).
  let userCommands = loadUserCommands().commands;
  {
    const initial = loadUserCommands();
    userCommands = initial.commands;
    for (const w of initial.warnings) log.warn('user-commands: ' + w);
    if (userCommands.size > 0) {
      stdout.write(`${C.dim}(loaded ${userCommands.size} user command(s))${C.reset}\n`);
    }
  }

  // handleCommand return values:
  //   true              → command consumed; main loop should re-prompt
  //   false             → not a slash command; main loop should sendTurn(line)
  //   { sendPrompt: s } → command resolved to a synthesized prompt; main
  //                       loop should sendTurn(s) instead of the raw line
  type CommandOutcome = true | false | { sendPrompt: string };

  const handleCommand = async (line: string): Promise<CommandOutcome> => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('/')) return false;

    const parts = trimmed.slice(1).split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    switch (cmd) {
      case 'exit':
      case 'quit':
        rl.close();
        return true;
      case 'help':
        // Re-load on every /help so a freshly-added command file shows up
        // without restarting the CLI.
        userCommands = loadUserCommands().commands;
        printHelp(userCommands);
        return true;
      case 'clear':
      case 'new': {
        sessionManager.destroySession(CLI_CHANNEL);
        stdout.write(`${C.dim}(session cleared)${C.reset}\n`);
        return true;
      }
      case 'sessions': {
        const store = sessionManager.historyStore;
        const ids = store.listSessions();
        const previews = ids.map((id) => ({ id: String(id), preview: store.getSessionPreview(id) }));
        // Sort by lastActivity desc; sessions with no activity sink to the bottom.
        previews.sort((a, b) => b.preview.lastActivity - a.preview.lastActivity);

        if (previews.length === 0) {
          stdout.write(`${C.dim}(no past sessions)${C.reset}\n`);
          lastSessionListing = [];
          return true;
        }

        lastSessionListing = previews.map((p) => p.id);
        stdout.write(`${C.bold}Past sessions:${C.reset}\n`);
        previews.forEach((p, idx) => {
          const n = idx + 1;
          const firstLine = (p.preview.firstUser || '(no user message)').replace(/\s+/g, ' ');
          const snippet = truncate(firstLine, 30);
          const when = formatRelativeTime(p.preview.lastActivity);
          stdout.write(
            `  ${C.cyan}${String(n).padStart(2)}${C.reset}. ` +
              `${C.bold}${p.id}${C.reset} ` +
              `${C.dim}msgs=${p.preview.messageCount} ${when}${C.reset}  ` +
              `${snippet}\n`
          );
        });
        stdout.write(`${C.dim}Use /resume <number> or /resume <id> to load.${C.reset}\n`);
        return true;
      }
      case 'resume': {
        if (args.length === 0) {
          stdout.write(`${C.red}usage: /resume <number-or-id>${C.reset}\n`);
          return true;
        }
        const target = args[0];
        let resolvedId = target;
        // Numeric? Resolve against the last /sessions listing.
        if (/^\d+$/.test(target)) {
          const n = parseInt(target, 10);
          if (lastSessionListing.length === 0) {
            // Auto-list once so /resume N works without an explicit /sessions.
            const ids = sessionManager.historyStore.listSessions();
            const previews = ids.map((id) => ({
              id: String(id),
              preview: sessionManager.historyStore.getSessionPreview(id),
            }));
            previews.sort((a, b) => b.preview.lastActivity - a.preview.lastActivity);
            lastSessionListing = previews.map((p) => p.id);
          }
          if (n < 1 || n > lastSessionListing.length) {
            stdout.write(
              `${C.red}out of range: ${n} (have ${lastSessionListing.length} sessions)${C.reset}\n`
            );
            return true;
          }
          resolvedId = lastSessionListing[n - 1];
        }

        const adopted = sessionManager.adoptSession(CLI_CHANNEL, CLI_USER, resolvedId);
        if (!adopted) {
          stdout.write(`${C.red}no session found for id: ${resolvedId}${C.reset}\n`);
          return true;
        }

        const messages = adopted.getHistory();
        stdout.write(
          `${C.green}\u2713 Loaded ${messages.length} prior turns${C.reset} ${C.dim}(session=${adopted.id})${C.reset}\n`
        );

        const preview = messages.slice(-6);
        if (preview.length > 0) {
          stdout.write(`${C.dim}--- recent messages ---${C.reset}\n`);
          for (const m of preview) {
            const who = m.role === 'user' ? `${C.bold}user${C.reset}` : `${C.green}assistant${C.reset}`;
            const snippet = truncate(m.content.replace(/\s+/g, ' '), 200);
            stdout.write(`${who}: ${snippet}\n`);
          }
          stdout.write(`${C.dim}-----------------------${C.reset}\n`);
        }
        return true;
      }
      case 'status': {
        const skills = await loadSkillsSafe();
        const storedSessions = sessionManager.historyStore.listSessions().length;
        const report = buildStatus({
          startedAt: state.startedAt,
          activeSessions: sessionManager.stats.activeSessions,
          storedSessions,
          memoryStore,
          skills,
          scheduler,
          worker: autonomousWorker,
          costTracker,
          rateLimits: null,
          primaryModel: modelName,
          cheapModel: getCheapModel(),
          botOnline: true
        });
        stdout.write(`${report.text}\n`);
        return true;
      }
      case 'cost': {
        const sub = (args[0] || 'today').toLowerCase();
        if (sub === 'reset') {
          if (args[1] !== '--confirm') {
            stdout.write(`${C.yellow}Add --confirm to wipe cost history.${C.reset}\n`);
            return true;
          }
          costTracker.reset();
          stdout.write(`${C.green}Cost history reset.${C.reset}\n`);
          return true;
        }
        const today = dateKey(Date.now());
        if (sub === 'week') {
          stdout.write(costTracker.formatSummary(today, 7, 'Last 7 days') + '\n');
          return true;
        }
        if (sub === 'month') {
          stdout.write(costTracker.formatSummary(today, 30, 'Last 30 days') + '\n');
          return true;
        }
        const todayBlock = costTracker.formatSummary(today, 1, `Today (${today})`);
        const yesterday = dateKey(Date.now() - 86_400_000);
        const cmp = costTracker.compareDays(yesterday, today);
        const arrow = cmp.deltaUsd > 0 ? '+' : '';
        const cmpLine =
          cmp.earlierUsd > 0
            ? `\n  Compared to yesterday: ${arrow}${cmp.deltaPct.toFixed(0)}%`
            : '';
        const week = costTracker.summarize(today, 7).costUsd;
        const month = costTracker.summarize(today, 30).costUsd;
        stdout.write(
          `${todayBlock}${cmpLine}\n\nWeek total:  $${week.toFixed(2)}\nMonth total: $${month.toFixed(2)}\n`
        );
        return true;
      }
      case 'auto': {
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'add') {
          const description = args.slice(1).join(' ');
          if (!description) {
            stdout.write(`${C.red}usage: /auto add <prompt>${C.reset}\n`);
            return true;
          }
          const t = scheduler.addTask(description);
          stdout.write(`${C.green}queued ${t.id}${C.reset}\n`);
          return true;
        }
        if (sub === 'list') {
          const tasks = scheduler.listTasks();
          if (tasks.length === 0) {
            stdout.write(`${C.dim}(no tasks)${C.reset}\n`);
            return true;
          }
          for (const t of tasks) {
            stdout.write(
              `  ${C.cyan}${t.id}${C.reset} [${t.status}] P${t.priority}  ${truncate(t.description, 60)}\n`
            );
          }
          return true;
        }
        if (sub === 'cancel') {
          const id = args[1];
          if (!id) {
            stdout.write(`${C.red}usage: /auto cancel <id>${C.reset}\n`);
            return true;
          }
          const ok = scheduler.cancelTask(id);
          stdout.write(ok ? `${C.green}cancelled ${id}${C.reset}\n` : `${C.red}not found or already done${C.reset}\n`);
          return true;
        }
        if (sub === 'pause') {
          scheduler.pause();
          stdout.write(`${C.yellow}scheduler paused${C.reset}\n`);
          return true;
        }
        if (sub === 'resume') {
          scheduler.resume();
          stdout.write(`${C.green}scheduler resumed${C.reset}\n`);
          return true;
        }
        if (sub === 'status' || sub === '') {
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
          stdout.write(
            `${C.bold}worker:${C.reset} ${autonomousWorker.isRunning ? 'running' : 'stopped'}` +
              ` (paused=${scheduler.isPaused})\n` +
              `${C.dim}pending=${pending} running=${running} done=${done} failed=${failed} cancelled=${cancelled}${C.reset}\n` +
              `${C.dim}rate: ${scheduler.tasksStartedLastHour}/${rateMax} per hour${C.reset}\n`
          );
          return true;
        }
        stdout.write(`${C.red}usage: /auto add|list|cancel|pause|resume|status${C.reset}\n`);
        return true;
      }
      case 'cron': {
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'add') {
          const name = args[1];
          if (!name || args.length < 8) {
            stdout.write(`${C.red}usage: /cron add <name> <m> <h> <d> <mo> <dow> <prompt>${C.reset}\n`);
            return true;
          }
          const schedule = args.slice(2, 7).join(' ');
          const prompt = args.slice(7).join(' ');
          const ok = userCron.add(name, schedule, prompt);
          stdout.write(ok ? `${C.green}cron "${name}" added${C.reset}\n` : `${C.red}invalid schedule or duplicate name${C.reset}\n`);
          return true;
        }
        if (sub === 'list') {
          const entries = userCron.list();
          if (entries.length === 0) {
            stdout.write(`${C.dim}(no user cron entries)${C.reset}\n`);
            return true;
          }
          for (const e of entries) {
            const next = e.nextRunAt ? new Date(e.nextRunAt).toISOString() : 'unknown';
            stdout.write(
              `  ${C.cyan}${e.name}${C.reset} [${e.enabled ? 'on' : 'off'}] ${e.schedule}  next=${next}\n` +
                `    ${C.dim}${truncate(e.prompt, 80)}${C.reset}\n`
            );
          }
          return true;
        }
        if (sub === 'remove') {
          const name = args[1];
          if (!name) {
            stdout.write(`${C.red}usage: /cron remove <name>${C.reset}\n`);
            return true;
          }
          const ok = userCron.remove(name);
          stdout.write(ok ? `${C.green}removed${C.reset}\n` : `${C.red}not found${C.reset}\n`);
          return true;
        }
        stdout.write(`${C.red}usage: /cron add|list|remove${C.reset}\n`);
        return true;
      }
      case 'skills': {
        try {
          const { listSkills } = await import('./skills/store');
          const skills = listSkills();
          if (skills.length === 0) {
            stdout.write(`${C.dim}(no skills)${C.reset}\n`);
          } else {
            stdout.write(`${C.bold}Skills:${C.reset}\n`);
            for (const s of skills) {
              stdout.write(`  ${C.cyan}${s.name}${C.reset} ${C.dim}— ${s.description}${C.reset}\n`);
            }
          }
        } catch (err) {
          stdout.write(`${C.red}skills lookup failed: ${String(err)}${C.reset}\n`);
        }
        return true;
      }
      case 'interrupt': {
        if (sessionManager.interruptSession(CLI_CHANNEL)) {
          stdout.write(`${C.yellow}[interrupt sent]${C.reset}\n`);
        } else {
          stdout.write(`${C.dim}(nothing to interrupt)${C.reset}\n`);
        }
        return true;
      }
      case 'plan': {
        // /plan          → toggle ON (force plan mode for the next message)
        // /plan on       → force ON
        // /plan off      → force OFF (disable plan mode for the next message)
        // /plan auto     → clear override, return to heuristic
        const sub = (args[0] ?? '').toLowerCase();
        let next: boolean | null;
        if (sub === '' || sub === 'on') {
          next = true;
        } else if (sub === 'off') {
          next = false;
        } else if (sub === 'auto' || sub === 'clear' || sub === 'reset') {
          next = null;
        } else {
          stdout.write(`${C.red}usage: /plan [on|off|auto]${C.reset}\n`);
          return true;
        }
        setPlanModeOverride(next);
        const cur = getPlanModeOverride();
        const label =
          cur === true ? 'ON (forced for next message)'
          : cur === false ? 'OFF (disabled for next message)'
          : 'AUTO (heuristic)';
        stdout.write(`${C.dim}plan-mode override: ${label}${C.reset}\n`);
        return true;
      }
      case 'image': {
        if (args.length === 0) {
          stdout.write(`${C.red}usage: /image <path>${C.reset}\n`);
          return true;
        }
        const target = args.join(' ');
        stdout.write(`${C.dim}OCR ${target}...${C.reset}\n`);
        void (async () => {
          try {
            const { processImage, formatOcrForPrompt } = await import('./multimodal/image-processor');
            const result = await processImage(target);
            stdout.write(`${C.cyan}${formatOcrForPrompt(result, target)}${C.reset}\n`);
            stdout.write(
              `${C.dim}duration: ${result.durationMs}ms` +
                (result.text ? `, confidence ~${result.confidence}%, ${result.text.length} chars` : '') +
                `${C.reset}\n`
            );
          } catch (err) {
            stdout.write(`${C.red}image error: ${err instanceof Error ? err.message : String(err)}${C.reset}\n`);
          }
        })();
        return true;
      }
      default: {
        // Check user-defined commands. We re-load on miss so that adding a
        // new command file mid-session works without restart — but only if
        // the in-memory map doesn't already have it (cheap fast path).
        let userCmd = userCommands.get(cmd);
        if (!userCmd) {
          userCommands = loadUserCommands().commands;
          userCmd = userCommands.get(cmd);
        }
        if (userCmd) {
          // The dispatcher already split the line on whitespace, but we
          // re-split the original arg-tail to preserve the user's exact
          // separators where they matter (multiple spaces collapse anyway
          // because trimmed.slice was split). splitArgs gives identical
          // semantics to the dispatcher's split so {{argN}} indices line up.
          const argString = trimmed.slice(cmd.length + 1).trim();
          const parsedArgs = splitArgs(argString);
          const prompt = renderUserCommand(userCmd, parsedArgs);
          stdout.write(`${C.dim}(running /${userCmd.name} from ${userCmd.scope})${C.reset}\n`);
          return { sendPrompt: prompt };
        }
        stdout.write(`${C.red}unknown command: /${cmd}${C.reset} (try /help)\n`);
        return true;
      }
    }
  };

  const sendTurn = async (input: string): Promise<void> => {
    interrupted = false;
    currentTurn = { streaming: true, sawTextThisTurn: false, toolLines: 0 };

    // sendMessage may create the session — call once first to ensure it
    // exists, then subscribe.
    const turnPromise = sessionManager.handleMessage(CLI_CHANNEL, CLI_USER, input);
    // Subscribe immediately — the session is created synchronously inside
    // handleMessage before any async work is awaited (getOrCreateSession is sync).
    const unsubscribe = subscribeSession();

    try {
      await turnPromise;
      // Close any open text block
      if (currentTurn.sawTextThisTurn) stdout.write(`${C.reset}\n`);
      else if (currentTurn.toolLines === 0 && !interrupted) {
        // No text and no tools — surface something so the user knows it returned
        stdout.write(`${C.dim}(no output)${C.reset}\n`);
      }
    } catch (err) {
      stdout.write(`\n${C.red}error: ${err instanceof Error ? err.message : String(err)}${C.reset}\n`);
    } finally {
      unsubscribe();
      currentTurn.streaming = false;
    }
  };

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`CLI shutdown: ${signal}`);
    await hooks.emit('shutdown', { signal });
    state.isShuttingDown = true;
    autonomousWorker.stop();
    userCron.stop();
    sessionManager.stop();
    await terminateAllWorkers().catch((err) => {
      log.warn('terminateAllWorkers failed during CLI shutdown', { error: String(err) });
    });
    releaseLock();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // SSH parent disconnects → SIGHUP. Without this handler, the CLI process
  // lingers and holds the lock file even after the SSH session drops.
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  // Last-resort cleanup for unexpected exits
  process.on('exit', () => releaseLock());
  rl.on('close', () => void shutdown('rl_close'));

  // PPID guard: defense-in-depth against npm/ssh swallowing SIGHUP.
  // Linux PPID===1 means parent died (orphaned). 30s check, unref so it does
  // not block exit. SIGHUP handler above is the primary path; this is the
  // last-resort cleanup if the signal never arrives.
  const orphanCheck = setInterval(() => {
    if (process.ppid === 1) {
      log.warn('CLI orphaned (parent process died), shutting down');
      void shutdown('orphaned');
    }
  }, 30_000);
  orphanCheck.unref();

  // Main loop
  while (true) {
    let line: string;
    try {
      line = await rl.question(`${C.bold}>${C.reset} `);
    } catch {
      // rl closed (Ctrl+D or /exit)
      break;
    }
    if (!line.trim()) continue;

    const outcome = await handleCommand(line);
    if (outcome === true) continue;
    if (outcome === false) {
      await sendTurn(line);
      continue;
    }
    // User-defined command resolved to a synthesized prompt — send it.
    await sendTurn(outcome.sendPrompt);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  releaseLock();
  process.exit(1);
});
