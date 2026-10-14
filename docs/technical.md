# BotProtect technical guide

For a plain-language introduction, start with the [README](../README.md).
For self-hosting, HTTPS, Tailscale, updates, and backups, use the
[Docker deployment guide](docker.md).

Each deployment protects one Discord guild using a dedicated Discord application.
The Cloudflare runtime uses one Worker and one SQLite Durable Object. The Docker
runtime uses a Node.js HTTP server and file-backed SQLite. Neither needs an
external database or a shared HAFBOT service.

## Protection behavior

- **Honeypot:** flags members posting in a clearly marked trap channel, including
  text-channel threads. Forum and media posts are excluded.
- **Cross-channel spam:** flags the same member repeating the same normalized
  message across distinct channels. Defaults to **5 channels / 60 seconds**. Case,
  whitespace, and full-width Unicode differences are ignored. Empty and
  attachment-only messages do not count.
- **Exemptions:** bots, webhooks, and configured trusted roles bypass detection.
- **Review:** one unresolved flag per member, evidence, Confirm Bot / Dismiss,
  reviewer ID, and decision time. Confirmation records a decision only.
- **Message actions:** optional warning and deletion, configured per detector.
  These run on every trip, even while a member already has an unresolved flag.
- **Guild management:** Discord sign-in with owner, Administrator, or Manage Server
  permission. Permissions are checked against Discord on every API request.

BotProtect never automatically bans, kicks, times out, or changes member roles.
Staff apply account-level actions in Discord.

## Discord credentials

