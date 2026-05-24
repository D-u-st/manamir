// Proxy setup MUST be first — patches ws before discord.js loads it
import './proxy-setup';

// Manamir v2 — AI agent harness
// Discord -> SessionManager -> Agent Loop (DeepSeek/OpenAI API + tools) -> Discord
//
// Supports two backends:
//   api  — OpenAI-compatible API with function calling (DeepSeek, OpenAI, etc.)
//   auth — Claude CLI subprocess (claude --print --output-format stream-json)

import { join } from 'path';
import { loadConfig, validateConfig } from './config';
import { configureLogger, log } from './utils/logger';
import { SessionManager } from './session/manager';
import { DiscordChannel } from './channel/discord';
import { getAllTools, initMemoryTool } from './tools';

import { state, trackError } from './core/state';
import { acquireLock, releaseLock, isLockHeld } from './core/lock';
import { WsServer } from './comms/ws-server';
import { ProgressTracker } from './comms/progress';
import { NotificationManager } from './comms/notifications';
import { hooks } from './hooks';
import { GateChain } from './autonomous/gate-chain';
import { Scheduler } from './autonomous/scheduler';
import { AutonomousWorker } from './autonomous/worker';
import { Cron } from './autonomous/cron';
import { DailyLog } from './autonomous/daily-log';
import { TaskStore } from './autonomous/task-store';
import { UserCron } from './autonomous/user-cron';
import { CostTracker, setGlobalCostTracker } from './utils/cost-tracker';
import { PermissionManager } from './security/permissions';

import { createMessageHandler } from './handlers/message-handler';
import { createCommandHandler } from './handlers/command-handler';
import { createWsHandler } from './handlers/ws-handler';
import { wireSelfReview } from './autonomous/self-review';
import { wireSkillSynthExtractor } from './skills/skill-synth';
import { setOcrMemoryStore, setOcrPostprocessConfig, terminateAllWorkers } from './multimodal/image-processor';
import { initMoaTool } from './tools';
import { scanApiKeySafety, logSafetyReport } from './security/api-key-safety';
import { ErrorMonitor } from './monitoring/error-monitor';
import { getProfileName, getProfileRoot } from './profile';
import { MemoryStore } from './memory/store';

// Module-level references
let wsServer: WsServer | null = null;
let notifications: NotificationManager | null = null;
let progressTracker: ProgressTracker | null = null;
let scheduler: Scheduler | null = null;
let autonomousWorker: AutonomousWorker | null = null;
let cronScheduler: Cron | null = null;
let dailyLog: DailyLog | null = null;
let permissions: PermissionManager | null = null;
let userCron: UserCron | null = null;
let costTracker: CostTracker | null = null;
let taskStore: TaskStore | null = null;

