<img src="public/icon.svg" width="64" height="64" alt="BotProtect shield">

# BotProtect

**A quiet watch over your Discord community. Brought to you by HAFBOT.**

Open-source honeypot and cross-channel spam detection for **one Discord server per
deployment**, owned and managed by that server’s team. Runs as a Cloudflare Worker
with one SQLite Durable Object. No shared service, external database, or HAFBOT
subscription is required.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rogersau/botprotect-haf)

## Protection

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
Staff apply account-level actions in Discord. Both detectors are included under MIT.

## Deploy and set up Discord

1. [Create a Discord application](https://discord.com/developers/applications).
   Open **Bot**, copy the token, and enable **Message Content Intent**. No other
   privileged intent is needed. Use a **dedicated application per deployment**;
   sharing a bot token with another running bot can interfere with gateway sessions.
2. Click **Deploy to Cloudflare**. Cloudflare copies the public source to your Git
   account and provisions the Worker and Durable Object. If asked, use
   `npm run build` for build and `npx wrangler deploy` for deploy. Enter the four
   values below as **Worker runtime secrets**, not just build variables.
3. In Discord **OAuth2 → Redirects**, add the exact deployed callback URL:
   `https://YOUR-WORKER.workers.dev/auth/callback`. Use your custom domain if
   applicable. The app’s Setup Guide displays its current callback URL.
4. Invite the bot through **Installation → Guild Install** with the `bot` scope and
   **View Channels**, **Send Messages**, **Embed Links**, and **Manage Messages**.
   Do not grant Administrator. A guild-restricted invite link is also available
   after dashboard sign-in.
5. Sign in with Discord. Configure your detectors in **Protections**, save, and
   **Start protection**. Use **Check connection** to verify bot credentials and guild
   access; it does not check every channel overwrite or privileged intent.

| Worker secret | Where to get it |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Developer Portal → application → Bot → token |
| `DISCORD_CLIENT_ID` | General Information → Application ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 → Client Secret |
| `DISCORD_GUILD_ID` | Enable Discord Developer Mode; right-click server → Copy Server ID |

The deploy flow discovers inputs from `.dev.vars.example`; `package.json` includes
their descriptions. Verify values under **Worker → Settings → Variables and
Secrets**. Never commit real credentials.

Create a clearly marked **#do-not-post** honeypot with an explicit warning in its
name, topic, and pinned message. Members must be able to **see and send messages**
in it. Do not use normal chat, rules, welcome, forum, or media channels as traps.
Give the bot access to monitored channels, plus Send Messages and Embed Links in
a private staff review channel. Manage Messages is needed when deletion is enabled.

Start with flags only, exclude trusted staff, and test with a separate non-excluded
member account. Review false positives before enabling deletion. Discord
notifications link to evidence; resolve flags in the web dashboard.

## Hosting and operation

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

Requires Node.js 22.12 or newer.

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
npm run check               # TypeScript, workerd tests, production build
npx playwright install chromium
npm run test:e2e            # Desktop and mobile browser checks
npm run cf-typegen          # Bindings generated from Wrangler configuration
npm run build
npx wrangler deploy --dry-run
```

For CLI deployment, run `npx wrangler login`, then `npm run deploy`. Set each secret
using `npx wrangler secret put NAME` and finish Discord setup above. Each guild
needs its own deployment and dedicated Discord application.

## Data and access

Data stays in your Cloudflare account. Normal messages are reduced to SHA-256
fingerprints for at most five minutes. Queued gateway messages briefly retain text
until processed; flags retain up to 500 characters of evidence for **30 days**.
Deduplication IDs are kept for 24 hours; aggregate daily counts for 30 days.
Cleanup runs in alarms and the cron. The dashboard shows the latest 100 flags.

OAuth access tokens remain server-side. Session cookies are opaque, HTTP-only,
SameSite=Lax, and Secure on HTTPS. Only hashes of cookie tokens are stored for
lookup. Sessions expire after eight hours or the OAuth token lifetime, whichever
is shorter. Logout deletes the session. Browser-bound OAuth state is single-use
and expires after ten minutes. API writes require a matching Origin header.
Bot tokens and client secrets never enter the browser.

Only `DISCORD_GUILD_ID` is protected. Events from other guilds are discarded.
Changing that ID selects a different Durable Object and does not move old history.
Delete the old deployment/namespace in Cloudflare when retiring it to remove its data.

## Source and license

- `worker/`: authentication/API, Discord adapter, gateway, and SQLite storage.
- `shared/`: settings contract and validation.
- `src/`: React dashboard and labelled sample data.
- `tests/`: protection, persistence, action, and auth tests running in workerd.
- `e2e/`: desktop/mobile settings, review, setup, and live/demo separation checks.

Adapted from [HAFBot](https://github.com/rogersau/hafbot), attributed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Licensed under [MIT](LICENSE).
See [Cloudflare deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
and [Discord’s Gateway documentation](https://docs.discord.com/developers/events/gateway)
for the underlying deployment and connection requirements.
