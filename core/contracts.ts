import type { GuildService } from "./guild";

export interface DiscordConfig {
  DISCORD_BOT_TOKEN?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_GUILD_ID?: string;
}

export interface StoredSession {
  user: { id: string; username: string; avatar: string | null };
  accessToken: string;
  expiresAt: number;
}

export type SqlValue = string | number | null;
export interface SqlRows<T> { toArray(): T[]; one(): T }
export interface Database {
  script(sql: string): void;
  exec<T extends Record<string, SqlValue>>(sql: string, ...bindings: SqlValue[]): SqlRows<T>;
}

export interface GuildRuntime {
  sql: Database;
  platform: "cloudflare" | "node";
  transactionSync<T>(callback: () => T): T;
  setAlarm(at: number | null): Promise<void>;
  waitUntil(task: Promise<void>): void;
}

export type GuildApi = Pick<GuildService,
  "createOAuthState" | "consumeOAuthState" | "createSession" | "getSession" | "deleteSession" |
  "dashboard" | "saveSettings" | "updateChannels" | "resolveFlag" | "start" | "stop" | "retryJobs"
>;

export interface AppEnvironment extends DiscordConfig {
  guild: GuildApi;
  assets: { fetch(request: Request): Promise<Response> };
  hosting: "cloudflare" | "docker";
}

export function missingConfiguration(config: DiscordConfig): string[] {
  return (["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_GUILD_ID"] as const)
    .filter((key) => !config[key]?.trim());
}
