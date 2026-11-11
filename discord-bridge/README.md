# discord-bridge

Forkable mention bridge for a Discord bot and a Grok Bot teammate.

The bridge process is the only thing that holds the Discord token. It accepts `@mentions` from allowlisted users (or roles) in allowlisted guilds and channels, writes one JSON file per message under `queue/{inbox,outbox,done,dead}`, and POSTs a tiny wake body to a Grok Bot routine webhook. Comms Bot reads the inbox and writes the outbox. The bridge replies in Discord with `allowedMentions` set to `{ "parse": [] }`.

Phicc loads this library only when `PHICC_BRIDGE_ENABLED=true`. See the repo `RUNBOOK.md` for the invite URL, env vars, kill switch, and rollback. Do not add a license file here unless the repo owner decides to.

## Layout

```text
src/config.js      example defaults, then config.local.json, then DBR_* env
src/policy.js      allowlists, mention gate, DM block, rate limits, kill switch
src/queue.js       atomic inbox writes, exclusive create, done and dead moves
src/wake.js        coalesced webhook POST, backoff, 200 = run started
src/client.js      discord.js client with intents 513 only
src/bridge.js      wires policy, queue, wake, and replies
standalone.js      process entry used by ../bridge.js
```

## Forking

1. Copy `discord-bridge/`, `bridge.js`, `config.example.json`, `scripts/perm-calc.js`, and `RUNBOOK.md`.
2. Keep discord.js on the same major as the host bot. This tree stays on `discord.js` 13.6 because Phicc's existing commands use `MessageEmbed` and the adapter shares one client. A v14 upgrade has to be its own change.
3. Create `config.local.json` (mode 600) from the example. Never commit it, `.env`, or `auth.json`.
4. Put the token in the env var named by `discord.tokenEnv`. Put the routine URL and bearer key in `COMMS_WEBHOOK_URL` and `COMMS_WEBHOOK_KEY`.
5. Run `node bridge.js`. With `features.enabled` false, it does not log in.

Permissions: **68608** (view, send, history) or **68672** (also reactions). **85056** adds embeds, which this bridge does not send. Never Administrator. Intents: **513**. No Message Content. `usersOnly` defaults to true. Enabled startup requires an HTTPS webhook whose host is allowlisted, plus `QUEUE_HMAC_KEY`.

`node --test tests/` from the repo root runs the offline suite. Discord and the webhook are mocked.