[Create a Discord application](https://discord.com/developers/applications).
Open **Bot**, copy the token, and enable **Message Content Intent**. No other
privileged intent is needed. Use a **dedicated application per deployment**;
sharing a bot token with another running bot can interfere with gateway sessions.

Both hosting options need the same four values:

| Setting | Where to get it |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Developer Portal → application → Bot → token |
| `DISCORD_CLIENT_ID` | General Information → Application ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 → Client Secret |
| `DISCORD_GUILD_ID` | Discord user settings → Advanced → Developer Mode; right-click server → Copy Server ID |

Keep real credentials out of Git. For Cloudflare, use Worker runtime secrets as
described below. For Docker, put them in the `.env` file described in the
[Docker guide](docker.md#start-locally).

## Cloudflare setup

1. Create your dedicated Discord application and collect the
   [four credentials](#discord-credentials).
2. Click **Deploy to Cloudflare**. Cloudflare copies the public source to your Git
   account and provisions the Worker and Durable Object. If asked, use
   `npm run build` for build and `npx wrangler deploy` for deploy. Enter the four
   values as **Worker runtime secrets**, not just build variables.
3. In Discord **OAuth2 → Redirects**, add the exact deployed callback URL:
   `https://YOUR-WORKER.workers.dev/auth/callback`. Use your custom domain if
   applicable. The app’s Setup Guide displays its current callback URL.
4. [Invite the bot](#invite-the-bot) and finish the protection setup below.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rogersau/botprotect-haf)

The deploy flow discovers inputs from `.dev.vars.example`; `package.json` includes
their descriptions. Verify values under **Worker → Settings → Variables and
Secrets**.

## Invite the bot

In the Discord Developer Portal, open your application’s **Installation → Guild
Install** settings. Select the `bot` scope and these permissions:

- **View Channels** for monitored channels.
- **Send Messages** and **Embed Links** for warnings and the private staff review
  channel.
- **Manage Messages** when deletion is enabled.

Do not grant Administrator. Use the installation link to invite the bot to the
configured server. A guild-restricted invite link is also available after
dashboard sign-in. Check channel-specific permission overrides as well as the
bot’s server role.

## Configure and validate protection

Sign in with Discord as the server owner or a member with Administrator or Manage
Server permission. Configure your detectors in **Protections**, save, and select
**Start protection**. Use **Check connection** to verify bot credentials and guild
access; it does not check every channel overwrite or privileged intent.

Create a clearly marked **#do-not-post** honeypot with an explicit warning in its
name, topic, and pinned message. Members must be able to **see and send messages**
in it. Do not use normal chat, rules, welcome, forum, or media channels as traps.
Give the bot access to monitored channels, plus Send Messages and Embed Links in
a private staff review channel. Manage Messages is needed when deletion is enabled.

Start with flags only, exclude trusted staff, and test with a separate non-excluded
member account in a test guild. With default settings, a post in the trap channel
should create a flag. Dismiss it before testing repeated messages in five distinct
channels within 60 seconds, which should create another flag. Confirm that staff
can review the evidence and dismiss a flag. Review false positives before enabling deletion. Discord
notifications link to evidence; resolve flags in the web dashboard.

### Setup troubleshooting

- **Demo mode:** finish setting all four Discord values. Without credentials, the
  app displays sample data; demo actions do not reach Discord.
- **Discord sign-in fails:** check that the OAuth2 redirect matches the exact
  website origin and `/auth/callback` path. Docker’s `PUBLIC_URL` must match the
  address used by the browser.
- **Connection check fails:** verify the dedicated bot token, configured server
  ID, and that the bot has been invited to that server.
- **Connected, but no flags:** check Message Content Intent, channel permissions,
  saved detector settings, and whether the test account has an excluded role.
  Bot and webhook messages are always excluded.
- **Warnings or deletion fail:** check the bot’s permissions in the affected
  channel. Failed actions appear in the dashboard and can be retried.

## Cloudflare hosting and operation

The following usage notes apply to Cloudflare. For Docker host operation,
updates, backups, and recovery, see the [Docker guide](docker.md).

Discord requires an ongoing **outbound WebSocket**. Outbound connections cannot
use Durable Object WebSocket hibernation: ongoing compute usage applies even in
a quiet server. This is not a promise of free hosting. Check
[Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [outbound WebSocket behavior](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
for current limits and rates. Other applications share your account’s allowances.

The gateway persists sessions, resume sequence, and its inbox. It handles heartbeats
and acknowledgements, invalid sessions, fatal token/intent errors, and reconnect
backoff. An alarm drives heartbeats and retries; a five-minute cron checks recovery.
Pausing stops the gateway; previously queued message actions can finish. Outages
and deployments can interrupt coverage; session resumption is best effort, not
guaranteed message-history replay.

Discord message actions are queued durably. Rate limits delay pending requests;
transient failures retry with backoff. Permanent failures appear in the dashboard
with a retry action. Deletion tolerates already-deleted messages. Message creation
uses Discord’s nonce deduplication; delivery is at least once, and notifications
can duplicate after an extended interruption.

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm run dev
```

Open `http://localhost:5173`. Without credentials, the app shows a labelled demo.
Demo actions affect only the current page and never reach Discord.

For a live local connection, copy `.dev.vars.example` to `.dev.vars`, fill in the
values, and register `http://localhost:5173/auth/callback` in Discord OAuth2.
Use a separate test application and guild. Start opens a real gateway connection;
do not reuse a bot token already running elsewhere.

```sh
npm run check               # TypeScript, workerd + Node tests, Cloudflare build
npx playwright install chromium
npm run test:e2e            # Desktop and mobile browser checks
npm run cf-typegen          # Bindings generated from Wrangler configuration
npm run build
npx wrangler deploy --dry-run
```

For CLI deployment, run `npx wrangler login`, then `npm run deploy`. Set each secret
using `npx wrangler secret put NAME` and finish [Discord setup](#discord-credentials).
Each guild needs its own deployment and dedicated Discord application.

For the real-container checks and desktop/mobile browser checks against Docker,
see [Docker validation](docker.md#validate-the-deployment).

## Data and access

Data stays in your Cloudflare account or your Docker data volume. Normal messages
are reduced to SHA-256 fingerprints for at most five minutes. Queued gateway
messages briefly retain text until processed; flags retain up to 500 characters
of evidence for **30 days**. Deduplication IDs are kept for 24 hours; aggregate
daily counts for 30 days. Cleanup runs in alarms and the cron. The dashboard shows
the latest 100 flags.

OAuth access tokens remain server-side. Session cookies are opaque, HTTP-only,
SameSite=Lax, and Secure on HTTPS. Only hashes of cookie tokens are stored for
lookup. Sessions expire after eight hours or the OAuth token lifetime, whichever
is shorter. Logout deletes the session. Browser-bound OAuth state is single-use
and expires after ten minutes. API writes require a matching Origin header.
Bot tokens and client secrets never enter the browser.

Only `DISCORD_GUILD_ID` is protected. Events from other guilds are discarded.
On Cloudflare, changing that ID selects a different Durable Object and does not
move old history; delete the old deployment/namespace when retiring it to remove
its data. Docker rejects a guild ID change against an existing database; use a
separate Compose project and data volume for a different guild.

## Source and license

- `core/`: shared detection, Discord gateway, SQLite queries, authentication, and API.
- `worker/`: Cloudflare Durable Object and Worker adapters.
- `server/`: Node HTTP server, file-backed SQLite, and timer adapter.
- `compose*.yml` and `deploy/`: Docker, Caddy HTTPS, and optional Tailscale setup.
- `shared/`: settings contract and validation.
- `src/`: React dashboard and labelled sample data.
- `tests/`: protection, persistence, action, and auth tests in workerd and Node.
- `e2e/`: desktop/mobile settings, review, setup, and live/demo separation checks.

Adapted from [HAFBot](https://github.com/rogersau/hafbot), attributed in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Licensed under [MIT](../LICENSE).
See [Cloudflare deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
and [Discord’s Gateway documentation](https://docs.discord.com/developers/events/gateway)
for the underlying deployment and connection requirements.
