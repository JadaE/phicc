# Discord bridge runbook

Phicc's `!!` commands are unchanged. The bridge is a separate, optional path for `@mentions`. It is off unless you turn it on. Nothing in this repo connects to Discord or to a webhook by itself, and this file contains no tokens.

The bridge is the wire. Comms Bot (a Grok Bot teammate) is the brain. The Discord application is only the mouth and ears. A Discord bot user cannot become a Grok Bot teammate.

## What you are setting up

Use a **new Discord application**, not Phicc's existing one. Phicc's app may already have the privileged Message Content intent so that `!!` commands work. The bridge does not need that intent. A separate app keeps the wider read scope off the bridge.

Two ways to run the same library:

- **Phicc adapter.** `node bot.js` with `PHICC_BRIDGE_ENABLED=true`. One login, same client. `!!` commands stay on the old handler. The bridge ignores anything that starts with `!!`.
- **Standalone / fork.** `node bridge.js`. No `!!` commands. Copy `discord-bridge/`, `bridge.js`, `config.example.json`, `scripts/perm-calc.js`, and this runbook into the next bot.

The standalone client requests gateway intents **513** only (`Guilds` 1 + `GuildMessages` 512). It does not request `MESSAGE_CONTENT` (32768). Discord still delivers the text of messages that mention the bot. The Phicc process keeps the intents it already had (`GUILDS`, `GUILD_MESSAGES`, `GUILD_MESSAGE_REACTIONS`, `GUILD_EMOJIS_AND_STICKERS`). Turning the adapter on does not add Message Content in code. The Developer Portal setting is separate, which is why the bridge should have its own application.

## Create the Discord application

1. Open the Discord Developer Portal and create a new application. Turn on 2FA on the owner account.
2. Open **Bot** and add a bot user. Leave **Message Content Intent** off. Do not enable Presence or Server Members either.
3. Reset the token and put it only in the environment variable named below, or in the host's secret store. Do not paste it into chat, commit it, or put it in `config.local.json`.
4. Copy the application id. You will put that in `config.local.json` as `discord.applicationId`.

Dev and production need two applications and two tokens.

## Invite URL

Permissions are a bitfield. Add them by OR-ing. Do not use Administrator (8). It bypasses every channel overwrite.

| Set | Permissions | Integer |
|---|---|---|
| Base | View Channel, Send Messages, Read Message History | **68608** |
| Embeds and reactions | Base + Embed Links + Add Reactions | **85056** |
| Threads (only if you want thread replies) | 85056 + Send Messages in Threads | **274877992000** |

`node scripts/perm-calc.js` prints those three numbers. `node scripts/perm-calc.js ADMINISTRATOR` exits with an error.

The bridge sends plain text. Turn reactions on in config (the default) only if the invite includes Add Reactions, and use **85056**. If reactions are off and you do not need embeds, use **68608**. Phicc's existing commands send embeds and reactions, so Phicc's own invite already needs those bits. Prefer a channel overwrite on the test channel instead of a server-wide grant.

Scope is `bot` only. Do not add `applications.commands` unless you later decide you want slash commands.

Base invite:

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=68608&scope=bot
```

Embeds and reactions:

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=85056&scope=bot
```

Replace `YOUR_APPLICATION_ID`. Invite the bot into a private test channel that only you and the bot can see. From 16 Nov 2026 Discord only shows the bot metadata for channels it can view, so put channel ids in config. Do not look channels up by name.

## Config and secrets

```bash
cp config.example.json config.local.json
chmod 600 config.local.json
```

`config.example.json` is the only config that is committed, and every id in it is a placeholder. `config.local.json` is gitignored. Startup refuses to log in when the bridge is enabled if any `YOUR_` placeholder is still present, if the user and role allowlists are both empty, or if `config.local.json` is looser than mode 600.

The token is not a config field. `discord.tokenEnv` names the environment variable that holds it.

Replace the placeholders. For a Phicc adapter, a starting file looks like this (still placeholders, not real ids):

```json
{
  "botName": "phicc",
  "discord": {
    "tokenEnv": "DISCORD_TOKEN",
    "applicationId": "YOUR_APPLICATION_ID",
    "guildIds": ["YOUR_GUILD_ID"],
    "channelIds": ["YOUR_TEST_CHANNEL_ID"],
    "allowedUserIds": ["YOUR_USER_ID"],
    "allowedRoleIds": []
  },
  "queue": { "dir": "~/discord-bridge/phicc/queue" },
  "features": {
    "enabled": true,
    "killSwitchFile": "~/discord-bridge/phicc/STOP"
  },
  "logging": { "dir": "~/discord-bridge/phicc/logs", "logBodies": false }
}
```

