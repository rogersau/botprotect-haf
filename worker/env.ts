import type { GuildProtection } from "./guild";

export interface Env {
  GUILD: DurableObjectNamespace<GuildProtection>;
  ASSETS: Fetcher;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_GUILD_ID?: string;
}

export function missingConfiguration(env: Env): string[] {
  return (["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_GUILD_ID"] as const)
    .filter((key) => !env[key]?.trim());
}

export const guildStub = (env: Env) => env.GUILD.getByName(env.DISCORD_GUILD_ID || "unconfigured");
