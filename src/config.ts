// maxTurns precedence:
// 1. Model profile (executor/model-profiles.ts) — per-model default
// 2. config.executor.maxTurns — env var override
// 3. config.rotation.maxTurns — separate: when to rotate session (not when to stop agent loop)
// config.claude.maxTurns — only for auth executor (Claude CLI mode)

import { resolve } from 'path';
import type { ProviderConfig } from './executor/failover';
import type { Credential } from './executor/credential-pool';
import type { PermissionLevel } from './security/permissions';
import { resolveProfileScoped, getProfileName } from './profile';

export interface ManamirConfig {
  discord: {
    token: string;
    clientId: string;
    allowedUserIds: string[];
  };
  executor: {
    type: 'auth' | 'api';     // auth = claude CLI, api = OpenAI-compatible
    // API mode settings
    apiKey?: string;
    baseUrl?: string;           // e.g. https://api.deepseek.com
    model?: string;             // e.g. deepseek-chat
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
    maxTurns?: number;
    providers?: ProviderConfig[];  // multi-provider failover list
    credentialPool?: Credential[]; // multi-key pool for the same provider
  };
  prompt: {
    name?: string;              // AI identity name (default: "Manamir")
    serverContext?: string;     // e.g. "Minecraft server admin bot on play.example.com"
    extraInstructions?: string; // Custom instructions appended to system prompt
    trackSummary: boolean;     // Enable conversation summary tracking (default true)
    maxSummaryEntries: number; // Max summary entries to keep (default 20)
  };
  claude: {
    cliPath: string;
    maxTurnDurationMs: number;
    maxTurns: number;
    model?: string;
  };
  session: {
    dataDir: string;
    idleTimeoutMs: number;
    maxHistoryMessages: number;
  };
  rotation: {
    enabled: boolean;
    maxTurns: number;
    maxMinutes: number;
  };
  memory: {
    dataDir: string;
    maxMemoriesInPrompt: number;
  };
  autonomous: {
    enabled: boolean;
    maxConcurrentTasks: number;
    pauseBetweenTasksMs: number;
    workingDirectory: string;
    /** Global per-hour cap on autonomous task starts. */
    maxTasksPerHour: number;
    /** When true, gate-chain must pass before each autonomous task. */
    requireGate: boolean;
    /** Default channelId used when autonomous tasks publish events. */
    channelId: string;
    /** Default userId attribution for autonomous task execution. */
    userId: string;
    /** Persistence directory for tasks.jsonl, cron.json, etc. */
    dataDir: string;
  };
  agents: {
    maxConcurrent: number;
    defaultRoles: string[];
    maxTurnsPerAgent: number;
  };
  speculation: {
    overlayDir: string;
    autoCleanupMs: number;   // cleanup old overlays after this many ms
  };
  cron: {
    enabled: boolean;
    sessionCleanupIntervalMs: number;
    memoryPruneIntervalMs: number;
    dailyLogDistillIntervalMs: number;
  };
  permissions: {
    userPermissions: Record<string, PermissionLevel>;
    defaultLevel: PermissionLevel;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    dir: string;
  };
}

function parseProviders(envValue: string | undefined): ProviderConfig[] | undefined {
  if (!envValue) return undefined;
  try {
    const parsed = JSON.parse(envValue);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // ignore malformed JSON
  }
  return undefined;
}