Empty allowlists deny everyone. A user is allowed when their id is listed or they have a listed role. DMs are always dropped. Threads are dropped unless `discord.allowThreads` is true, and then only when the parent channel is allowlisted.

`features.enabled` defaults to false. The Phicc process also requires `PHICC_BRIDGE_ENABLED` to be the string `true`. Both have to be on before a mention is queued. `node bot.js` with neither set is the same bot as before.

Environment variables override the files. Names:

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Token for the existing Phicc process (`node bot.js`). |
| `DISCORD_TOKEN_DEV` | Token for `node bridge.js`. The example config points `discord.tokenEnv` here so a forked bot does not reuse Phicc's variable. |
| `PHICC_BRIDGE_ENABLED` | `true` attaches the bridge inside Phicc. Anything else leaves it off. |
| `COMMS_WEBHOOK_URL` | Grok Bot routine webhook URL. |
| `COMMS_WEBHOOK_KEY` | Bearer key for that webhook. |
| `DBR_FEATURES_ENABLED` | `true` or `false`. Overrides `features.enabled`. |
| `DBR_FEATURES_KILLSWITCHFILE` | Overrides the kill-switch path. |
| `DBR_QUEUE_DIR` | Overrides the queue directory. |
| `DBR_DISCORD_GUILDIDS` | Comma-separated guild ids. |
| `DBR_DISCORD_CHANNELIDS` | Comma-separated channel ids. |
| `DBR_DISCORD_ALLOWEDUSERIDS` | Comma-separated user ids. |
| `DBR_DISCORD_ALLOWEDROLEIDS` | Comma-separated role ids. |
| `DBR_DISCORD_APPLICATIONID` | Application id. |
| `DBR_LOGGING_DIR` | Log directory. |
| `DBR_LOGGING_LOGBODIES` | `true` only in a local debug session. Default is false, so logs do not store message text. |

The webhook URL and key are secrets. Copy them from the Comms Bot routine panel on the desktop (Details, Routines, Webhook). Do not paste the key into chat. The bridge reads them from the environment at startup and never writes them to the queue, the logs, or the webhook body.

## Wake the teammate

After a mention passes the allowlists, the bridge writes `queue/inbox/<message id>.json` by creating a temp file and linking it into place, then POSTs to `COMMS_WEBHOOK_URL` with `Authorization: Bearer <COMMS_WEBHOOK_KEY>`. A **200 means the run started**, not that the reply is finished. The body is `{"msgId":"..."}` or, when several mentions arrive together, `{"msgIds":["..."]}`. It does not include message text or the token.

Bursts wait 1.5 seconds, or flush at 5 messages, so one rush is one run. The bridge will not start more than 200 runs in a rolling hour (the per-routine cap; the account cap is 300 per hour). A non-200 response waits and retries with exponential backoff, up to 5 times. A 429, or a body that says the automation rate limit was exceeded, waits for `Retry-After` (at least 60 seconds), tries once more, and then stops firing until a later mention. Inbox files stay on disk either way. Comms Bot reads the inbox itself; the webhook is only the alarm.

There is no filesystem watcher and no call from this process into another agent. If the webhook variables are unset, the mention is still queued and nothing is posted.

## Queue

```text
<queue dir>/inbox/<message id>.json
<queue dir>/outbox/<message id>.json
<queue dir>/done/<message id>.json
<queue dir>/dead/<message id>.json
```

Directories are mode 700, files are mode 600. The inbox record stores the message id, channel, guild, a hash of the author id, the display name, the text with the bot mention removed, and timestamps. It does not store a raw user id or a token.

Comms Bot writes `outbox/<message id>.json`:

```json
{ "replyTo": "<message id>", "channelId": "<same channel>", "text": "answer", "final": true }
```

The bridge posts only when `replyTo` matches the file name, the channel matches the inbox item, and that channel is still allowlisted. Replies use `allowedMentions: { parse: [] }`, so nobody is pinged. Text is split on line breaks into pieces of at most 1900 characters, at most 3 pieces. Anything past that is cut and the last piece ends with `[truncated]`. Then the inbox item moves to `done/`. A send that still fails is written to `dead/`, the bridge adds the fail reaction when reactions are on, and it sends one short "couldn't answer, logged" reply.

A duplicate gateway event for a message id that is already in `inbox/`, `outbox/`, `done/`, or `dead/` is dropped.

The bridge does not read channel history on startup. Mentions sent while it is offline are missed. That is intentional.

