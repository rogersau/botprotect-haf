import type { GuildProtection } from "./guild";
import type { DiscordConfig } from "../core/contracts";
export { missingConfiguration } from "../core/contracts";

export interface Env extends DiscordConfig {
  GUILD: DurableObjectNamespace<GuildProtection>;
  ASSETS: Fetcher;
}

export const guildStub = (env: Env) => env.GUILD.getByName(env.DISCORD_GUILD_ID || "unconfigured");
