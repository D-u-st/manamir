# Configuration reference

All Manamir configuration is via environment variables, typically read from
`.env` at startup. The init wizard writes a working `.env` for the common case;
this doc covers everything.

## Reading order

1. `.env` (or whatever `--config=path` you pointed init at)
2. Process environment (overrides `.env`)
3. Defaults baked into `src/config.ts`

## Provider / executor

| Variable | Default | Notes |
|---|---|---|
| `EXECUTOR_TYPE` | `api` | `api` (OpenAI-compatible HTTP) or `auth` (claude CLI subprocess) |
| `API_KEY` | — | Required when `EXECUTOR_TYPE=api` and no `PROVIDERS` |
| `API_BASE_URL` | `https://api.deepseek.com` | Provider endpoint root |
| `API_MODEL` | `deepseek-chat` | Model name to send in chat-completions requests |
| `API_MAX_TOKENS` | `4096` | Per-response token cap |
| `API_TEMPERATURE` | `0.7` | Sampling temperature (0..2) |
| `SYSTEM_PROMPT` | — | Override the built-in system prompt entirely (rarely needed) |

### Multi-provider failover

```bash
PROVIDERS='[
  {"baseUrl":"https://api.deepseek.com","apiKey":"sk-...","model":"deepseek-chat"},
  {"baseUrl":"https://api.openai.com/v1","apiKey":"sk-...","model":"gpt-4o-mini"}
]'
```

When set, `API_KEY` / `API_BASE_URL` / `API_MODEL` become optional. The executor
tries providers in order and rotates on rate-limit / 5xx / network errors. See
`src/executor/failover.ts`.

### Credential pool (same provider, multiple keys)

```bash
API_KEYS_POOL='[
  {"apiKey":"sk-1...","baseUrl":"https://api.deepseek.com","model":"deepseek-chat","label":"key-A"},
  {"apiKey":"sk-2...","baseUrl":"https://api.deepseek.com","model":"deepseek-chat","label":"key-B"}
]'
```

Round-robins across keys. Useful when one key is rate-limited but the others
aren't. See `src/executor/credential-pool.ts`.

## Claude CLI mode

Only when `EXECUTOR_TYPE=auth`:

| Variable | Default | Notes |
|---|---|---|
| `CLAUDE_CLI_PATH` | `claude` | Path to the `claude` binary |
| `MAX_TURN_DURATION_MS` | `1800000` | 30 min hard timeout per turn |
| `MAX_TURNS` | `50` | Max agent loop iterations per user message |
| `CLAUDE_MODEL` | — | Pinned model (e.g. `claude-sonnet-4-5`) |

## Discord

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | — | Required for `npm start`. Bot token (3 dot-separated segments). |
| `DISCORD_CLIENT_ID` | — | Required. Application ID (15-25 digits). |
| `ALLOWED_USER_IDS` | empty | CSV. **Empty list = nobody allowed.** |

## Profile / data dirs

| Variable | Default | Notes |
|---|---|---|
| `MANAMIR_PROFILE` | `default` | Profile name (`[a-zA-Z0-9_-]{1,40}`). |
| `MANAMIR_PROFILES_ROOT` | `./data/profiles` | Where profiles live. |
| `SESSION_DATA_DIR` | profile-scoped `sessions/` | Override per-resource. |
| `MEMORY_DATA_DIR` | profile-scoped `memory/` | Override per-resource. |
| `SPECULATION_OVERLAY_DIR` | profile-scoped `speculation/` | Speculative execution overlay. |
| `LOG_DIR` | profile-scoped `logs/` | Log output directory. |

Profile-scoped means `./data/profiles/<name>/<resource>/`.

## Sessions & rotation

| Variable | Default | Notes |
|---|---|---|
| `IDLE_TIMEOUT_MS` | `3600000` (1h) | Drop session from memory after idle |
| `MAX_HISTORY_MESSAGES` | `200` | Hard cap on session history length |
| `ROTATION_ENABLED` | `true` | Auto-rotate sessions when limits hit |
| `ROTATION_MAX_TURNS` | `30` | Rotate after N user turns |
| `ROTATION_MAX_MINUTES` | `20` | Rotate after N minutes of activity |

## Memory

| Variable | Default | Notes |
|---|---|---|
| `MEMORY_MAX_IN_PROMPT` | `5` | Top-K relevant memories injected per turn |

## Prompt customization

