import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      DISCORD_BOT_TOKEN: "test-bot-token", DISCORD_CLIENT_ID: "100000000000000001",
      DISCORD_CLIENT_SECRET: "test-client-secret", DISCORD_GUILD_ID: "100000000000000002",
    } },
  })],
  test: { include: ["tests/*.test.ts"] },
});
