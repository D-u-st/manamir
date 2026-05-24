# Architecture

A tour of the Manamir codebase, top-down.

## Big picture

```
+----------------+
| Channel I/O    |  Discord, CLI, WS, Web (each owns its own input/output)
+----------------+
        |
        v
+----------------+
| SessionManager |  one Session per channel-id; persists to SQLite
+----------------+
        |
        v
+----------------+
| Executor       |  api (OpenAI-compat) or auth (Claude CLI subprocess)
+----------------+
        |
        v
+----------------+
| Tools + Skills |  Read/Write/Bash/Grep/Memory/HRR/etc.; skills loaded on demand
+----------------+
```

Background daemons (SelfReview, SkillSynth, Cron, DailyLog) read from the same
SessionManager + MemoryStore but don't sit on the user-facing critical path.

## Entry points

| File | Purpose |
|---|---|
| `src/index.ts` | Full bot — Discord + WS + autonomous + cron |
| `src/cli.ts` | Local REPL only |
| `src/cli-entry.ts` | Unified `bin` dispatcher (`init` / `cli` / `start`) |
| `src/cli/init-wizard.ts` | First-run setup wizard |
| `src/proxy-setup.ts` | Patches global fetch + WS agent for proxies (imported FIRST) |

## Channels (`src/channel/`, `src/cli.ts`, `src/comms/`)

Each channel is a thin adapter that:

1. Receives input events (Discord message, readline line, WS frame)
2. Calls `sessionManager.handleMessage(channelId, userId, content)`
3. Subscribes to session events for streaming output
4. Renders output in its native format (Discord embed, ANSI text, JSON frame)

`src/channel/discord.ts` is the most complex (Discord intents, slash commands,
2000-char message splitting). `src/cli.ts` is the cleanest reference.

## Sessions (`src/session/`)

`SessionManager` owns a `Map<channelId, Session>`. Each `Session` is an
EventEmitter with state: `running`, `idle`, `error`. Operations:

- `handleMessage(channelId, userId, content)` — append user msg, run agent loop
- `getSession(channelId)` — accessor (no creation)
- `adoptSession(channelId, userId, oldId)` — `/resume` support
- `destroySession(channelId)` — `/clear` support
- `interruptSession(channelId)` — Ctrl+C, signals current API call to abort

Sessions persist via `HistoryStore` (SQLite) so they survive restarts. Idle
sessions get evicted from RAM after `IDLE_TIMEOUT_MS` but stay on disk.

Rotation: when `ROTATION_MAX_TURNS` or `ROTATION_MAX_MINUTES` hits, the next
user message starts a new session. The old one is preserved.

## Executors (`src/executor/`)

The executor runs the agent loop: prompt → LLM → tool calls → tool results →
LLM → ... until the model emits a final message.

| File | Role |
|---|---|
| `api.ts` | Default executor — OpenAI-compatible HTTP w/ streaming + tool loop |
| `auth.ts` | Claude CLI subprocess executor (`claude --print --output-format stream-json`) |
| `failover.ts` | Multi-provider rotation on rate-limit / outage |
| `credential-pool.ts` | Multi-key rotation for the same provider |
| `model-profiles.ts` | Per-model defaults (max-tokens, temperature, max-turns) |
| `rate-limit-tracker.ts` | Records rate-limit headers, suggests backoff |
| `token-budget.ts` | Per-turn input + output token caps |

The agent loop:

```
while (turn < maxTurns) {
  response = await callApi(messages, tools)
  if (response.toolCalls.length === 0) {
    return response.content   // final answer
  }
  for (toolCall of response.toolCalls) {
    result = await runTool(toolCall.name, toolCall.input)
    messages.push({ role: 'tool', name: ..., content: result })
  }
}
```

## Tools (`src/tools/`)

Each tool exports a function + a JSONSchema. They're collected into a single
`toolRegistry` that the executor passes to the LLM as available functions.