| Variable | Default | Notes |
|---|---|---|
| `PROMPT_NAME` | `Manamir` | Bot identity name in system prompt |
| `PROMPT_SERVER_CONTEXT` | — | E.g. "Minecraft admin bot on play.foo.com" |
| `PROMPT_EXTRA_INSTRUCTIONS` | — | Appended to the system prompt |
| `PROMPT_TRACK_SUMMARY` | `true` | Maintain rolling conversation summary |
| `PROMPT_MAX_SUMMARY_ENTRIES` | `20` | Summary entry cap |

## Autonomous mode

| Variable | Default | Notes |
|---|---|---|
| `AUTONOMOUS_ENABLED` | `false` | Run the background scheduler |
| `AUTONOMOUS_MAX_CONCURRENT` | `1` | Parallel autonomous tasks |
| `AUTONOMOUS_PAUSE_MS` | `5000` | Pause between picks |
| `AUTONOMOUS_WORKING_DIR` | `/root` | CWD for autonomous shell ops |

## Multi-agent

| Variable | Default | Notes |
|---|---|---|
| `AGENTS_MAX_CONCURRENT` | `3` | Max sub-agents in flight |
| `AGENTS_DEFAULT_ROLES` | `researcher,implementer,reviewer` | CSV |
| `AGENTS_MAX_TURNS_PER_AGENT` | `10` | Per-agent loop cap |

## Cron

| Variable | Default | Notes |
|---|---|---|
| `CRON_ENABLED` | `true` | Run built-in cron jobs |
| `CRON_SESSION_CLEANUP_MS` | `600000` (10m) | Idle session prune interval |
| `CRON_MEMORY_PRUNE_MS` | `3600000` (1h) | Memory pruning interval |
| `CRON_DAILY_DISTILL_MS` | `3600000` (1h) | Daily-log distill check interval |

## Security / permissions

| Variable | Default | Notes |
|---|---|---|
| `USER_PERMISSIONS` | empty | CSV: `userId:level,...`. Levels: `admin`, `user`, `readonly` |
| `DEFAULT_PERMISSION_LEVEL` | `user` | Fallback role for unknown users |
| `MANAMIR_POLICY_RELAXED` | `false` | Skip path-policy enforcement (DANGER) |
| `MANAMIR_CLI_LOCK` | `./data/manamir-cli.lock` | CLI lock file path |

## Network

| Variable | Default | Notes |
|---|---|---|
| `HTTPS_PROXY` | — | Outbound HTTPS proxy URL |
| `HTTP_PROXY` | — | Outbound HTTP proxy URL |

`proxy-setup.ts` reads both at startup, patches global `fetch` + the WebSocket
agent used by discord.js so DNS / TCP go through the proxy.

## Logging

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_DIR` | profile-scoped `logs/` | Output directory |

## Servers

| Variable | Default | Notes |
|---|---|---|
| `WS_PORT` | `7777` | WebSocket bridge listen port |

## Validating your config

```bash
# Print the parsed config and exit (sanity check)
node -e "import('./dist/config.js').then(m => { \
  const c = m.loadConfig(); \
  const e = m.validateConfig(c); \
  console.log(JSON.stringify(c, null, 2)); \
  if (e.length) { console.error('ERRORS:', e); process.exit(1); } \
})"
```

If you see a validation error like "API_KEY is required for API executor", check
that `.env` is being loaded — `proxy-setup.ts` calls `dotenv/config` at the top
of every entry file.

## Examples

### Cheap personal bot (DeepSeek, Discord, single user)

```bash
EXECUTOR_TYPE=api
API_KEY=sk-...
API_BASE_URL=https://api.deepseek.com
API_MODEL=deepseek-chat
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
ALLOWED_USER_IDS=123456789012345678
```

### Failover Claude → DeepSeek

```bash
EXECUTOR_TYPE=api
PROVIDERS='[
  {"baseUrl":"https://api.anthropic.com","apiKey":"sk-ant-...","model":"claude-sonnet-4-5"},
  {"baseUrl":"https://api.deepseek.com","apiKey":"sk-...","model":"deepseek-chat"}
]'
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
ALLOWED_USER_IDS=...
```

### Multiple isolated instances (work + personal)

```bash
# work/.env
MANAMIR_PROFILE=work
API_KEY=...
WS_PORT=7777

# personal/.env
MANAMIR_PROFILE=personal
API_KEY=...
WS_PORT=7778
```

Each instance writes to its own `data/profiles/<name>/` directory.
