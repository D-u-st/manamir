# Channels

Manamir is multi-channel by design. The same SessionManager + tools serve all
channels; only the I/O layer differs.

## Discord

### Setup

1. Create an application at <https://discord.com/developers/applications>.
2. Under "Bot", create a bot user, copy the token (this is `DISCORD_TOKEN`).
3. Enable the **Message Content Intent** under Bot → Privileged Gateway Intents.
   Without this, the bot won't see messages.
4. Copy the application ID (`DISCORD_CLIENT_ID`).
5. Generate an OAuth2 invite URL with scopes `bot` + `applications.commands` and
   bot permissions: Send Messages, Read Message History, Use Slash Commands.
6. Add to your server. The bot only responds to user IDs in `ALLOWED_USER_IDS`.

### Behavior

- One **session per Discord channel** (group servers) and one per **DM**.
- Messages are queued per-channel — concurrent messages from different users in
  the same channel are serialized so the agent sees them in order.
- Long responses are auto-split at Discord's 2000-char limit with continuation
  markers.
- Streaming: text appears in chunks via Discord message edits.
- `/help`, `/clear`, `/sessions`, `/resume`, `/skills`, `/status` work as slash
  commands too.

### Permissions inside Discord

Per-user role is set via `USER_PERMISSIONS=userId:level,...`. Levels:

- `admin` — can run dangerous tools (Bash, Write, dangerous skills) without
  per-call confirmation
- `user` — can run standard tools; dangerous tools require confirmation
- `readonly` — can only ask questions; tool calls return a permission error

Default for users not in the list is `DEFAULT_PERMISSION_LEVEL` (default `user`).

## CLI

```bash
npm run cli
```

A streaming readline REPL. Single-user (no permissions check — assumed to be
the operator). Holds its own lock at `data/manamir-cli.lock` so it can run
side-by-side with the Discord bot pointed at the same data dir.

### Commands

| Command | What |
|---|---|
| `/help` | Print command list |
| `/exit` | Quit |
| `/clear` / `/new` | Drop current session, start fresh |
| `/sessions` | List past sessions, sorted by recency |
| `/resume <N>` | Resume by number from last `/sessions` listing |
| `/resume <id>` | Resume by full session ID |
| `/status` | Show session id / status / backend / model |
| `/skills` | List available skills |
| `/interrupt` | Cancel in-flight response (or Ctrl+C) |

### Interrupting

- One Ctrl+C during streaming → interrupt this turn, prompt returns
- Two Ctrl+C at idle prompt within 1.5s → exit
- SIGHUP (SSH disconnect) → clean shutdown, releases the lock

## WebSocket bridge

The WS server listens on `WS_PORT` (default 7777). Binary protocol: JSON messages,
one per frame.

### Wire protocol

#### Client → server

```json
{ "type": "message", "channelId": "ws-conn-12345", "userId": "you", "content": "hello" }
```

```json
{ "type": "command", "channelId": "ws-conn-12345", "userId": "you", "command": "clear" }
```

```json
{ "type": "interrupt", "channelId": "ws-conn-12345" }
```

#### Server → client

```json
{ "type": "text", "channelId": "...", "delta": "hello, " }
{ "type": "tool_use", "channelId": "...", "tool": "Read", "input": {"file_path": "..."} }
{ "type": "tool_result", "channelId": "...", "tool": "Read", "isError": false, "content": "..." }
{ "type": "turn_complete", "channelId": "...", "tokensIn": 1234, "tokensOut": 567 }
{ "type": "error", "channelId": "...", "message": "..." }
```

### Authentication

There's no built-in WS auth — bind to `127.0.0.1` and proxy via nginx with
basic auth, or add your own check in `src/handlers/ws-handler.ts` before
calling `sessionManager.handleMessage`.

### Example client (Node)

```javascript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:7777');
ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'message',
    channelId: 'demo-1',
    userId: 'me',
    content: 'list the files in /tmp',
  }));
});
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'text') process.stdout.write(msg.delta);
  if (msg.type === 'turn_complete') ws.close();
});
```


## Adding a new channel

The pattern is:

1. Implement an "input event" handler that calls `sessionManager.handleMessage(channelId, userId, content)`.
2. Subscribe to session events (`text`, `tool_use`, `tool_result`) for streaming.
3. Subscribe to `sessionManager` lifecycle events (`session_complete`, `session_error`)
   for completion notifications.

`src/channel/discord.ts` and `src/cli.ts` are the two reference implementations
to crib from.
