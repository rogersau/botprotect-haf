import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../worker/index";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { guildStub, type Env } from "../worker/env";
import { hashToken } from "../worker/auth";

const bindings = env as Env;
const origin = "https://botprotect.example";
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe("HTTP authentication boundary", () => {
  it("reports missing configuration without exposing secrets or data", async () => {
    const response = await worker.fetch(new Request(`${origin}/api/session`), { ...bindings, DISCORD_BOT_TOKEN: undefined });
    expect(await response.json()).toEqual({ configured: false, authenticated: false, missing: ["DISCORD_BOT_TOKEN"] });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("rejects unauthenticated reads and cross-origin writes", async () => {
    expect((await worker.fetch(new Request(`${origin}/api/dashboard`), bindings)).status).toBe(401);
    expect((await worker.fetch(new Request(`${origin}/api/gateway/start`, { method: "POST", headers: { Origin: "https://untrusted.example" } }), bindings)).status).toBe(403);
  });
  it("binds OAuth state to the browser cookie and consumes it exactly once", async () => {
    const login = await worker.fetch(new Request(`${origin}/auth/login`), bindings);
    const location = new URL(login.headers.get("Location")!);
    const state = location.searchParams.get("state")!;
    expect(location.searchParams.get("scope")).toBe("identify guilds");
    expect(login.headers.get("Set-Cookie")).toContain("HttpOnly; SameSite=Lax");
    expect(login.headers.get("Set-Cookie")).toContain("Secure");
    const callback = await worker.fetch(new Request(`${origin}/auth/callback?state=${state}&error=access_denied`, { headers: { Cookie: `botprotect_state=${state}` } }), bindings);
    expect(callback.headers.get("Location")).toContain("auth_error=");
    expect(await guildStub(bindings).consumeOAuthState(await hashToken(state))).toBe(false);
  });
  it("revokes dashboard access when the user loses guild permissions", async () => {
    const id = "a".repeat(64);
    await guildStub(bindings).createSession(await hashToken(id), { user: { id: "100000000000000100", username: "manager", avatar: null }, accessToken: "test-only", expiresAt: Date.now() + 60000 });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([{ id: bindings.DISCORD_GUILD_ID, owner: false, permissions: "32" }])));
    const request = () => new Request(`${origin}/api/dashboard`, { headers: { Cookie: `botprotect_session=${id}` } });
    expect((await worker.fetch(request(), bindings)).status).toBe(200);
    fetcher.mockResolvedValue(new Response(JSON.stringify([{ id: bindings.DISCORD_GUILD_ID, owner: false, permissions: "0" }])));
    expect((await worker.fetch(request(), bindings)).status).toBe(401);
  });
  it("limits mutation bodies even without a Content-Length header", async () => {
    const id = "b".repeat(64);
    await guildStub(bindings).createSession(await hashToken(id), { user: { id: "100000000000000100", username: "manager", avatar: null }, accessToken: "test-only", expiresAt: Date.now() + 60000 });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify([{ id: bindings.DISCORD_GUILD_ID, owner: true, permissions: "0" }])));
    const response = await worker.fetch(new Request(`${origin}/api/settings`, { method: "PUT", headers: { Origin: origin, Cookie: `botprotect_session=${id}` }, body: "x".repeat(17000) }), bindings);
    expect(response.status).toBe(413);
  });
});