If Comms Bot has not written an outbox file within `policy.commsTimeoutMinutes` (default 10), the bridge posts one "still working" reply and does not post it again.

Reactions, when enabled: eyes when the mention is queued, check when the reply is sent, cross when it is dead-lettered. If the bot lacks Add Reactions, the reaction fails and the queue still moves.

## Kill switch

```bash
touch ~/discord-bridge/phicc/STOP
```

Use the path in `features.killSwitchFile`. The bridge checks that file on every event, so it goes quiet on the next message (well under a second) and stays connected. It does not enqueue mentions and it does not post outbox replies. Phicc's `!!` commands keep working, because they are a different listener.

Remove the file and the bridge handles new mentions again. You do not have to restart for the file. You do have to restart after changing `PHICC_BRIDGE_ENABLED` or `features.enabled`.

`features.enabled` false (or `DBR_FEATURES_ENABLED=false`) means the standalone process does not log in. Inside Phicc, the listener stays attached only when `PHICC_BRIDGE_ENABLED=true`, and it drops mentions while `features.enabled` is false.

The fastest stop is kicking the bot from the server, or resetting the token in the Developer Portal.

A global rate-limit trip (default 60 accepted mentions an hour) writes the kill-switch file so a burst cannot keep spending Comms Bot runs.

## Run and stop

Phicc, bridge off (current behavior):

```bash
export DISCORD_TOKEN="paste-token-here"
node bot.js
```

Phicc, bridge on:

```bash
export DISCORD_TOKEN="paste-token-here"
export PHICC_BRIDGE_ENABLED=true
export DBR_FEATURES_ENABLED=true
export COMMS_WEBHOOK_URL="paste-from-routines-panel"
export COMMS_WEBHOOK_KEY="paste-from-routines-panel"
node bot.js
```

Standalone fork:

```bash
export DISCORD_TOKEN_DEV="paste-token-here"
export COMMS_WEBHOOK_URL="paste-from-routines-panel"
export COMMS_WEBHOOK_KEY="paste-from-routines-panel"
node bridge.js
```

`features.enabled` must be true in `config.local.json` or `DBR_FEATURES_ENABLED` for `bridge.js` to log in. If it is false, the process prints `bridge_disabled` and exits without connecting.

Stop with Ctrl-C, or with the process supervisor you already use. There is no new always-on host in this change.

`auth.json` is still read when it is present, and it is still gitignored. The process no longer crashes when the file is missing, because login has always used `DISCORD_TOKEN`. Prefer the environment variable. Do not put a token in `auth.json` and commit it.

## Rollback

1. `touch` the STOP file. The bridge goes quiet on the next event. `!!` commands are unaffected.
2. Set `PHICC_BRIDGE_ENABLED` to anything other than `true` (or unset it) and set `DBR_FEATURES_ENABLED=false`. Restart `node bot.js`. The bridge listener is gone. The old commands are the only `messageCreate` handler.
3. If you were running `node bridge.js`, stop that process. Phicc does not depend on it.
4. To drop the code, revert this pull request. Nothing was pushed to the default branch directly.
5. If the token might have leaked: reset it in the Developer Portal, update the environment variable, restart. Also pause or rotate the routine webhook key. Kicking the bot from the server stops it immediately.

## Token rotation

Reset the token in the Developer Portal, update the env var, restart. Do this if you suspect a leak, when someone who could see the secret stops working on the bot, and about every 90 days. Logs redact token-shaped strings. Do not attach a listener to discord.js `debug` events: that library can print part of the token there.

## While you are testing for the first time

Do this only after you have decided the test channel and the token are ready. This repository's tests are offline and do not perform these steps.

1. Start with the kill switch in place, or with sending left unused, and confirm the process reaches `ready` in the test guild and posts nothing.
2. Remove the kill switch. Mention the bot. You should see the eyes reaction (if the invite allows it), one inbox file, one webhook run, then a reply to that message and a move to `done/`.
3. A message in another channel, from another user, without a mention, or with only `@everyone` or a role mention, gets no reply.
4. `!!rulereader` and `!!reactionroletest` still do what they did before, with the flag on and with it off.

Close code 4014 means a privileged intent was requested and is not enabled in the portal. This bridge asks for 513 only. If you see 4014, something else is requesting Message Content, members, or presence.

## What this does not do

No slash commands, voice, moderation, role changes, DMs, history backfill, or Administrator permission. The bridge does not run tools, spend money, or post outside the channel the mention came from. Comms Bot has to treat the inbox text as untrusted data.
