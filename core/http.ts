import { authenticate, beginLogin, finishLogin, logout } from "./auth";
import { discord, DiscordError, inviteUrl, resources } from "./discord";
import { missingConfiguration, type AppEnvironment } from "./contracts";
import { validateSettings } from "../shared/settings";

const json = (body: unknown, status = 200) => Response.json(body, { status });

class PayloadTooLarge extends Error {}
async function readJson(request: Request): Promise<unknown> {
  const limit = 16_384;
  if (Number(request.headers.get("Content-Length")) > limit) throw new PayloadTooLarge();
  if (!request.body) throw new SyntaxError("Missing request body.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new PayloadTooLarge(); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

async function route(request: Request, env: AppEnvironment): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/") && !path.startsWith("/auth/")) return env.assets.fetch(request);
  const missing = missingConfiguration(env);
  if (path === "/api/session" && request.method === "GET") {
    if (missing.length) return json({ configured: false, authenticated: false, missing, hosting: env.hosting });
    const session = await authenticate(request, env);
    return json({ configured: true, authenticated: !!session, missing: [], user: session?.user, hosting: env.hosting,
      ...(session ? { guildId: env.DISCORD_GUILD_ID, inviteUrl: inviteUrl(env) } : {}) });
  }
  if (missing.length) return json({ error: "Complete the Discord deployment configuration first." }, 503);
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("Origin") !== url.origin) return json({ error: "Request origin is not allowed." }, 403);
  if (path === "/auth/login" && request.method === "GET") return beginLogin(request, env);
  if (path === "/auth/callback" && request.method === "GET") return finishLogin(request, env);
  if (path === "/auth/logout" && request.method === "POST") return logout(request, env);
  const session = await authenticate(request, env);
  if (!session) return json({ error: "Sign in as a manager of this Discord server to continue." }, 401);
  const guild = env.guild;
  if (path === "/api/dashboard" && request.method === "GET") return json(await guild.dashboard());
  if (path === "/api/resources" && request.method === "GET") {
    const data = await resources(env);
    await guild.updateChannels(data.channels);
    return json(data);
  }
  if (path === "/api/settings" && request.method === "PUT") {
    const settings = validateSettings(await readJson(request));
    const data = await resources(env);
    if (settings.honeypotChannelIds.some((id) => !data.channels.some((c) => c.id === id && [0, 5].includes(c.type)))) return json({ error: "Choose text or announcement honeypot channels from this server." }, 400);
    if (settings.reviewChannelId && !data.channels.some((c) => c.id === settings.reviewChannelId && [0, 5].includes(c.type))) return json({ error: "Choose a text review channel from this server." }, 400);
    if (settings.excludedRoleIds.some((id) => id === env.DISCORD_GUILD_ID || !data.roles.some((role) => role.id === id))) return json({ error: "Choose valid roles from this server; @everyone cannot be excluded." }, 400);
    await guild.updateChannels(data.channels);
    await guild.saveSettings(settings);
    return json({ settings });
  }
  if (path === "/api/gateway/start" && request.method === "POST") return json(await guild.start());
  if (path === "/api/gateway/stop" && request.method === "POST") return json(await guild.stop());
  if (path === "/api/jobs/retry" && request.method === "POST") { await guild.retryJobs(); return json({ ok: true }); }
  const flagRoute = path.match(/^\/api\/flags\/([a-f0-9-]{36})$/);
  if (flagRoute && request.method === "PATCH") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || !("status" in body) || (body.status !== "confirmed" && body.status !== "dismissed")) return json({ error: "Choose confirm or dismiss." }, 400);
    return await guild.resolveFlag(flagRoute[1], body.status, session.user.id) ? json({ ok: true }) : json({ error: "This flag has already been reviewed or was removed." }, 409);
  }
  if (path === "/api/setup/check" && request.method === "GET") {
    const [data, bot] = await Promise.all([resources(env), discord<{ id: string; username: string }>("/users/@me", env.DISCORD_BOT_TOKEN!)]);
    return json({ ok: true, guildName: data.guild.name, botName: bot.username, note: "Bot credentials and server access verified. Check channel permissions and Message Content Intent in Discord, then start protection." });
  }
  return json({ error: "Not found." }, 404);
}

export async function handleRequest(request: Request, env: AppEnvironment): Promise<Response> {
  let response: Response;
  try { response = await route(request, env); }
  catch (error) {
    if (error instanceof PayloadTooLarge) response = json({ error: "Request body must be at most 16 KB." }, 413);
    else if (error instanceof DiscordError) response = json({ error: error.message }, error.status === 429 ? 429 : 502);
    else if (error instanceof SyntaxError) response = json({ error: "Invalid JSON request." }, 400);
    else if (error instanceof Error && /Invalid |must be|Choose |honeypot|review channel/.test(error.message)) response = json({ error: error.message }, 400);
    else { console.error(JSON.stringify({ event: "request_failed", path: new URL(request.url).pathname })); response = json({ error: "Something went wrong. Please try again." }, 500); }
  }
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.discordapp.com data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (new URL(request.url).pathname.startsWith("/api/") || new URL(request.url).pathname.startsWith("/auth/")) headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