function parseCredentialPool(envValue: string | undefined): Credential[] | undefined {
  if (!envValue) return undefined;
  try {
    const parsed = JSON.parse(envValue);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const out: Credential[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey : '';
      const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl : '';
      const model = typeof entry.model === 'string' ? entry.model : '';
      if (!apiKey || !baseUrl || !model) continue;
      const label = typeof entry.label === 'string' ? entry.label : undefined;
      out.push({ apiKey, baseUrl, model, label });
    }
    return out.length > 0 ? out : undefined;
  } catch {
    // ignore malformed JSON
  }
  return undefined;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function parsePermissions(envValue: string | undefined): Record<string, PermissionLevel> {
  if (!envValue) return {};
  // Format: "userId1:admin,userId2:readonly,userId3:user"
  const result: Record<string, PermissionLevel> = {};
  for (const pair of envValue.split(',')) {
    const [userId, level] = pair.trim().split(':');
    if (userId && (level === 'admin' || level === 'user' || level === 'readonly')) {
      result[userId] = level;
    }
  }
  return result;
}

export function loadConfig(): ManamirConfig {
  return {
    discord: {
      token: process.env.DISCORD_TOKEN || '',
      clientId: process.env.DISCORD_CLIENT_ID || '',
      allowedUserIds: parseList(process.env.ALLOWED_USER_IDS)
    },
    executor: {
      type: (process.env.EXECUTOR_TYPE as 'auth' | 'api') || 'api',
      apiKey: process.env.API_KEY || '',
      baseUrl: process.env.API_BASE_URL || 'https://api.deepseek.com',
      model: process.env.API_MODEL || 'deepseek-chat',
      maxTokens: Number(process.env.API_MAX_TOKENS) || 4096,
      temperature: Number(process.env.API_TEMPERATURE) || 0.7,
      systemPrompt: process.env.SYSTEM_PROMPT || undefined,
      providers: parseProviders(process.env.PROVIDERS),
      credentialPool: parseCredentialPool(process.env.API_KEYS_POOL)
    },
    prompt: {
      name: process.env.PROMPT_NAME || undefined,
      serverContext: process.env.PROMPT_SERVER_CONTEXT || undefined,
      extraInstructions: process.env.PROMPT_EXTRA_INSTRUCTIONS || undefined,
      trackSummary: process.env.PROMPT_TRACK_SUMMARY !== 'false',
      maxSummaryEntries: Number(process.env.PROMPT_MAX_SUMMARY_ENTRIES) || 20
    },
    claude: {
      cliPath: process.env.CLAUDE_CLI_PATH || 'claude',
      maxTurnDurationMs: Number(process.env.MAX_TURN_DURATION_MS) || 1_800_000,
      maxTurns: Number(process.env.MAX_TURNS) || 50,
      model: process.env.CLAUDE_MODEL || undefined
    },
    session: {
      dataDir: resolveProfileScoped(process.env.SESSION_DATA_DIR, 'sessions'),
      idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MS) || 3_600_000,
      maxHistoryMessages: Number(process.env.MAX_HISTORY_MESSAGES) || 200
    },
    rotation: {
      enabled: process.env.ROTATION_ENABLED !== 'false',
      maxTurns: Number(process.env.ROTATION_MAX_TURNS) || 30,
      maxMinutes: Number(process.env.ROTATION_MAX_MINUTES) || 20
    },
    memory: {
      dataDir: resolveProfileScoped(process.env.MEMORY_DATA_DIR, 'memory'),
      maxMemoriesInPrompt: Number(process.env.MEMORY_MAX_IN_PROMPT) || 5
    },
    autonomous: {
      // Default-on for v2 Tier A productization. Bootstrapper still refuses to
      // start the worker if it has no permitted users + no API key — see
      // src/index.ts. Set AUTONOMOUS_ENABLED=false to disable explicitly.
      enabled: process.env.AUTONOMOUS_ENABLED !== 'false',
      maxConcurrentTasks: Number(process.env.AUTONOMOUS_MAX_CONCURRENT) || 1,
      pauseBetweenTasksMs: Number(process.env.AUTONOMOUS_PAUSE_MS) || 5000,
      workingDirectory: process.env.AUTONOMOUS_WORKING_DIR || '/root',
      maxTasksPerHour: Number(process.env.AUTONOMOUS_MAX_TASKS_PER_HOUR) || 30,
      requireGate: process.env.AUTONOMOUS_REQUIRE_GATE !== 'false',
      channelId: process.env.AUTONOMOUS_CHANNEL_ID || '__autonomous__',
      userId: process.env.AUTONOMOUS_USER_ID || '__system__',
      dataDir: resolveProfileScoped(process.env.AUTONOMOUS_DATA_DIR, 'autonomous')
    },
    agents: {
      maxConcurrent: Number(process.env.AGENTS_MAX_CONCURRENT) || 3,
      defaultRoles: parseList(process.env.AGENTS_DEFAULT_ROLES) .length > 0
        ? parseList(process.env.AGENTS_DEFAULT_ROLES)
        : ['researcher', 'implementer', 'reviewer'],
      maxTurnsPerAgent: Number(process.env.AGENTS_MAX_TURNS_PER_AGENT) || 10
    },
    speculation: {
      overlayDir: resolveProfileScoped(process.env.SPECULATION_OVERLAY_DIR, 'speculation'),
      autoCleanupMs: Number(process.env.SPECULATION_AUTO_CLEANUP_MS) || 3_600_000
    },
    cron: {
      enabled: process.env.CRON_ENABLED !== 'false',
      sessionCleanupIntervalMs: Number(process.env.CRON_SESSION_CLEANUP_MS) || 600_000,
      memoryPruneIntervalMs: Number(process.env.CRON_MEMORY_PRUNE_MS) || 3_600_000,
      dailyLogDistillIntervalMs: Number(process.env.CRON_DAILY_DISTILL_MS) || 3_600_000
    },
    permissions: {
      userPermissions: parsePermissions(process.env.USER_PERMISSIONS),
      defaultLevel: (process.env.DEFAULT_PERMISSION_LEVEL as PermissionLevel) || 'user'
    },
    logging: {
      level: (process.env.LOG_LEVEL as ManamirConfig['logging']['level']) || 'info',
      dir: resolveProfileScoped(process.env.LOG_DIR, 'logs')
    }
  };
}

export function validateConfig(config: ManamirConfig): string[] {
  const errors: string[] = [];
  if (!config.discord.token) errors.push('DISCORD_TOKEN is required');
  if (!config.discord.clientId) errors.push('DISCORD_CLIENT_ID is required');

  if (config.executor.type === 'api') {
    const hasProviders = config.executor.providers && config.executor.providers.length > 0;
    if (!hasProviders) {
      if (!config.executor.apiKey) errors.push('API_KEY is required for API executor (or set PROVIDERS)');
      if (!config.executor.baseUrl) errors.push('API_BASE_URL is required for API executor (or set PROVIDERS)');
    }
  }

  return errors;
}
