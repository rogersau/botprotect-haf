import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../../server/app";
import { readConfig, type ServerConfig } from "../../server/config";
import { hashToken } from "../../core/auth";

const cleanups: (() => Promise<void>)[] = [];
const nativeFetch = globalThis.fetch;
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(overrides: Partial<ServerConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "botprotect-http-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const assetsDir = join(directory, "client");
  await mkdir(join(assetsDir, "assets"), { recursive: true });
  await writeFile(join(assetsDir, "index.html"), "<!doctype html><title>BotProtect test</title>");
  await writeFile(join(assetsDir, "assets/app.js"), "console.log('test');");
  const app = await startServer({ ...readConfig({}), port: 0, dataDir: join(directory, "data"), assetsDir, ...overrides });
  cleanups.push(() => app.close());
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  return { app, origin: `http://127.0.0.1:${address.port}` };
}
const credentials = { DISCORD_BOT_TOKEN: "test-only", DISCORD_CLIENT_ID: "100000000000000001", DISCORD_CLIENT_SECRET: "test-only", DISCORD_GUILD_ID: "100000000000000002" };

describe("Docker HTTP and proxy boundaries", () => {
  it("serves the dashboard, assets, health, and Docker setup metadata", async () => {
    const f = await fixture();
    expect(await (await nativeFetch(`${f.origin}/healthz`)).json()).toEqual({ status: "ok" });
    expect(await (await nativeFetch(`${f.origin}/`)).text()).toContain("BotProtect test");
    const script = await nativeFetch(`${f.origin}/assets/app.js`);
    expect(script.headers.get("Content-Type")).toContain("text/javascript");
    expect(script.headers.get("Cache-Control")).toContain("immutable");
    expect(await (await nativeFetch(`${f.origin}/api/session`)).json()).toMatchObject({ hosting: "docker", configured: false, authenticated: false });
    expect((await nativeFetch(`${f.origin}/assets/missing.js`)).status).toBe(404);
    expect((await nativeFetch(`${f.origin}/.env`)).status).toBe(404);
  });
  it("uses PUBLIC_URL for HTTPS OAuth redirects and cookies despite spoofed proxy headers", async () => {
    const f = await fixture({ ...credentials, publicUrl: "https://botprotect.example" });
    const response = await nativeFetch(`${f.origin}/auth/login`, { redirect: "manual", headers: { Host: "attacker.example", "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "http" } });
    expect(new URL(response.headers.get("Location")!).searchParams.get("redirect_uri")).toBe("https://botprotect.example/auth/callback");
    expect(response.headers.getSetCookie()[0]).toContain("; Secure");
  });
  it("completes OAuth through a proxy, preserves both cookies, and enforces the configured origin", async () => {
    const f = await fixture({ ...credentials, publicUrl: "https://botprotect.example" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "test-access-token", expires_in: 3600 });
      if (url.includes("/users/@me/guilds")) return Response.json([{ id: credentials.DISCORD_GUILD_ID, owner: true, permissions: "0" }]);
      return Response.json({ id: "100000000000000100", username: "manager", avatar: null });
    });
    const login = await nativeFetch(`${f.origin}/auth/login`, { redirect: "manual" });
    const state = new URL(login.headers.get("Location")!).searchParams.get("state")!;
    const callback = await nativeFetch(`${f.origin}/auth/callback?state=${state}&code=test`, { redirect: "manual", headers: { Cookie: `botprotect_state=${state}` } });
    expect(callback.status).toBe(302);
    const cookies = callback.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("botprotect_state=; ");
    expect(cookies[1]).toContain("botprotect_session=");
    const sessionCookie = cookies[1].split(";")[0];
    const dashboard = await nativeFetch(`${f.origin}/api/dashboard`, { headers: { Cookie: sessionCookie } });
    expect(dashboard.status).toBe(200);
    expect((await dashboard.text())).not.toContain("test-access-token");
    const logout = await nativeFetch(`${f.origin}/auth/logout`, { method: "POST", headers: { Origin: "https://botprotect.example", Cookie: sessionCookie } });
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie()[0]).toContain("Max-Age=0; Secure");
    expect((await nativeFetch(`${f.origin}/api/dashboard`, { headers: { Cookie: sessionCookie } })).status).toBe(401);
    expect((await nativeFetch(`${f.origin}/api/gateway/start`, { method: "POST", headers: { Origin: "http://attacker.example" } })).status).toBe(403);
  });
  it("revokes a live session if guild management permission is removed", async () => {
    const f = await fixture(credentials);
    const token = "a".repeat(64);
    await f.app.service.createSession(await hashToken(token), { user: { id: "100000000000000100", username: "manager", avatar: null }, accessToken: "test-only", expiresAt: Date.now() + 60000 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([{ id: credentials.DISCORD_GUILD_ID, owner: false, permissions: "0" }]));
    expect((await nativeFetch(`${f.origin}/api/dashboard`, { headers: { Cookie: `botprotect_session=${token}` } })).status).toBe(401);
  });
  it("rejects unsafe external origins and accepts HTTPS Tailscale origins", () => {
    for (const publicUrl of ["http://public.example", "https://user:password@example.com", "https://example.com/path", "https://example.com?next=evil", "invalid"]) expect(() => readConfig({ PUBLIC_URL: publicUrl })).toThrow();
    expect(readConfig({ PUBLIC_URL: "https://botprotect.tail123.ts.net" }).publicUrl).toBe("https://botprotect.tail123.ts.net");
    expect(readConfig({ PUBLIC_URL: "http://localhost:3000" }).publicUrl).toBe("http://localhost:3000");
  });
});
