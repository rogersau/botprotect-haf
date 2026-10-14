import { expect, test, type Page } from "@playwright/test";

async function navigate(page: Page, name: string) {
  const menu = page.getByRole("button", { name: "Open navigation" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: new RegExp(`^${name}`) }).click();
}

test("explore protection, save settings, and review a demo flag", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Good company. Less spam." })).toBeVisible();
  await expect(page.getByText("You’re exploring a demo. All activity is sample data.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Pause protection", exact: true }).click();
  await expect(page.getByText("PROTECTION IS PAUSED", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start protection", exact: true }).click();
  await navigate(page, "Protections");
  await page.getByRole("spinbutton", { name: "Different channels" }).fill("6");
  await page.getByLabel("Delete the triggering message").first().check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Demo settings saved");
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await navigate(page, "Review queue");
  await page.getByRole("button", { name: "Confirm bot", exact: true }).first().click();
  await expect(page.getByRole("status")).toContainText("No account action was taken");
  await page.getByRole("button", { name: "Confirmed", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Honeypot triggered" })).toBeVisible();
  await navigate(page, "Setup guide");
  await expect(page.getByText("DISCORD_CLIENT_SECRET", { exact: true })).toBeVisible();
  await expect(page.getByText(`${new URL(page.url()).origin}/auth/callback`, { exact: true })).toBeVisible();
  if (process.env.E2E_RUNTIME === "docker") {
    await expect(page.getByRole("heading", { name: "Run on your own server" })).toBeVisible();
    await expect(page.getByText("docker compose up -d --build", { exact: true })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await navigate(page, "Overview");
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/overview-${info.project.name}.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("does not show demo activity as live when a connected server has no messages", async ({ page }) => {
  await page.route("**/api/session", (route) => route.fulfill({ json: { configured: true, authenticated: true, missing: [], guildId: "100000000000000002", user: { id: "100000000000000100", username: "manager", avatar: null } } }));
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: { settings: { honeypotEnabled: false, spamEnabled: true, honeypotChannelIds: [], excludedRoleIds: [], spamThreshold: 5, spamWindowSeconds: 60, reviewChannelId: null, honeypotWarn: false, honeypotDelete: false, spamWarn: false, spamDelete: false }, gateway: { status: "stopped", error: null, connectedAt: null, lastEventAt: null }, stats: { messages: 0, honeypot: 0, spam: 0, pending: 0 }, flags: [], activity: [], jobsPending: 0, jobsFailed: 0 } }));
  await page.route("**/api/resources", (route) => route.fulfill({ json: { guild: { id: "100000000000000002", name: "Actual server", owner_id: "100000000000000100", icon: null }, channels: [], roles: [] } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Good company. Less spam." })).toBeVisible();
  await expect(page.getByText("Demo mode", { exact: true })).toHaveCount(0);
  await expect(page.getByText("crypto_airdrop", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No flags yet. We’ll keep watch.")).toBeVisible();
});
