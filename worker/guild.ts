import { DurableObject } from "cloudflare:workers";
import { GuildService } from "../core/guild";
import type { StoredSession } from "../core/contracts";
import type { Channel, Settings } from "../shared/types";
import type { Env } from "./env";

export class GuildProtection extends DurableObject<Env> {
  private readonly service: GuildService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.service = new GuildService({
      platform: "cloudflare",
      sql: {
        script: (sql) => { ctx.storage.sql.exec(sql); },
        exec: (sql, ...bindings) => ctx.storage.sql.exec(sql, ...bindings),
      },
      transactionSync: (callback) => ctx.storage.transactionSync(callback),
      setAlarm: async (at) => { if (at === null) await ctx.storage.deleteAlarm(); else await ctx.storage.setAlarm(at); },
      waitUntil: (task) => ctx.waitUntil(task),
    }, env);
  }

  createOAuthState(id: string) { return this.service.createOAuthState(id); }
  consumeOAuthState(id: string) { return this.service.consumeOAuthState(id); }
  createSession(id: string, session: StoredSession) { return this.service.createSession(id, session); }
  getSession(id: string) { return this.service.getSession(id); }
  deleteSession(id: string) { return this.service.deleteSession(id); }
  saveSettings(settings: Settings) { return this.service.saveSettings(settings); }
  updateChannels(channels: Channel[]) { return this.service.updateChannels(channels); }
  dashboard() { return this.service.dashboard(); }
  resolveFlag(id: string, status: "confirmed" | "dismissed", userId: string) { return this.service.resolveFlag(id, status, userId); }
  start() { return this.service.start(); }
  stop() { return this.service.stop(); }
  watchdog() { return this.service.watchdog(); }
  retryJobs() { return this.service.retryJobs(); }
  alarm() { return this.service.alarm(); }
}