| Tool | What |
|---|---|
| `read.ts` | Read file (line ranges, image/PDF support) |
| `write.ts` | Write file (creates if absent) |
| `edit.ts` | Replace exact string in file |
| `glob.ts` | Glob pattern → file list |
| `grep.ts` | ripgrep-backed content search |
| `bash.ts` | Subprocess shell command |
| `web-fetch.ts` | HTTP GET, returns text/JSON |
| `todo.ts` | Per-session todo tracker |
| `memory.ts` | Memory store + search |
| `skill.ts` | List + load skills |
| `hrr.ts` | Hierarchical recursive reasoning context compress |

`src/tools/policy.ts` enforces path policy across all file-touching tools.
**Don't modify policy.ts without a security review.**

`src/tools/dispatcher.ts` is the central runtime — looks up the tool by name,
checks permissions, calls it, formats the result.

## Memory (`src/memory/`)

`MemoryStore` is FTS5-indexed SQLite. Schema:

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  content TEXT,
  source TEXT,           -- 'user', 'selfReview', 'skillSynth'
  created_at INTEGER,
  importance REAL,       -- 0..1
  tags TEXT              -- JSON array
);
CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='id');
```

`top-K` relevant memories are auto-injected into the system prompt every turn
via FTS5 BM25 ranking against the latest user message.

## Skills (`src/skills/`)

| File | Role |
|---|---|
| `store.ts` | List/load skills from disk |
| `security.ts` | Tier enforcement (read-only/standard/dangerous) |
| `trust.ts` | User trust state + hash verification |
| `tiers.ts` | Tier definitions and policy |
| `hash.ts` | SHA-256 hashing of skill bodies |
| `skillSynth-extractor.ts` | Background daemon — extract skills from successful traces |
| `chain.ts` | Multi-skill composition |

See [`SKILLS.md`](./SKILLS.md) for the user-facing model.

## Autonomous (`src/autonomous/`)

| File | Role |
|---|---|
| `scheduler.ts` | Pull tasks from a queue, respect `maxConcurrent` |
| `worker.ts` | Run scheduled tasks via the SessionManager |
| `gate-chain.ts` | Pre-flight checks (lock held, not shutting down) |
| `cron.ts` | Recurring jobs (cleanup, distill) |
| `daily-log.ts` | End-of-day log distillation |
| `selfReview.ts` | Failure analysis daemon |

SelfReview + SkillSynth are wired in `src/index.ts` after the SessionManager comes
up. They listen to `session_complete` / `session_error` events and run their
analysis off the critical path.

## Security (`src/security/`)

| File | Role |
|---|---|
| `permissions.ts` | Per-user role (admin/user/readonly) |
| `path-policy.ts` | Block dangerous paths (`/etc/shadow`, `/proc/`, `/sys/`, `/root/.ssh`) |

Path policy is enforced in every file-touching tool via `src/tools/policy.ts`.

## Hooks (`src/hooks/`)

A small event bus for "give me a callback when X happens". Events:

- `turn_start` — before the agent loop runs
- `turn_complete` — after the final message is emitted
- `tool_use` / `tool_result` — around each tool call
- `shutdown` — graceful stop

Used by daily-log, selfReview, skillSynth, notifications.


## Profiles (`src/profile/`)

Computes the active profile (from `MANAMIR_PROFILE` env) and the profile-scoped
data dir (`./data/profiles/<name>/`). Used by config.ts to make all data dirs
profile-aware.

## Locks (`src/core/lock.ts`)

File-based mutex. Prevents two Manamir instances racing on the same data dir.
The CLI uses a separate lock so it can coexist with the bot.

## Adding a new feature — checklist

1. **Tool**: add a file in `src/tools/`, export the function + schema, register
   in `src/tools/index.ts`.
2. **Channel**: implement input handler that calls `sessionManager.handleMessage`
   and subscribes to session events.
3. **Background daemon**: wire in `src/index.ts` (or `src/cli.ts` for CLI-only),
   subscribe to hooks.
4. **Config option**: add to `src/config.ts` (typed), document in `docs/CONFIGURATION.md`.
5. **Tests**: add to `tests/`, follow existing patterns (`node:test` runner).
