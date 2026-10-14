import { expect, test, type Page } from "@playwright/test";
import type { AppSession, Dashboard, GuildResources } from "../shared/types";

const serverId = "100000000000000002";
const trapId = "100000000000000010";
const reviewId = "100000000000000011";
const roleId = "100000000000000020";
const flagId = "00000000-0000-4000-a000-000000000001";
const hosting = process.env.E2E_RUNTIME === "docker" ? "docker" : "cloudflare";
const credentials = ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_GUILD_ID"];

async function session(page: Page, value: AppSession) {
  await page.route("**/api/session", (route) => route.fulfill({ json: { hosting, ...value } }));
}

async function manager(page: Page) {
  const dashboard: Dashboard = {
    settings: {
      honeypotEnabled: true, honeypotChannelIds: [trapId], honeypotDelete: false,
      spamEnabled: true, spamThreshold: 5, spamWindowSeconds: 60, spamDelete: false,
      excludedRoleIds: [], reviewChannelId: null,
    },
    gateway: { status: "stopped", error: null, connectedAt: null, lastEventAt: null },
    jobsPending: 0, jobsFailed: 0,
    flags: [{
      id: flagId, userId: "100000000000000100", username: "test-member", detector: "honeypot",
      channelId: trapId, messageId: "100000000000000200", channelIds: [trapId],
      preview: "A message in the trap channel", createdAt: Date.now(), status: "open",
      resolvedBy: null, resolvedAt: null,
    }],
  };
  const resources: GuildResources = {
    guild: { id: serverId, name: "Test community", icon: null, owner_id: "100000000000000001" },
    channels: [
      { id: trapId, name: "do-not-post", type: 0 },
      { id: reviewId, name: "staff-review", type: 0 },
    ],
    roles: [{ id: roleId, name: "Trusted members", color: 0 }],
  };
  const writes: { path: string; body: unknown }[] = [];
  await session(page, { configured: true, authenticated: true, missing: [], guildId: serverId,
    user: { id: "100000000000000001", username: "manager", avatar: null } });
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: dashboard }));
  await page.route("**/api/resources", (route) => route.fulfill({ json: resources }));
  await page.route("**/api/settings", (route) => {
    const body = route.request().postDataJSON();
    writes.push({ path: "/api/settings", body });
    dashboard.settings = body;
    return route.fulfill({ json: { settings: dashboard.settings } });
  });
  await page.route("**/api/gateway/*", (route) => {
    const path = new URL(route.request().url()).pathname;
    writes.push({ path, body: null });
    dashboard.gateway.status = path.endsWith("/start") ? "ready" : "stopped";
    return route.fulfill({ json: dashboard.gateway });
  });
  await page.route(`**/api/flags/${flagId}`, (route) => {
    const body = route.request().postDataJSON();
    writes.push({ path: `/api/flags/${flagId}`, body });
    Object.assign(dashboard.flags[0], { status: body.status, resolvedBy: "100000000000000001", resolvedAt: Date.now() });
    return route.fulfill({ json: { ok: true } });
  });
  return { dashboard, writes };
}

async function fitsScreen(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("missing configuration shows setup without sample protection or controls", async ({ page }) => {
  await session(page, { configured: false, authenticated: false, missing: credentials });
  const mutations: string[] = [];
  page.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method())) mutations.push(request.url()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "BotProtect", exact: true })).toBeVisible();
  await expect(page.getByText("Finish Discord setup", { exact: true })).toBeVisible();
  for (const key of credentials) await expect(page.getByText(key, { exact: true })).toBeVisible();
  await expect(page.getByText(`${new URL(page.url()).origin}/auth/callback`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start protection", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save settings", exact: true })).toHaveCount(0);
  await expect(page.getByText(/crypto_airdrop|free_nitro_2026|sample data|demo mode/i)).toHaveCount(0);
  expect(mutations).toEqual([]);
  await fitsScreen(page);
  await page.screenshot({ path: `test-results/setup-${test.info().project.name}.png`, fullPage: true });
});