async function main(): Promise<void> {
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }

  configureLogger(config.logging.level, config.logging.dir);
  log.info('Manamir v2 starting...', {
    executor: config.executor.type,
    profile: getProfileName(),
    profileRoot: getProfileRoot()
  });

  if (!acquireLock()) {
    console.error('Another Manamir instance is already running. Exiting.');
    process.exit(1);
  }

  // Run API key + .env safety scan at startup. Logs warnings only — never
  // aborts. If your `.env` is committed, your API_KEY is a placeholder, or
  // file perms are world-readable, you'll see it in the boot log.
  try {
    const report = scanApiKeySafety({ projectRoot: process.cwd() });
    logSafetyReport(report);
  } catch (err) {
    log.warn('api-key-safety scan failed (non-fatal)', { error: String(err) });
  }

  // Global error monitor — collects errors from all sources for /status display
  // and (future TODO) daily Discord report. Auto-flushes to data/errors.jsonl
  // every 30s; safe across crashes.
  const errorMonitor = new ErrorMonitor({
    logPath: join(config.autonomous.dataDir, '..', 'errors.jsonl')
  });
  errorMonitor.startAutoFlush();

  state.config = config;

  // Initialize memory tool
  initMemoryTool(config.memory.dataDir, config.memory.maxMemoriesInPrompt);

  // Shared memory store for background daemons (selfReview writes lessons here)
  const memoryStore = new MemoryStore({
    dataDir: config.memory.dataDir,
    maxMemoriesInPrompt: config.memory.maxMemoriesInPrompt
  });

  const sessionManager = new SessionManager(config);
  sessionManager.start();

  // --- OCR memory persistence: backend-agnostic, wire unconditionally ---
  setOcrMemoryStore(memoryStore);

  // --- SelfReview: failure analysis → memory ---
  if (config.executor.type === 'api' && config.executor.apiKey && config.executor.baseUrl && config.executor.model) {
    wireSelfReview({
      apiKey: config.executor.apiKey,
      baseUrl: config.executor.baseUrl,
      model: config.executor.model,
      memoryStore
    });
    log.info('SelfReview: wired');

    // --- SkillSynth: extract reusable skills from successful traces ---
    wireSkillSynthExtractor({
      apiKey: config.executor.apiKey,
      baseUrl: config.executor.baseUrl,
      model: config.executor.model
    });
    log.info('SkillSynth: wired');

    // --- OCR postprocess (DeepSeek correction) — needs API creds ---
    setOcrPostprocessConfig({
      apiKey: config.executor.apiKey,
      baseUrl: config.executor.baseUrl,
      model: config.executor.model
    });
    log.info('OCR: memory + postprocess wired');

    // --- MoA: multi-perspective via 3x same model with high temperature ---
    // Honest note: a "true" MoA uses heterogeneous models (DeepSeek + Qwen + Claude).
    // We only have DeepSeek wired, so we approximate with same-model + diverse
    // temperatures. This is weaker than real MoA but still gives ~3x perspectives
    // for high-stakes questions. To upgrade: configure config.executor with an
    // OpenRouter-style multi-model setup, then refactor here.
    const ds = {
      provider: 'deepseek',
      baseUrl: config.executor.baseUrl,
      apiKey: config.executor.apiKey,
      model: config.executor.model
    };
    initMoaTool({
      referenceModels: [ds, ds, ds],
      aggregatorModel: ds,
      referenceTemp: 0.8,
      aggregatorTemp: 0.3
    });
    log.info('MoA: wired (single-model multi-perspective)');
  } else {
    log.info('OCR: memory wired (postprocess skipped — no API creds)');
  }

  // --- Cost tracker (singleton; api-executor records into it) ---
  costTracker = new CostTracker({
    dataDir: join(config.autonomous.dataDir, '..', 'cost')
  });
  setGlobalCostTracker(costTracker);

  // --- Autonomous: persistent task store + Scheduler + Worker + UserCron ---
  taskStore = new TaskStore({ dataDir: config.autonomous.dataDir });
  const restored = taskStore.load();
  if (restored.restored > 0 || restored.markedFailed > 0) {
    log.info('Autonomous: task store restored', restored);
  }

  const gateChain = new GateChain();
  gateChain
    .add('lock', async () => isLockHeld())
    .add('not_shutting_down', async () => !state.isShuttingDown);

  scheduler = new Scheduler(gateChain, {
    maxConcurrentTasks: config.autonomous.maxConcurrentTasks,
    pauseBetweenTasksMs: config.autonomous.pauseBetweenTasksMs,
    maxTasksPerHour: config.autonomous.maxTasksPerHour,
    requireGate: config.autonomous.requireGate,
    store: taskStore
  });

  autonomousWorker = new AutonomousWorker(scheduler, sessionManager, {
    channelId: config.autonomous.channelId,
    userId: config.autonomous.userId,
    tickIntervalMs: 10_000
  });

  userCron = new UserCron({
    dataDir: config.autonomous.dataDir,
    scheduler
  });

  // Safety contract: refuse to auto-start when there are no permitted users
  // and no API key — otherwise the worker would burn cycles on a config that
  // can't actually call the model or accept human override.
  const hasPermittedUsers = config.discord.allowedUserIds.length > 0
    || Object.keys(config.permissions.userPermissions).length > 0;
  const hasApiKey = config.executor.type !== 'api'
    || Boolean(config.executor.apiKey)
    || Boolean(config.executor.providers?.length)
    || Boolean(config.executor.credentialPool?.length);

  if (config.autonomous.enabled) {
    if (!hasPermittedUsers && !hasApiKey) {
      log.warn('Autonomous: refusing to start — no permitted users AND no API key configured');
    } else {
      autonomousWorker.start();
      userCron.start();
      log.info('Autonomous mode: enabled', {
        maxTasksPerHour: config.autonomous.maxTasksPerHour,
        requireGate: config.autonomous.requireGate,
        cronEntries: userCron.list().length,
        restoredTasks: restored.restored,
        markedFailed: restored.markedFailed
      });
    }
  }

  // --- Permission Manager ---
  permissions = new PermissionManager(config.permissions);

  // --- Daily Log ---
  dailyLog = new DailyLog({
    logDir: join(config.logging.dir, 'daily'),
    memoryStore: undefined // MemoryStore is internal to SessionManager; daily log uses hook data
  });
  dailyLog.wireHooks();

  // --- Cron Scheduler ---
  cronScheduler = new Cron();

  if (config.cron.enabled) {
    // Session cleanup — every 10 minutes by default
    cronScheduler.addJob('session-cleanup', config.cron.sessionCleanupIntervalMs, async () => {
      log.debug('Cron: running session-cleanup');
      // Trigger idle session cleanup via scheduler prune (completed tasks older than 1h)
      if (scheduler) {
        const pruned = scheduler.prune(3_600_000);
        if (pruned > 0) log.info('Cron: pruned completed tasks', { count: pruned });
      }
    });

    // Daily log distillation check — every hour by default
    cronScheduler.addJob('daily-log-distill', config.cron.dailyLogDistillIntervalMs, async () => {
      log.debug('Cron: checking daily log distillation');
      dailyLog!.checkDistill();
    });

    log.info('Cron: enabled with default jobs');
  }

  const discord = new DiscordChannel(
    config.discord.token,
    config.discord.allowedUserIds
  );

  // --- Notifications ---
  notifications = new NotificationManager();
  notifications.setSink(async (channelId, formatted) => {
    await discord.send({ channelId, content: formatted });
  });

  // --- Progress Tracker ---
  progressTracker = new ProgressTracker();

  // Wire autonomous worker notifications + hook bridge
  autonomousWorker.on('task_start', (task) => {
    notifications?.notify('info', `Autonomous task started: ${task.description.slice(0, 80)}`);
  });
  autonomousWorker.on('task_complete', (task) => {
    notifications?.notify('info', `Autonomous task completed: ${task.description.slice(0, 80)}`);
    void hooks.emit('autonomous:task_complete', { task });
  });
  autonomousWorker.on('task_error', (task, error) => {
    notifications?.notify('warning', `Autonomous task failed: ${task.description.slice(0, 60)} — ${String(error).slice(0, 60)}`);
    void hooks.emit('autonomous:task_error', { task, error: String(error) });
  });

  // Hook subscribers — anything that wants to react to autonomous events
  // (Discord notifications already fire above; this hook lets external
  // integrations / future plugins listen too).
  hooks.on('autonomous:task_complete', (_event, data) => {
    log.info('Hook fired: autonomous:task_complete', {
      taskId: typeof data.task === 'object' && data.task !== null
        ? (data.task as { id?: string }).id ?? 'unknown'
        : 'unknown'
    });
  });

  // --- Create handlers ---
  const getWsServer = () => wsServer;
  const getScheduler = () => scheduler;
  const getAutonomousWorker = () => autonomousWorker;
  const getCron = () => cronScheduler;
  const getPermissions = () => permissions;

  const handleCommand = createCommandHandler({
    sessionManager,
    discord,
    config,
    getWsServer,
    getScheduler,
    getAutonomousWorker,
    getCron,
    getPermissions,
    getUserCron: () => userCron,
    getCostTracker: () => costTracker,
    getMemoryStore: () => memoryStore
  });

  const handleMessage = createMessageHandler({
    sessionManager,
    discord,
    progressTracker,
    notifications,
    getWsServer,
    handleCommand
  });

  discord.onMessage(handleMessage);
  await discord.connect();

  // --- WebSocket server ---
  const wsPort = Number(process.env.WS_PORT) || 7777;
  wsServer = new WsServer({ port: wsPort });

  const handleWsMessage = createWsHandler({
    sessionManager,
    getWsServer
  });

  wsServer.onMessage(handleWsMessage);
  wsServer.start();

  log.info('Manamir v2 ready', {
    ...sessionManager.stats,
    executor: config.executor.type,
    model: config.executor.model || config.claude.model || 'default',
    tools: getAllTools().map(t => t.name)
  });

  const shutdown = async (signal: string) => {
    log.info(`Shutdown signal: ${signal}`);
    await hooks.emit('shutdown', { signal });
    state.isShuttingDown = true;

    if (cronScheduler) { cronScheduler.stopAll(); cronScheduler = null; }
    if (userCron) { userCron.stop(); userCron = null; }
    if (autonomousWorker) autonomousWorker.stop();
    if (wsServer) { wsServer.stop(); wsServer = null; }
    if (progressTracker) progressTracker.stopAll();

    sessionManager.stop();
    await discord.disconnect();
    // Free tesseract.js native handles before exit. beforeExit doesn't fire
    // for daemons holding sockets, so we have to do it here explicitly.
    await terminateAllWorkers().catch((err) => {
      log.warn('terminateAllWorkers failed during shutdown', { error: String(err) });
    });
    releaseLock();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', { error: String(error), stack: error.stack });
    trackError();
    errorMonitor.reportException(error, 'uncaught_exception', { where: 'global' });
    notifications?.notify('critical', `Uncaught exception: ${String(error).slice(0, 200)}`);
  });
  process.on('unhandledRejection', (error) => {
    log.error('Unhandled rejection', { error: String(error) });
    trackError();
    errorMonitor.reportException(error, 'unhandled_rejection', { where: 'global' });
    notifications?.notify('warning', `Unhandled rejection: ${String(error).slice(0, 200)}`);
  });

  // Wire executor:error → error monitor (record per-executor failures so the
  // /status snapshot can show error rates / top error codes).
  hooks.on('executor:error', (_event, data) => {
    errorMonitor.record({
      code: 'executor_error',
      severity: 'warning',
      message: String(data.error ?? 'unknown'),
      context: { sessionId: String(data.sessionId ?? '') }
    });
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  releaseLock();
  process.exit(1);
});
