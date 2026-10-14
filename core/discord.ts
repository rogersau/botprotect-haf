import type { DiscordConfig } from "./contracts";
import type { Channel, GuildResources, Role } from "../shared/types";

const API = "https://discord.com/api/v10";

export class DiscordError extends Error {
  constructor(public status: number, public retryAfter = 0) {
    super(status === 429 ? "Discord is rate limiting requests. Try again shortly." :
      status === 403 ? "The bot is missing Discord permissions for this action." :
      status === 401 ? "Discord credentials are invalid or have expired." : `Discord request failed (${status}).`);
  }
}

export async function discord<T>(path: string, token: string, init: RequestInit = {}, bearer = false): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `${bearer ? "Bearer" : "Bot"} ${token}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new DiscordError(response.status, Number(response.headers.get("retry-after") || 5));
  }
  return response.status === 204 ? undefined as T : response.json<T>();
}

export async function canManageGuild(token: string, guildId: string): Promise<boolean> {
  let after = "0";
  for (let page = 0; page < 10; page++) {
    const guilds = await discord<{ id: string; owner: boolean; permissions: string }[]>(`/users/@me/guilds?limit=200&after=${after}`, token, {}, true);
    const guild = guilds.find((item) => item.id === guildId);
    if (guild) return guild.owner || (BigInt(guild.permissions) & 40n) !== 0n;
    if (guilds.length < 200) return false;
    after = guilds[guilds.length - 1].id;
  }
  return false;
}

export async function resources(env: DiscordConfig): Promise<GuildResources> {
  const token = env.DISCORD_BOT_TOKEN!;
  const guildId = env.DISCORD_GUILD_ID!;
  const [guild, channels, roles] = await Promise.all([
    discord<GuildResources["guild"]>(`/guilds/${guildId}`, token),
    discord<Channel[]>(`/guilds/${guildId}/channels`, token),
    discord<Role[]>(`/guilds/${guildId}/roles`, token),
  ]);
  return { guild: { id: guild.id, name: guild.name, icon: guild.icon, owner_id: guild.owner_id },
    channels: channels.map(({ id, name, type, parent_id }) => ({ id, name, type, parent_id })),
    roles: roles.map(({ id, name, color }) => ({ id, name, color })) };
}

export function inviteUrl(env: DiscordConfig): string {
  const params = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID!, scope: "bot", permissions: "84992", guild_id: env.DISCORD_GUILD_ID!, disable_guild_select: "true" });
  return `https://discord.com/oauth2/authorize?${params}`;
}
