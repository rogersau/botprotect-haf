// Matching semantics adapted from rogersau/hafbot's Bot Defense. See THIRD_PARTY_NOTICES.md.
import type { Channel, DiscordMessage, Settings } from "../shared/types";

export async function fingerprintMessage(content: string): Promise<string | null> {
  const normalized = content.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function shouldIgnore(message: DiscordMessage, guildId: string, settings: Settings): boolean {
  return message.guild_id !== guildId || !!message.author.bot || !!message.webhook_id ||
    (message.member?.roles ?? []).some((id) => settings.excludedRoleIds.includes(id));
}

export function isHoneypot(channelId: string, settings: Settings, channels: Channel[]): boolean {
  if (!settings.honeypotEnabled) return false;
  const channel = channels.find((item) => item.id === channelId);
  if (channel?.type === 15 || channel?.type === 16) return false;
  if (settings.honeypotChannelIds.includes(channelId)) return true;
  if (!channel?.parent_id || ![10, 11, 12].includes(channel.type)) return false;
  const parent = channels.find((item) => item.id === channel.parent_id);
  return !!parent && ![15, 16].includes(parent.type) && settings.honeypotChannelIds.includes(parent.id);
}

export function messageTime(id: string, fallback: number): number {
  try {
    const time = Number(BigInt(id) >> 22n) + 1420070400000;
    return Number.isFinite(time) ? time : fallback;
  } catch { return fallback; }
}
