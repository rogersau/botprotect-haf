import { resolve } from "node:path";
import type { DiscordConfig } from "../core/contracts";
import { isSnowflake } from "../shared/settings";

export interface ServerConfig extends DiscordConfig {
  publicUrl: string;
  host: string;
  port: number;
  dataDir: string;
  assetsDir: string;
}

export function readConfig(input: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(input.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
  let url: URL;
  try { url = new URL(input.PUBLIC_URL || `http://localhost:${port}`); }
  catch { throw new Error("PUBLIC_URL must be an absolute HTTPS URL, or a localhost HTTP URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_URL must be an HTTPS origin without a path; HTTP is allowed for localhost only.");
  }
  for (const name of ["DISCORD_GUILD_ID", "DISCORD_CLIENT_ID"] as const) {
    if (input[name]?.trim() && !isSnowflake(input[name]?.trim())) throw new Error(`${name} must be a Discord snowflake ID.`);
  }
  return {
    publicUrl: url.origin,
    host: input.HOST || "127.0.0.1",
    port,
    dataDir: resolve(input.DATA_DIR || "./data"),
    assetsDir: resolve(input.ASSETS_DIR || "./dist/client"),
    DISCORD_BOT_TOKEN: input.DISCORD_BOT_TOKEN?.trim(),
    DISCORD_CLIENT_ID: input.DISCORD_CLIENT_ID?.trim(),
    DISCORD_CLIENT_SECRET: input.DISCORD_CLIENT_SECRET?.trim(),
    DISCORD_GUILD_ID: input.DISCORD_GUILD_ID?.trim(),
  };
}