test("configured installation requires Discord sign-in before management", async ({ page }) => {
  await session(page, { configured: true, authenticated: false, missing: [] });
  await page.goto("/");
  const login = page.getByRole("link", { name: "Sign in with Discord", exact: true });
  await expect(login.first()).toBeVisible();
  await expect(login.first()).toHaveAttribute("href", "/auth/login");
  await expect(page.getByRole("heading", { name: "Protection settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start protection", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm flag", exact: true })).toHaveCount(0);
  await fitsScreen(page);
});

test("manager saves settings, starts protection, and reviews through the API", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { writes } = await manager(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Protection settings", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review queue", exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Different channels", exact: true }).fill("6");
  await page.getByLabel("Delete honeypot messages", { exact: true }).check();
  await page.getByLabel("Staff review channel", { exact: true }).selectOption(reviewId);
  await expect(page.getByRole("button", { name: "Start protection", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save settings", exact: true })).toBeDisabled();
  expect(writes.find((write) => write.path === "/api/settings")?.body).toEqual({
    honeypotEnabled: true, honeypotChannelIds: [trapId], honeypotDelete: true,
    spamEnabled: true, spamThreshold: 6, spamWindowSeconds: 60, spamDelete: false,
    excludedRoleIds: [], reviewChannelId: reviewId,
  });
  await page.getByRole("button", { name: "Start protection", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause protection", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause protection", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start protection", exact: true })).toBeVisible();
  expect(writes.filter((write) => write.path.startsWith("/api/gateway/")).map((write) => write.path))
    .toEqual(["/api/gateway/start", "/api/gateway/stop"]);
  await expect(page.getByText("A message in the trap channel", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm flag", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("No account action was taken");
  expect(writes.find((write) => write.path === `/api/flags/${flagId}`)?.body).toEqual({ status: "confirmed" });
  await expect(page.getByRole("button", { name: "Confirm flag", exact: true })).toHaveCount(0);
  await page.getByText("Recently reviewed", { exact: false }).click();
  await expect(page.getByText("A message in the trap channel", { exact: true })).toBeVisible();
  await fitsScreen(page);
  await page.screenshot({ path: `test-results/protection-${info.project.name}.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("a failed live dashboard load shows an error instead of sample activity", async ({ page }) => {
  await manager(page);
  await page.route("**/api/dashboard", (route) => route.fulfill({ status: 503, json: { error: "Protection data is temporarily unavailable." } }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Protection data is temporarily unavailable.");
  await expect(page.getByRole("button", { name: "Confirm flag", exact: true })).toHaveCount(0);
  await expect(page.getByText(/crypto_airdrop|free_nitro_2026|sample data|demo mode/i)).toHaveCount(0);
  await fitsScreen(page);
});

test("an older refresh preserves draft settings and cannot undo a review", async ({ page }) => {
  await page.clock.install();
  const { dashboard } = await manager(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Confirm flag", exact: true })).toBeVisible();
  const stale = structuredClone(dashboard);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/dashboard", async (route) => {
    await gate;
    await route.fulfill({ json: stale });
  }, { times: 1 });
  const refreshed = page.waitForResponse("**/api/dashboard");
  const requested = page.waitForRequest("**/api/dashboard");
  await page.clock.fastForward(15_001);
  await requested;
  await page.getByRole("spinbutton", { name: "Different channels", exact: true }).fill("6");
  await page.getByRole("button", { name: "Confirm flag", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("No account action was taken");
  release();
  await (await refreshed).finished();
  await page.clock.runFor(100);
  await expect(page.getByRole("spinbutton", { name: "Different channels", exact: true })).toHaveValue("6");
  await expect(page.getByRole("button", { name: "Save settings", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Confirm flag", exact: true })).toHaveCount(0);
  await expect(page.getByText("Recently reviewed", { exact: false })).toBeVisible();
});

test("expired authorization during review clears protected data", async ({ page }) => {
  await manager(page);
  await page.route(`**/api/flags/${flagId}`, (route) => route.fulfill({
    status: 401, json: { error: "Sign in as a manager of this Discord server to continue." },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Confirm flag", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in with Discord", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Protection settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Review queue", exact: true })).toHaveCount(0);
  await expect(page.getByText("A message in the trap channel", { exact: true })).toHaveCount(0);
});
