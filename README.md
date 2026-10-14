<img src="public/icon.svg" width="64" height="64" alt="BotProtect shield">

# BotProtect

**A quiet watch over your Discord community. Brought to you by HAFBOT.**

BotProtect helps your moderation team spot suspicious activity in your Discord
server. It comes with a website where staff can set up protection and review
flagged members.

Each installation belongs to **one Discord server** and is managed by that server’s
team. BotProtect is free, open source, and does not require a HAFBOT subscription.
Hosting services have their own plans and usage limits.

## What does it do?

- **Catches posts in a trap channel.** Create a clearly marked “do not post”
  channel. BotProtect flags members who post there for your team to review.
- **Spots repeated messages across channels.** By default, it flags someone who
  sends the same message in five different channels within 60 seconds.
- **Keeps your team in control.** Review the evidence and confirm or dismiss each
  flag. You can also enable message deletion for either protection.

Connection status, protection settings, and the review queue are on one page.

BotProtect never automatically bans, kicks, or times out members. Confirming a
flag records your decision; any action against the member is taken in Discord.

## Get started with Cloudflare

**Recommended if you do not want to manage a server.** Setup happens in your
browser, and your computer does not need to stay on. Cloudflare offers a free
plan with usage limits; see the [hosting notes](docs/technical.md#cloudflare-hosting-and-operation)
before choosing a plan.

You will need a Cloudflare account, a GitHub account, and permission to manage your
Discord server. There are a few setup steps because Discord needs to know which
bot and server belong to your installation.

1. **Create your Discord bot.** Open the
   [Discord Developer Portal](https://discord.com/developers/applications) and
   create a new application just for BotProtect. In its **Bot** settings, enable
   **Message Content Intent** so it can check messages. You will need its bot
   token, Application ID, client secret, and your Discord server ID.
   [See where to find each value](docs/technical.md#discord-credentials).
2. **Create your BotProtect website.** Click the button below and follow
   Cloudflare’s prompts. Enter those four values when asked and keep them private.
   [Detailed Cloudflare setup](docs/technical.md#cloudflare-setup) is available if
   you need help with a field.
3. **Connect Discord sign-in.** In your Discord application’s **OAuth2** settings,
   add your new website address followed by `/auth/callback` as a redirect URL.
   For example: `https://your-app.workers.dev/auth/callback`.
4. **Invite the bot.** Use your Discord application’s **Installation** page to add
   it to your server. The [setup guide](docs/technical.md#invite-the-bot) lists the
   permissions it needs.
5. **Turn protection on.** Open your new website and sign in with Discord. In
   **Protection settings**, choose your channels and any trusted roles to exclude, save,
   then select **Start protection**. You must be the server owner or have
   **Administrator** or **Manage Server** permission.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rogersau/botprotect-haf)

If you see **Finish Discord setup**, open **Setup** and complete the missing
Discord details. Sign in before changing settings or starting protection.

## Set up your first protection

Start with flags for review, and leave automatic deletion off while you try it.
You can send notifications to a private staff channel and review flags on the
website.

For a trap channel, use a name such as **#do-not-post** and put a clear warning in
the channel topic and a pinned message. Members must be able to **see it and send
messages** there. Keep normal conversation, rules, and welcome channels separate.

Test in a private test server with a member account that is not excluded by your
trusted-role settings. Post in the trap channel, or repeat a message across five
channels within a minute. Check that a flag appears and that staff can dismiss it.

## Prefer to host it yourself?

If you already have an always-on computer, NAS, or server, you can run BotProtect
with Docker. The [Docker guide](docs/docker.md) covers installation, updates,
backups, and optional private access through Tailscale. This option needs some
technical setup.

For deployment settings, permissions, privacy details, troubleshooting, and
development commands, see the [technical guide](docs/technical.md).

## Open source

BotProtect is adapted from [HAFBot](https://hafbot.xyz) and released
under the [MIT license](LICENSE). See [credits](THIRD_PARTY_NOTICES.md) for the
original project attribution.
