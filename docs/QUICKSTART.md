# Quickstart — 5 minutes to first chat

This guide gets you from zero to a working Manamir instance you can chat with.

## Prerequisites

- **Node.js >= 22** (`node --version`)
- **An API key** for one of: DeepSeek, Claude, OpenAI, or any OpenAI-compatible
  provider. DeepSeek is the cheapest — see [COSTS.md](./COSTS.md).
- **(Optional)** A Discord application + bot token if you want the Discord channel.
  Get one at <https://discord.com/developers/applications>.

## Step 1 — Install

```bash
git clone https://github.com/your-org/manamir.git
cd manamir
npm install
```

This pulls discord.js, ws, better-sqlite3, and the type-only build deps. Should
take ~20s on a decent connection.

## Step 2 — Configure with the wizard

```bash
npm run init
```

The wizard walks you through:

1. **Provider choice** — pick 1-4 (DeepSeek / Claude / OpenAI / custom).
2. **API key** — paste yours. The wizard validates the prefix and warns you if
   it doesn't match the provider's expected shape.
3. **Discord** — optional. If you say no, you can still use the CLI channel.
4. **Profile name** — leave blank for `default`. Set this if you want to run
   multiple isolated Manamir instances on the same machine.
5. **Confirm** — review and write.

After the wizard finishes, you'll have:

- `.env` — your config (mode `0600` so it's readable only by you)
- `data/profiles/<name>/` — empty profile directory ready for sessions/memory/skills

### Non-interactive

Useful for deploys or scripts:

```bash
npm exec -- manamir init \
  --provider=deepseek \
  --api-key=sk-ddeadbeefcafebabe1234567890abe2b \
  --no-discord \
  --yes
```

Add `--force` to overwrite an existing `.env`.

## Step 3 — First boot

### Option A — local CLI only

```bash
npm run cli
```

You'll see:

```
Manamir CLI (deepseek-chat)
Type /help for commands, /exit to quit.

>
```

Type a message. The bot streams the answer. Hit Ctrl+C once to interrupt
mid-stream, twice quickly to exit.

### Option B — full bot (Discord + WS)

```bash
npm start
```

This boots the Discord channel, WebSocket bridge on port 7777. Watch `logs/manamir-*.log` for activity.

Mention the bot in any channel where it's been added (or DM it directly) — only
user IDs in `ALLOWED_USER_IDS` will be answered.

## Step 4 — Verify it's working

In the CLI, try:

```
> what time is it?
> remember that my favorite language is rust
> /sessions
```

The first should stream a normal answer. The second should invoke the `memory_store`
tool and you'll see something like `🔧 memory_store {"content":"..."}`. The third
lists your past sessions.

## Step 5 — Where to go next

- **Tweak config** — see [CONFIGURATION.md](./CONFIGURATION.md) for every env var.
- **Add skills** — see [SKILLS.md](./SKILLS.md) to write your own.
- **Deploy to a VPS** — see `../deploy/INSTALL.md` for systemd / pm2 / docker.
- **Connect another channel** — see [CHANNELS.md](./CHANNELS.md) for the WS protocol.
- **Hit a wall** — see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Common gotchas

- **"Configuration errors: DISCORD_TOKEN is required"** — you ran `npm start`
  without setting up Discord. Either fill in the Discord vars in `.env` or use
  `npm run cli` instead.
- **"Another Manamir instance is already running"** — there's a stale lock at
  `data/manamir.lock`. If no other process holds it, delete the file.
- **CLI shows nothing after a turn** — check `logs/manamir-cli.log`; the model
  may have failed silently. Increase `LOG_LEVEL=debug` to see API errors.
- **Discord proxy issues in mainland China** — set `HTTPS_PROXY` and `HTTP_PROXY`
  in `.env`. Manamir's `proxy-setup.ts` patches both `fetch` and the WebSocket
  layer used by discord.js.
