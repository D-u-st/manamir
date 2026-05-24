# Troubleshooting

Common issues and how to fix them. If your problem isn't listed, check
`logs/manamir-*.log` and grep for `error` / `warn`.

## Boot / startup

### `Configuration errors: DISCORD_TOKEN is required`

You ran `npm start` (full bot) without setting up Discord. Either:

- Fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` in `.env`, **or**
- Use `npm run cli` instead — the CLI doesn't need Discord.

### `Configuration errors: API_KEY is required`

Your `.env` doesn't have `API_KEY`, or the `.env` file isn't being loaded.
Check:

```bash
node -e "import('dotenv/config').then(() => console.log(process.env.API_KEY?.slice(0,8)))"
```

If that prints nothing, `dotenv` isn't finding `.env`. Make sure you're running
from the project root (where `.env` lives).

### `Another Manamir instance is already running. Exiting.`

Stale lock file. Find and remove:

```bash
ls -la data/manamir.lock data/manamir-cli.lock 2>/dev/null
# If no other Manamir process exists:
rm data/manamir.lock data/manamir-cli.lock
```

Verify nothing else is running:

```bash
ps aux | grep -i manamir    # Linux/Mac
# Windows:
tasklist | findstr node
```

### `Cannot find module 'better-sqlite3'`

Native modules need a rebuild for your Node version:

```bash
npm rebuild better-sqlite3
```

On Linux you may need `build-essential` and `python3` first.

### `Refusing to overwrite existing .env`

The init wizard refuses to clobber. Pass `--force`:

```bash
npm run init -- --force
```

(The `--` is needed to pass flags through `npm run`.)

## Runtime

### Bot doesn't reply on Discord

1. **Check `ALLOWED_USER_IDS`** — empty means *nobody* is allowed. Add your
   Discord user ID (right-click your name → Copy User ID, with Developer
   Mode on).
2. **Check the Message Content Intent** is enabled on your application page.
   Without it, the bot sees empty message bodies.
3. **Check the bot is in the channel** and has Send Messages + Read Message
   History permissions.
4. **Check the logs** — look for `event:"discord_message"` to confirm messages
   are arriving.

### CLI shows nothing after a turn

Bump log level and watch:

```bash
LOG_LEVEL=debug npm run cli
# In another terminal:
tail -f logs/manamir-cli.log
```

Common culprit: API call failed silently because the executor swallowed an
error. Look for `event:"api_error"`.

### "Rate limit exceeded" on every turn

- Configure a `PROVIDERS` failover list, or
- Configure an `API_KEYS_POOL` to rotate across multiple keys, or
- Wait. Most providers reset hourly.

Manamir's `RateLimitTracker` (`src/executor/rate-limit-tracker.ts`) records
rate-limit headers from responses; check `logs/` for `event:"rate_limited"`
to see provider-side timing.

### Discord reconnects every few minutes

Network instability or proxy issue. discord.js opens a long-lived gateway WS;
NAT timeouts can kill it. Try:

```bash
# .env
HTTPS_PROXY=http://your-proxy:port
HTTP_PROXY=http://your-proxy:port
```

Or run on a host with a stable network (most VPS providers).

### Bot answer is cut off

`API_MAX_TOKENS` is too low. Default 4096. Bump to 8192 if you need long
answers.

### Memory store says it's full

It isn't — SQLite scales to GB. But the *prompt* memory budget is `MEMORY_MAX_IN_PROMPT`
(default 5). If the model is missing relevant memories, raise this; if you're
running out of token budget, lower it.

## Networking / proxies

### Mainland China — Discord won't connect

Set `HTTPS_PROXY` and `HTTP_PROXY` in `.env`. Manamir's `proxy-setup.ts`
patches the global `fetch` and the WebSocket agent used by discord.js so
DNS / TCP routes through the proxy.

```bash
HTTPS_PROXY=http://127.0.0.1:1080
HTTP_PROXY=http://127.0.0.1:1080
```

If you're on the operator's home WSL setup, the gateway IP is typically
`172.27.64.1:1080`.

### Provider API behind firewall

Same as above — `HTTPS_PROXY` covers all outbound HTTP, including provider APIs.

## Permissions / security

### "Permission denied for tool: Bash"

The user invoking the tool doesn't have `admin` role and the tool is in a
restricted tier. Either:

- Set their permission: `USER_PERMISSIONS=123456789:admin`
- Or change the default: `DEFAULT_PERMISSION_LEVEL=admin` (not recommended)

### "Path policy denied: /etc/shadow"

Working as intended. Path policy blocks dangerous paths system-wide. To bypass
(DANGER):

```bash
MANAMIR_POLICY_RELAXED=true
```

Don't enable this in production. The policy exists because the LLM will
occasionally try to read `/etc/passwd` when "exploring the system" and you
don't want that in audit logs.

## Performance

### CLI prompt feels laggy

The session's history may be large. Run `/clear` to start fresh, or
`/sessions` then `/resume <N>` to switch to a smaller one.

### High memory usage

Each session keeps full history in RAM until idle eviction. Lower
`IDLE_TIMEOUT_MS` (default 1h) to evict sooner.

### High CPU during boot

`better-sqlite3` rebuilds FTS5 indexes on first open if the schema changed.
One-time cost; subsequent boots are fast.

## Tests failing

### Path-policy tests fail on Windows

Expected. Path policy uses POSIX paths (`/etc/shadow`, `/proc`, etc.) which
don't exist on Windows. The 9 path-policy tests are pre-existing known
failures on Windows; they pass on Linux/Mac. The remaining 431 tests should
pass on all platforms.

### `tsc` reports two errors in `proxy-setup.ts`

Pre-existing — `https-proxy-agent` and `dotenv/config` aren't in the dev
dependencies. They're needed at runtime via `tsx` (which auto-installs)
but not at type-check time. Ignore these two specific errors; flag any
others.

## Getting help

1. Check `logs/manamir-*.log` first.
2. Run with `LOG_LEVEL=debug` for verbose output.
3. Search existing issues: <https://github.com/your-org/manamir/issues>
4. Open a new issue with: full error, your `.env` (redact secrets), Node
   version, platform.
