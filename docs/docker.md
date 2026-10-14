# Docker, HTTPS, and Tailscale

For an introduction, start with the [README](../README.md). The
[technical guide](technical.md) covers Discord credentials, permissions, and
protection behavior shared by both hosting options.

BotProtect can run on an always-on VPS, NAS, or home server using Docker Compose.
One container protects one Discord guild. The container serves the dashboard,
maintains the Discord Gateway, and stores settings, sessions, flags, and queued
actions in a persistent SQLite volume. No Cloudflare account is required.

## Start locally

Install Docker Engine/Desktop and Docker Compose v2.17 or newer, then:

```sh
git clone https://github.com/rogersau/botprotect-haf.git
cd botprotect-haf
cp .env.example .env
docker compose up -d --build --wait
```

Open `http://localhost:3000`. Empty Discord credentials show a labelled demo.
Fill in `.env` to connect your dedicated application and guild:

```dotenv
PUBLIC_URL=http://localhost:3000
HTTP_PORT=3000
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-application-id
DISCORD_CLIENT_SECRET=your-oauth-client-secret
DISCORD_GUILD_ID=your-server-id
```

Create the application in the [Discord Developer Portal](https://discord.com/developers/applications).
Enable **Message Content Intent**, and invite it to your guild with View Channels,
Send Messages, Embed Links, and Manage Messages if deletion is enabled. Use a
dedicated bot application for each deployment.

Register `${PUBLIC_URL}/auth/callback` as the application’s OAuth2 redirect URL.
For the local example, that is `http://localhost:3000/auth/callback`. Recreate the
container after editing `.env`:

```sh
docker compose up -d --wait
```

Sign in as a server owner or member with Manage Server/Administrator, configure
the detectors, save, and select **Start protection**. The saved enabled state is
restored when the container starts again. A deliberate Pause remains paused.

The published port binds to **127.0.0.1**. Choose one of the HTTPS options below
for access from other devices. `PUBLIC_URL` is the exact address used by browsers;
it controls OAuth redirects, Origin checks, and Secure cookies. Use an HTTPS
origin without a path. Plain HTTP is accepted only for localhost development.

## Public HTTPS with Caddy

Point a domain at your host and make TCP ports 80 and 443 reachable. In `.env`, set:

```dotenv
PUBLIC_URL=https://botprotect.example.com
```

Start the application and the included Caddy proxy:

```sh
docker compose -f compose.yml -f compose.https.yml up -d --build --wait
```

Caddy obtains and renews the certificate. Register
`https://botprotect.example.com/auth/callback` in Discord and open the HTTPS site.
The application port remains bound to loopback; Caddy forwards through the Compose
network to `botprotect:3000`. Certificate state is kept in separate Docker volumes.

If you already have an HTTPS reverse proxy on the host, use the base Compose file
and forward to `http://127.0.0.1:3000` instead. Set `PUBLIC_URL` to the externally
visible HTTPS origin and register that callback in Discord. The application uses
this configured origin, rather than trusting incoming forwarded headers.

## Private HTTPS with Tailscale

Use this option when the administrators have Tailscale access. The included
configuration enables **Serve within your tailnet** and explicitly disables
Funnel/public exposure. Discord permission checks still apply.

1. Enable MagicDNS and HTTPS certificates in the tailnet. Create a Tailscale auth
   key authorised for this server, with appropriate tailnet access rules for staff.
2. In `.env`, set the hostname, auth key, and the expected full HTTPS address:

   ```dotenv
   TAILSCALE_HOSTNAME=botprotect
   TS_AUTHKEY=your-tailscale-auth-key
   PUBLIC_URL=https://botprotect.YOUR-TAILNET.ts.net
   ```

3. Start both services:

   ```sh
   docker compose -f compose.yml -f compose.tailscale.yml up -d --build --wait
   docker compose -f compose.yml -f compose.tailscale.yml logs --tail=50 tailscale
   docker compose -f compose.yml -f compose.tailscale.yml exec tailscale tailscale status
   ```

4. Confirm the actual hostname. An existing device with the same name can cause
   Tailscale to assign a suffix. If the actual HTTPS origin differs, update
   `PUBLIC_URL` and recreate both services with `up -d --force-recreate --wait`.
5. Register the exact `https://…ts.net/auth/callback` URL in Discord. Open the app
   in a browser connected to the tailnet and sign in with Discord.

The Tailscale service shares the application’s network namespace and proxies to
localhost. It uses userspace networking; no privileged container, host networking,
or TUN device is required. Device identity is persisted in `tailscale-state`, so
restarts retain the node identity. The auth key is only passed to the Tailscale
container. Keep using the same Compose file arguments for future commands.

`--wait` verifies application health, not successful tailnet login. Confirm the
Tailscale status and HTTPS page separately. If the host already runs Tailscale,
you can instead use `tailscale serve --bg http://127.0.0.1:3000` with the base
Compose file and that host’s HTTPS origin.

Bot traffic is outbound to Discord. The OAuth callback is reached by the
administrator’s browser, which must be able to reach the private Tailscale URL.
No public Discord interactions/webhook endpoint is used.

## Updates, backups, and recovery

Keep the host running; sleeping or losing connectivity interrupts coverage.
Docker’s restart policy restarts the app after failure or host reboot. The app
persists gateway resumption data and retries queued actions. Session resumption
after a long outage is best effort and cannot guarantee historical coverage.

Update from the repository using the same Compose files you originally selected:

```sh
git pull --ff-only
docker compose up -d --build --wait
```

For Caddy/Tailscale deployments, include the appropriate `-f` arguments above.
Changing secrets or `PUBLIC_URL` requires container recreation, not just `restart`.
Tailscale’s dependency configuration recreates/restarts its shared network setup
when the app is explicitly updated; include both services in the update command.

Before updating, you can back up the data directory. Stop the app for a consistent
copy of SQLite and its journal files:

```sh
docker compose stop botprotect
docker compose cp botprotect:/app/data ./botprotect-backup
docker compose up -d --wait
```

Keep `.env` securely with your deployment configuration as a separate backup. To
restore, stop the app and copy the backed-up directory’s contents into `/app/data`,
preserving write access for container user UID/GID 1000. Then start the stack.
The SQLite database is locked exclusively while the app runs; stop it before
accessing the database using a separate SQLite tool.

`docker compose down` retains data volumes. **`down --volumes` deletes them.**
Use a separate Compose project (`-p another-guild`), volume, dedicated Discord
application, and browser origin for each guild. Reusing a database for a different
guild is rejected at startup. Run only one app instance per guild and data volume;
this installation is not designed for replicated containers or a shared network
filesystem. Cloudflare and Docker use separate storage; automatic data migration
between them is not included.

The health endpoint is `/healthz`. It checks the HTTP process and SQLite access,
not Discord readiness; the dashboard shows the gateway and failed-action status.
Configure HTTPS/Tailscale health separately through the proxy and monitor the
gateway after starting protection.

## Run without Docker

Node.js 24 or newer is required:

```sh
npm ci
cp .env.example .env
npm run build:docker
npm start
```

`npm start` loads `.env` when present. The default listener is `127.0.0.1:3000`
and the default data directory is `./data`. Optional `HOST`, `PORT`, `DATA_DIR`,
and `ASSETS_DIR` variables configure a bare Node installation. Keep a single
process and use your service manager to restart it after failure.

## Validate the deployment

```sh
npm run check                   # Both runtime suites, types, Cloudflare build
npm run build:docker
npm run test:docker             # Real Compose build, persistence, proxy checks
npx playwright install chromium
npm run test:docker -- --browser # Also run desktop/mobile checks on the container
```

The Docker checks create their own temporary Compose project and remove only
that project’s containers and volumes. They use test credentials; they do not
connect a real Discord bot or join a tailnet. Validate real credentials, tailnet
access, TLS certificates, and live detection using a test guild before rollout.

References: [Docker volumes](https://docs.docker.com/engine/storage/volumes/),
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve),
[Tailscale container](https://tailscale.com/docs/features/containers/docker),
[Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
and [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2).
