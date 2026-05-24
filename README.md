# Manamir

Run an LLM agent on Discord and a local CLI. It keeps memory across restarts,
has file/bash/web/grep tools, supports multiple LLM providers, and can review
its own failed turns to write lessons for next time.

Built around DeepSeek but works with any OpenAI-compatible API, or a local
Claude CLI.

[![tests](https://img.shields.io/badge/tests-passing-brightgreen)]()
[![license](https://img.shields.io/badge/license-MIT-blue)]()
[![node](https://img.shields.io/badge/node-%3E%3D22-green)]()

## Quick start

```bash
git clone https://github.com/D-u-st/manamir.git
cd manamir
npm install

# interactive setup — writes .env
npm run init

# run it
npm start        # Discord bot + WebSocket bridge
npm run cli      # local REPL, no Discord needed
```

The setup wizard asks which provider you want (DeepSeek / Claude / OpenAI /
custom), takes an API key, and optionally sets up Discord. It won't overwrite an
existing `.env` unless you pass `--force`.

Non-interactive (for deploys):

```bash
npx manamir init --provider=deepseek --api-key=sk-xxx --no-discord --yes
```

See [`docs/QUICKSTART.md`](./docs/QUICKSTART.md) for more.

## What it does

- Runs as a long-lived daemon. Sessions and memory survive restarts.
- Each Discord channel, the CLI, and each WebSocket connection is its own
  session with separate context.
- Tools the model calls itself: read, write, edit, glob, grep, bash, web fetch,
  todo list, and a memory tool.
- Long-term memory in an FTS5 SQLite store. Relevant memories are pulled into
  the prompt each turn.
- After a failed turn, a background pass asks the model what went wrong and
  saves the lesson to memory. After a successful multi-tool turn, it can extract
  a reusable skill.
- Multiple providers with failover and a multi-key pool, so one rate-limit or
  outage rotates to the next.
- A path policy blocks reads of `/etc/shadow`, `/proc`, `/sys`, ssh keys, etc.

## Configuration

Everything is via `.env`. The setup wizard writes a working default. Full list
in [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `EXECUTOR_TYPE` | yes | `api` | `api` (OpenAI-compatible) or `auth` (Claude CLI) |
| `API_KEY` | yes (api) | — | provider API key |
| `API_BASE_URL` | yes (api) | `https://api.deepseek.com` | provider endpoint |
| `API_MODEL` | yes (api) | `deepseek-chat` | model name |
| `API_MAX_TOKENS` | no | `4096` | per-response token cap |
| `API_TEMPERATURE` | no | `0.7` | sampling temperature |
| `PROVIDERS` | no | — | JSON array for failover |
| `API_KEYS_POOL` | no | — | JSON array for key rotation |
| `DISCORD_TOKEN` | yes (bot) | — | Discord bot token |
| `DISCORD_CLIENT_ID` | yes (bot) | — | Discord application ID |
| `ALLOWED_USER_IDS` | no | — | comma-separated; empty means nobody |
| `MANAMIR_PROFILE` | no | `default` | profile name (isolates data dirs) |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error` |
| `WS_PORT` | no | `7777` | WebSocket port |
| `HTTPS_PROXY` | no | — | outbound proxy (also `HTTP_PROXY`) |

## Channels

**Discord** — mention the bot or DM it. It only replies to user IDs in
`ALLOWED_USER_IDS`. Each channel is its own session.

**CLI** — `npm run cli` gives a streaming REPL with `/help`, `/sessions`,
`/resume <n>`, `/clear`, `/skills`, `/status`, `/interrupt`. It uses its own
lock file so it can run alongside the Discord bot on the same data dir.

**WebSocket** — connect to `ws://localhost:7777` and send JSON. Protocol in
[`docs/CHANNELS.md`](./docs/CHANNELS.md).

## Sessions, memory, skills

Each channel maps to one session, stored in SQLite. Sessions rotate when they
hit a turn or time limit; old ones are resumable with `/resume`.

Memory is an FTS5 SQLite store the model reads and writes through tools. Top
relevant entries are injected into the prompt each turn.

Skills are file-based capabilities under `data/profiles/<profile>/skills/`. Each
has a `manifest.json` and a markdown body. They have three trust tiers
(read-only / standard / dangerous). The model loads them on demand. See
[`docs/SKILLS.md`](./docs/SKILLS.md).

## How it fits together

Channels handle I/O. A SessionManager keeps one session per channel and runs the
agent loop in an executor (API or Claude CLI), which calls tools and streams
text back. Sessions, memory, and skills persist under
`data/profiles/<profile>/`. Background daemons (self-review, skill extraction,
log distillation, cron cleanup) read and write the same memory store.

Architecture details in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Development

```bash
npm test                              # run tests
npx tsc -p tsconfig.json --noEmit     # type-check
npm run build                         # build to dist/
```

```
src/
  agents/      multi-agent orchestration
  autonomous/  self-review, skill extraction, scheduler, cron, daily-log
  channel/     discord channel
  cli/         init wizard
  comms/       websocket server, progress, notifications
  core/        global state, lock file
  executor/    api/auth executor, model profiles, failover, credential pool
  handlers/    message / command / ws handlers
  hooks/       plugin event bus
  memory/      FTS5 memory store
  profile/     multi-instance isolation
  prompts/     system prompts
  queue/       per-channel async queue
  security/    permissions, path policy
  session/     session, manager, history
  skills/      skill store, security, tiers
  tools/       tool implementations + dispatcher
  utils/       logger, etc.
tests/         test suite (node:test)
docs/          documentation
```

### Contributing

1. Open an issue first.
2. Add tests for your change.
3. Don't change `src/tools/policy.ts` without a security review.
4. TypeScript strict; no `any` on exported APIs.

## License

MIT. See [LICENSE](./LICENSE).
