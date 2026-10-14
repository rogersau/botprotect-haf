export interface Settings {
  honeypotEnabled: boolean;
  honeypotChannelIds: string[];
  honeypotDelete: boolean;
  spamEnabled: boolean;
  spamThreshold: number;
  spamWindowSeconds: number;
  spamDelete: boolean;
  excludedRoleIds: string[];
  reviewChannelId: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  honeypotEnabled: false,
  honeypotChannelIds: [],
  honeypotDelete: false,
  spamEnabled: true,
  spamThreshold: 5,
  spamWindowSeconds: 60,
  spamDelete: false,
  excludedRoleIds: [],
  reviewChannelId: null,
};

export interface DiscordMessage {
  id: string;
  guild_id: string;
  channel_id: string;
  content?: string;
  webhook_id?: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  member?: { roles?: string[] };
}

export interface Channel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
}

export interface Role { id: string; name: string; color: number }
export type Detector = "honeypot" | "spam";
export type FlagStatus = "open" | "confirmed" | "dismissed";

export interface Flag {
  id: string;
  userId: string;
  username: string;
  detector: Detector;
  channelId: string;
  messageId: string;
  channelIds: string[];
  preview: string;
  createdAt: number;
  status: FlagStatus;
  resolvedBy: string | null;
  resolvedAt: number | null;
}

export interface GatewayStatus {
  status: "stopped" | "connecting" | "ready" | "reconnecting" | "error";
  error: string | null;
  connectedAt: number | null;
  lastEventAt: number | null;
}

export interface Dashboard {
  settings: Settings;
  gateway: GatewayStatus;
  flags: Flag[];
  jobsPending: number;
  jobsFailed: number;
}

export interface AppSession {
  hosting?: "cloudflare" | "docker";
  configured: boolean;
  authenticated: boolean;
  missing: string[];
  user?: { id: string; username: string; avatar: string | null };
  guildId?: string;
  inviteUrl?: string;
}

export interface GuildResources {
  guild: { id: string; name: string; icon: string | null; owner_id: string };
  channels: Channel[];
  roles: Role[];
}
