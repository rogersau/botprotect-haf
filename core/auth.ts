import { timingSafeEqual } from "node:crypto";
import type { AppEnvironment, StoredSession } from "./contracts";
import { canManageGuild, discord } from "./discord";

export const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function hashToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function cookie(request: Request, name: string): string | null {
  return request.headers.get("Cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

function setCookie(request: Request, name: string, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function authenticate(request: Request, env: AppEnvironment): Promise<StoredSession | null> {
  const id = cookie(request, "botprotect_session");
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  const session = await env.guild.getSession(await hashToken(id));
  if (!session || session.expiresAt <= Date.now()) return null;
  try {
    return await canManageGuild(session.accessToken, env.DISCORD_GUILD_ID!) ? session : null;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 401) return null;
    throw error;
  }
}

export async function beginLogin(request: Request, env: AppEnvironment): Promise<Response> {
  const state = randomToken();
  await env.guild.createOAuthState(await hashToken(state));
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID!, redirect_uri: `${new URL(request.url).origin}/auth/callback`,
    response_type: "code", scope: "identify guilds", state,
  });
  return new Response(null, { status: 302, headers: { Location: `https://discord.com/oauth2/authorize?${params}`, "Set-Cookie": setCookie(request, "botprotect_state", state, 600) } });
}

export async function finishLogin(request: Request, env: AppEnvironment): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const stored = cookie(request, "botprotect_state") || "";
  const clearState = setCookie(request, "botprotect_state", "", 0);
  const fail = (reason: string) => new Response(null, { status: 302, headers: { Location: `/?auth_error=${encodeURIComponent(reason)}`, "Set-Cookie": clearState } });
  if (!/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(stored)) return fail("The sign-in request expired. Please try again.");
  const a = new TextEncoder().encode(state);
  const b = new TextEncoder().encode(stored);
  if (!timingSafeEqual(a, b) || !await env.guild.consumeOAuthState(await hashToken(state))) return fail("The sign-in request expired. Please try again.");
  if (!url.searchParams.get("code")) return fail("Discord sign-in was cancelled.");
  const response = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID!, client_secret: env.DISCORD_CLIENT_SECRET!, grant_type: "authorization_code", code: url.searchParams.get("code")!, redirect_uri: `${url.origin}/auth/callback` }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) { await response.body?.cancel(); return fail("Discord could not complete sign-in. Check the OAuth2 redirect URL and credentials."); }
  const tokens = await response.json<{ access_token: string; expires_in: number }>();
  if (!await canManageGuild(tokens.access_token, env.DISCORD_GUILD_ID!)) return fail("You need Manage Server or Administrator permission in this deployment’s Discord server.");
  const user = await discord<StoredSession["user"]>("/users/@me", tokens.access_token, {}, true);
  const id = randomToken();
  const maxAge = Math.max(0, Math.min(8 * 3600, tokens.expires_in));
  await env.guild.createSession(await hashToken(id), { user: { id: user.id, username: user.username, avatar: user.avatar }, accessToken: tokens.access_token, expiresAt: Date.now() + maxAge * 1000 });
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", setCookie(request, "botprotect_session", id, maxAge));
  return new Response(null, { status: 302, headers });
}

export async function logout(request: Request, env: AppEnvironment): Promise<Response> {
  const id = cookie(request, "botprotect_session");
  if (id) await env.guild.deleteSession(await hashToken(id));
  return new Response(null, { status: 204, headers: { "Set-Cookie": setCookie(request, "botprotect_session", "", 0) } });
}
