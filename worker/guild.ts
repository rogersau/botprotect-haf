import { DurableObject } from "cloudflare:workers";
import { DEFAULT_SETTINGS, type Channel, type Dashboard, type Detector, type DiscordMessage, type Flag, type GatewayStatus, type Settings } from "../shared/types";
import { validateSettings, isSnowflake } from "../shared/settings";
import type { StoredSession } from "./auth";
import { discord, DiscordError } from "./discord";
import type { Env } from "./env";
import { fingerprintMessage, isHoneypot, messageTime, shouldIgnore } from "./protection";

interface GatewaySession {
  enabled: boolean;
  sessionId: string | null;
  resumeUrl: string | null;
  sequence: number | null;
  attempts: number;
  identifyAfter: number;
}
interface Envelope { op: number; s?: number | null; t?: string; d?: unknown }
type Job = { id: string; path: string; method: string; body: string | null; attempts: number; due: number };
type FlagRow = {
  id: string; user_id: string; username: string; detector: Detector; channel_id: string;
  message_id: string; channel_ids: string; preview: string; created_at: number;
  status: Flag["status"]; resolved_by: string | null; resolved_at: number | null;
};
const emptySession = (): GatewaySession => ({ enabled: false, sessionId: null, resumeUrl: null, sequence: null, attempts: 0, identifyAfter: 0 });
const emptyStatus = (): GatewayStatus => ({ status: "stopped", error: null, connectedAt: null, lastEventAt: null });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export class GuildProtection extends DurableObject<Env> {
  private sql: SqlStorage;
  private socket: WebSocket | null = null;
  private connecting = false;
  private processing = false;
  private runningJobs = false;
  private heartbeatMs = 0;
  private heartbeatAt = 0;
  private awaitingAck = false;
  private latestSequence: number | null = null;
  private reconnectAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS processed (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS samples (message_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, fingerprint TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS samples_match ON samples(user_id, fingerprint, at);
      CREATE INDEX IF NOT EXISTS samples_expiry ON samples(at);
      CREATE TABLE IF NOT EXISTS flags (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, detector TEXT NOT NULL,
        channel_id TEXT NOT NULL, message_id TEXT NOT NULL, channel_ids TEXT NOT NULL,
        preview TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        resolved_by TEXT, resolved_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_flag ON flags(user_id) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS flags_recent ON flags(created_at);
      CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, messages INTEGER NOT NULL DEFAULT 0, honeypot INTEGER NOT NULL DEFAULT 0, spam INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, path TEXT NOT NULL, method TEXT NOT NULL, body TEXT, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, failed INTEGER NOT NULL DEFAULT 0);
    `);
  }

  private get<T>(key: string, fallback: T): T {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? JSON.parse(row.value) as T : fallback;
  }
  private put(key: string, value: unknown): void {
    this.sql.exec("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }
  private session() { return this.get("gateway", emptySession()); }
  private setStatus(patch: Partial<GatewayStatus>) { this.put("status", { ...this.get("status", emptyStatus()), ...patch }); }

  async createOAuthState(id: string): Promise<void> {
    this.sql.exec("DELETE FROM oauth_states WHERE expires_at < ?", Date.now());
    this.sql.exec("DELETE FROM oauth_states WHERE id IN (SELECT id FROM oauth_states ORDER BY expires_at DESC LIMIT -1 OFFSET 999)");
    this.sql.exec("INSERT INTO oauth_states VALUES (?, ?)", id, Date.now() + 600_000);
  }
  async consumeOAuthState(id: string): Promise<boolean> {
    return this.sql.exec("DELETE FROM oauth_states WHERE id = ? AND expires_at > ? RETURNING id", id, Date.now()).toArray().length === 1;
  }
  async createSession(id: string, session: StoredSession): Promise<void> {
    this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", Date.now());
    this.sql.exec("INSERT INTO sessions VALUES (?, ?, ?)", id, JSON.stringify(session), session.expiresAt);
  }
  async getSession(id: string): Promise<StoredSession | null> {
    const row = this.sql.exec<{ data: string }>("SELECT data FROM sessions WHERE id = ? AND expires_at > ?", id, Date.now()).toArray()[0];
    return row ? JSON.parse(row.data) as StoredSession : null;
  }
  async deleteSession(id: string): Promise<void> { this.sql.exec("DELETE FROM sessions WHERE id = ?", id); }

  async saveSettings(settings: Settings): Promise<void> {
    this.put("settings", validateSettings(settings));
    // A previous window or exemption must not affect detections under a new configuration.
    this.sql.exec("DELETE FROM samples");
  }
  async updateChannels(channels: Channel[]): Promise<void> {
    const threads = this.get<Channel[]>("channels", []).filter((channel) => [10, 11, 12].includes(channel.type) && channels.some((parent) => parent.id === channel.parent_id));
    this.put("channels", [...channels, ...threads]);
  }

  async dashboard(): Promise<Dashboard> {
    const flags = this.sql.exec<FlagRow>("SELECT * FROM flags ORDER BY created_at DESC LIMIT 100").toArray().map((row): Flag => ({
      id: row.id, userId: row.user_id, username: row.username, detector: row.detector,
      channelId: row.channel_id, messageId: row.message_id, channelIds: JSON.parse(row.channel_ids) as string[],
      preview: row.preview, createdAt: row.created_at, status: row.status, resolvedBy: row.resolved_by, resolvedAt: row.resolved_at,
    }));
    const today = new Date().toISOString().slice(0, 10);
    const totals = this.sql.exec<{ messages: number; honeypot: number; spam: number }>("SELECT messages, honeypot, spam FROM daily WHERE day = ?", today).toArray()[0];
    const pending = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM flags WHERE status = 'open'").one().count;
    const jobsPending = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE failed = 0").one().count;
    const jobsFailed = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE failed = 1").one().count;
    const activity: Dashboard["activity"] = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const row = this.sql.exec<{ honeypot: number; spam: number }>("SELECT honeypot, spam FROM daily WHERE day = ?", day).toArray()[0];
      activity.push({ day, honeypot: row?.honeypot ?? 0, spam: row?.spam ?? 0 });
    }
    let gateway = this.get("status", emptyStatus());
    if (this.session().enabled && !this.socket && gateway.status === "ready") gateway = { ...gateway, status: "reconnecting" };
    return { settings: this.get("settings", DEFAULT_SETTINGS), gateway, flags,
      stats: { messages: totals?.messages ?? 0, honeypot: totals?.honeypot ?? 0, spam: totals?.spam ?? 0, pending }, activity, jobsPending, jobsFailed };
  }

  async resolveFlag(id: string, status: "confirmed" | "dismissed", userId: string): Promise<boolean> {
    return this.sql.exec("UPDATE flags SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open' RETURNING id", status, userId, Date.now(), id).toArray().length === 1;
  }

  async start(): Promise<GatewayStatus> {
    const session = this.session();
    session.enabled = true;
    this.put("gateway", session);
    this.reconnectAt = 0;
    this.setStatus({ error: null });
    await this.connectGateway();
    await this.schedule();
    return this.get("status", emptyStatus());
  }
  async stop(): Promise<GatewayStatus> {
    const session = this.session();
    session.enabled = false;
    this.put("gateway", session);
    this.disconnect(1000);
    this.resetSession();
    this.setStatus({ status: "stopped", error: null });
    // Pending message actions were already authorized before stopping; still deliver them.
    await this.schedule();
    return this.get("status", emptyStatus());
  }
  async watchdog(): Promise<void> {
    this.prune();
    if (this.session().enabled) await this.connectGateway();
    await this.processInbox();
    await this.runJobs();
    await this.schedule();
  }
  async retryJobs(): Promise<void> {
    this.sql.exec("UPDATE jobs SET failed = 0, attempts = 0, due = ? WHERE failed = 1", Date.now());
    await this.runJobs();
    await this.schedule();
  }
  async alarm(): Promise<void> {
    try {
      if (this.session().enabled) {
        if (!this.socket && Date.now() >= this.reconnectAt) await this.connectGateway();
        else if (this.socket && this.heartbeatAt && Date.now() >= this.heartbeatAt) {
          if (this.awaitingAck || this.socket.readyState !== WebSocket.OPEN) await this.backoff("Discord heartbeat was not acknowledged.");
          else this.sendHeartbeat();
        }
      }
      await this.processInbox();
      await this.runJobs();
      this.prune();
    } catch {
      this.setStatus({ error: "Connection interrupted. Retrying automatically." });
      this.reconnectAt = Date.now() + 30_000;
    } finally { await this.schedule(); }
  }

  private disconnect(code = 4000): void {
    const socket = this.socket;
    this.socket = null;
    this.heartbeatAt = 0;
    this.heartbeatMs = 0;
    this.awaitingAck = false;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(code, code === 1000 ? "Protection stopped" : "Reconnecting");
  }

  private async connectGateway(): Promise<void> {
    if (this.socket || this.connecting || !this.session().enabled || Date.now() < this.reconnectAt) return;
    this.connecting = true;
    try {
      const session = this.session();
      if (!session.sessionId && Date.now() < session.identifyAfter) { this.reconnectAt = session.identifyAfter; return; }
      this.setStatus({ status: session.sessionId ? "reconnecting" : "connecting" });
      let gatewayUrl = session.resumeUrl || this.get<string | null>("gatewayUrl", null);
      if (!gatewayUrl || !session.sessionId) {
        const data = await discord<{ url: string; session_start_limit: { remaining: number; reset_after: number } }>("/gateway/bot", this.env.DISCORD_BOT_TOKEN!);
        if (data.session_start_limit.remaining < 1) {
          session.identifyAfter = Date.now() + data.session_start_limit.reset_after;
          this.put("gateway", session);
          await this.backoff("Discord’s session start limit was reached. Waiting before reconnecting.", data.session_start_limit.reset_after);
          return;
        }
        gatewayUrl = data.url;
        this.put("gatewayUrl", data.url);
      }
      // A stop can arrive while the gateway discovery request is in flight.
      if (!this.session().enabled) return;
      const url = new URL(gatewayUrl);
      if (url.protocol !== "wss:" || !(url.hostname === "gateway.discord.gg" || url.hostname.endsWith(".discord.gg"))) throw new Error("Invalid Discord gateway URL.");
      url.searchParams.set("v", "10"); url.searchParams.set("encoding", "json");
      const socket = new WebSocket(url.toString());
      this.socket = socket;
      this.latestSequence = session.sequence;
      this.heartbeatAt = Date.now() + 30_000; // Also times out a connection that never sends Hello.
      socket.addEventListener("message", (event) => {
        if (this.socket === socket && typeof event.data === "string") {
          this.ctx.waitUntil(this.handleFrame(event.data, socket).catch(async () => { await this.backoff("Discord gateway processing failed. Retrying."); }));
        }
      });
      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.ctx.waitUntil(this.closed(event.code));
      });
      socket.addEventListener("error", () => {
        if (this.socket === socket) this.ctx.waitUntil(this.backoff("Discord connection interrupted."));
      });
    } catch (error) {
      if (error instanceof DiscordError && error.status === 401) await this.fatal("The bot token is invalid. Update DISCORD_BOT_TOKEN, then start again.");
      else await this.backoff("Could not connect to Discord. Retrying automatically.");
    } finally { this.connecting = false; }
  }

  private async handleFrame(raw: string, socket: WebSocket): Promise<void> {
    const frame = JSON.parse(raw) as Envelope;
    if (this.socket !== socket || typeof frame.op !== "number") return;
    if (typeof frame.s === "number") this.latestSequence = frame.s;
    if (frame.op === 10) {
      if (!record(frame.d) || typeof frame.d.heartbeat_interval !== "number" || frame.d.heartbeat_interval < 1000) throw new Error("Invalid Hello.");
      this.heartbeatMs = frame.d.heartbeat_interval;
      this.heartbeatAt = Date.now() + Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296) * this.heartbeatMs);
      this.awaitingAck = false;
      const session = this.session();
      if (session.sessionId && session.sequence !== null) {
        socket.send(JSON.stringify({ op: 6, d: { token: this.env.DISCORD_BOT_TOKEN, session_id: session.sessionId, seq: session.sequence } }));
      } else {
        session.identifyAfter = Date.now() + 6000;
        this.put("gateway", session);
        socket.send(JSON.stringify({ op: 2, d: { token: this.env.DISCORD_BOT_TOKEN, intents: 1 | 512 | 32768, properties: { os: "cloudflare", browser: "botprotect-haf", device: "botprotect-haf" } } }));
      }
      await this.schedule();
      return;
    }
    if (frame.op === 11) { this.awaitingAck = false; return; }
    if (frame.op === 1) { this.sendHeartbeat(); await this.schedule(); return; }
    if (frame.op === 7) { await this.backoff("Discord requested a reconnect.", 1000); return; }
    if (frame.op === 9) {
      if (frame.d !== true) this.resetSession();
      await this.backoff("Discord session expired. Reconnecting.", 5000);
      return;
    }
    if (frame.op !== 0) return;
    if (frame.t === "READY" && record(frame.d)) {
      if (typeof frame.d.session_id !== "string" || typeof frame.d.resume_gateway_url !== "string") throw new Error("Invalid READY.");
      const session = this.session();
      session.sessionId = frame.d.session_id;
      session.resumeUrl = frame.d.resume_gateway_url;
      session.attempts = 0;
      this.put("gateway", session);
      this.setStatus({ status: "ready", error: null, connectedAt: Date.now() });
    }
    if (frame.t === "RESUMED") {
      const session = this.session(); session.attempts = 0; this.put("gateway", session);
      this.setStatus({ status: "ready", error: null, connectedAt: Date.now() });
    }
    if (record(frame.d) && frame.d.id === this.env.DISCORD_GUILD_ID && frame.t === "GUILD_DELETE") {
      if (frame.d.unavailable === true) this.setStatus({ error: "Discord reports this server is temporarily unavailable." });
      else await this.fatal("The bot was removed from this server. Invite it again, then start protection.");
    }
    if (frame.t === "GUILD_CREATE" && record(frame.d) && frame.d.id === this.env.DISCORD_GUILD_ID) {
      const channels = Array.isArray(frame.d.channels) ? frame.d.channels : [];
      const threads = Array.isArray(frame.d.threads) ? frame.d.threads : [];
      this.put("channels", [...channels, ...threads].filter(isChannel));
      this.setStatus({ error: null });
    }
    if (["CHANNEL_CREATE", "CHANNEL_UPDATE", "THREAD_CREATE", "THREAD_UPDATE", "CHANNEL_DELETE", "THREAD_DELETE"].includes(frame.t || "") && record(frame.d) && frame.d.guild_id === this.env.DISCORD_GUILD_ID && isChannel(frame.d)) {
      const channels = this.get<Channel[]>("channels", []).filter((item) => item.id !== (frame.d as Channel).id);
      if (!frame.t?.endsWith("DELETE")) channels.push(frame.d);
      this.put("channels", channels);
    }
    if (frame.t === "MESSAGE_CREATE" && isMessage(frame.d) && frame.d.guild_id === this.env.DISCORD_GUILD_ID) {
      // Persist before advancing the resume sequence. Replayed dispatches are deduplicated.
      const message: DiscordMessage = { id: frame.d.id, guild_id: frame.d.guild_id, channel_id: frame.d.channel_id,
        content: frame.d.content?.slice(0, 4000), author: frame.d.author, member: frame.d.member, webhook_id: frame.d.webhook_id };
      this.sql.exec("INSERT OR IGNORE INTO inbox(id, data, at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM processed WHERE id = ?)", message.id, JSON.stringify(message), Date.now(), message.id);
      this.setStatus({ lastEventAt: Date.now() });
    }
    if (typeof frame.s === "number") { const session = this.session(); session.sequence = frame.s; this.put("gateway", session); }
    this.ctx.waitUntil(this.processInbox().then(() => this.runJobs()).then(() => this.schedule()));
  }

  private sendHeartbeat(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ op: 1, d: this.latestSequence }));
    this.awaitingAck = true;
    this.heartbeatAt = Date.now() + (this.heartbeatMs || 30_000);
  }
  private resetSession(): void {
    const session = this.session(); session.sessionId = null; session.resumeUrl = null; session.sequence = null; this.put("gateway", session);
  }
  private async closed(code: number): Promise<void> {
    if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
      this.resetSession();
      await this.fatal(code === 4014 ? "Enable Message Content Intent in the Discord Developer Portal, then start again." : `Discord rejected the connection (code ${code}). Check your bot token and application settings.`);
      return;
    }
    if ([1000, 1001, 4007, 4009].includes(code)) this.resetSession();
    await this.backoff("Discord disconnected. Reconnecting automatically.");
  }
  private async fatal(error: string): Promise<void> {
    const session = this.session(); session.enabled = false; this.put("gateway", session);
    this.disconnect(1000); this.resetSession(); this.setStatus({ status: "error", error }); await this.schedule();
  }
  private async backoff(error: string, delay?: number): Promise<void> {
    this.disconnect();
    const session = this.session();
    if (!session.enabled) return;
    const wait = delay ?? Math.min(1000 * 2 ** Math.min(session.attempts, 8), 300_000);
    session.attempts++;
    this.put("gateway", session);
    this.reconnectAt = Date.now() + wait;
    this.setStatus({ status: "reconnecting", error });
    await this.schedule();
  }

  private async processInbox(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      for (let count = 0; count < 100; count++) {
        const row = this.sql.exec<{ id: string; data: string }>("SELECT id, data FROM inbox ORDER BY at, rowid LIMIT 1").toArray()[0];
        if (!row) break;
        await this.processMessage(JSON.parse(row.data) as DiscordMessage);
      }
    } finally { this.processing = false; }
  }
  private async processMessage(message: DiscordMessage): Promise<void> {
    const settings = this.get("settings", DEFAULT_SETTINGS);
    const ignored = shouldIgnore(message, this.env.DISCORD_GUILD_ID!, settings);
    const fingerprint = !ignored && settings.spamEnabled ? await fingerprintMessage(message.content || "") : null;
    // Commit detection, message actions, statistics, and deduplication as one transaction.
    this.ctx.storage.transactionSync(() => {
      if (!this.sql.exec("SELECT id FROM processed WHERE id = ?", message.id).toArray().length && !ignored) {
        const day = new Date().toISOString().slice(0, 10);
        this.sql.exec("INSERT INTO daily(day, messages) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET messages = messages + 1", day);
        if (isHoneypot(message.channel_id, settings, this.get("channels", []))) this.detect(message, "honeypot", [message.channel_id], settings);
        if (fingerprint) {
          const now = Date.now();
          const at = messageTime(message.id, now);
          if (at >= now - settings.spamWindowSeconds * 1000 && at <= now + 5000) {
            this.sql.exec("INSERT OR IGNORE INTO samples VALUES (?, ?, ?, ?, ?)", message.id, message.author.id, message.channel_id, fingerprint, at);
            this.sql.exec("DELETE FROM samples WHERE at < ?", now - 300_000);
            const matches = this.sql.exec<{ channel_id: string }>("SELECT DISTINCT channel_id FROM samples WHERE user_id = ? AND fingerprint = ? AND at >= ? AND at <= ?", message.author.id, fingerprint, now - settings.spamWindowSeconds * 1000, now + 5000).toArray().map((row) => row.channel_id);
            if (matches.length >= settings.spamThreshold) this.detect(message, "spam", matches, settings);
          }
        }
      }
      this.sql.exec("INSERT OR IGNORE INTO processed VALUES (?, ?)", message.id, Date.now());
      this.sql.exec("DELETE FROM inbox WHERE id = ?", message.id);
    });
  }
  private detect(message: DiscordMessage, detector: Detector, channels: string[], settings: Settings): void {
    const warn = detector === "honeypot" ? settings.honeypotWarn : settings.spamWarn;
    const remove = detector === "honeypot" ? settings.honeypotDelete : settings.spamDelete;
    if (warn) this.queueJob(`${message.id}:${detector}:warn`, `/channels/${message.channel_id}/messages`, "POST", {
      content: `Your message triggered BotProtect’s ${detector === "honeypot" ? "honeypot" : "cross-channel spam"} detector. A moderator will review it.`,
      allowed_mentions: { parse: [] }, nonce: `${message.id}${detector === "honeypot" ? "h" : "s"}`, enforce_nonce: true,
    });
    if (remove) this.queueJob(`${message.id}:delete`, `/channels/${message.channel_id}/messages/${message.id}`, "DELETE", null);
    if (this.sql.exec("SELECT id FROM flags WHERE user_id = ? AND status = 'open'", message.author.id).toArray().length) return;
    const id = crypto.randomUUID();
    const preview = (message.content || "").trim().slice(0, 500);
    this.sql.exec("INSERT INTO flags(id, user_id, username, detector, channel_id, message_id, channel_ids, preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, message.author.id, message.author.global_name || message.author.username, detector, message.channel_id, message.id, JSON.stringify(channels), preview, Date.now());
    const column = detector === "honeypot" ? "honeypot" : "spam";
    this.sql.exec(`UPDATE daily SET ${column} = ${column} + 1 WHERE day = ?`, new Date().toISOString().slice(0, 10));
    if (settings.reviewChannelId) this.queueJob(`${id}:notify`, `/channels/${settings.reviewChannelId}/messages`, "POST", {
      embeds: [{ title: detector === "honeypot" ? "Honeypot triggered" : "Cross-channel spam detected", color: 15570487,
        description: `Member: <@${message.author.id}>\nChannel: <#${message.channel_id}>\nMatching channels: ${channels.length}\n[View message](https://discord.com/channels/${message.guild_id}/${message.channel_id}/${message.id})`,
        footer: { text: "BotProtect by HAFBOT · Review this flag in your dashboard" }, timestamp: new Date().toISOString() }],
      allowed_mentions: { parse: [] }, nonce: id.replace(/-/g, "").slice(0, 25), enforce_nonce: true,
    });
  }
  private queueJob(id: string, path: string, method: string, body: unknown): void {
    this.sql.exec("INSERT OR IGNORE INTO jobs(id, path, method, body, due) VALUES (?, ?, ?, ?, ?)", id, path, method, body === null ? null : JSON.stringify(body), Date.now());
  }
  private async runJobs(): Promise<void> {
    if (this.runningJobs) return;
    this.runningJobs = true;
    try {
      for (let count = 0; count < 10; count++) {
        const job = this.sql.exec<Job>("SELECT * FROM jobs WHERE failed = 0 AND due <= ? ORDER BY due LIMIT 1", Date.now()).toArray()[0];
        if (!job) break;
        try {
          await discord(job.path, this.env.DISCORD_BOT_TOKEN!, { method: job.method, ...(job.body ? { body: job.body } : {}) });
          this.sql.exec("DELETE FROM jobs WHERE id = ?", job.id);
        } catch (error) {
          if (error instanceof DiscordError && error.status === 404 && job.method === "DELETE") { this.sql.exec("DELETE FROM jobs WHERE id = ?", job.id); continue; }
          const retryable = !(error instanceof DiscordError) || error.status === 429 || error.status >= 500;
          const delay = error instanceof DiscordError && error.status === 429 ? Math.max(1000, error.retryAfter * 1000) : Math.min(2 ** job.attempts * 5000, 300_000);
          this.sql.exec("UPDATE jobs SET attempts = attempts + 1, due = ?, failed = ? WHERE id = ?", Date.now() + delay, retryable && job.attempts < 7 ? 0 : 1, job.id);
          // Respect Discord’s rate limit before sending more requests.
          if (error instanceof DiscordError && error.status === 429) {
            this.sql.exec("UPDATE jobs SET due = MAX(due, ?) WHERE failed = 0", Date.now() + delay);
            break;
          }
        }
      }
    } finally { this.runningJobs = false; }
  }
  private async schedule(): Promise<void> {
    const now = Date.now();
    const times: number[] = [];
    if (this.session().enabled) times.push(this.socket ? this.heartbeatAt || now + 30_000 : Math.max(this.reconnectAt, now + 1000));
    const job = this.sql.exec<{ due: number }>("SELECT MIN(due) AS due FROM jobs WHERE failed = 0").one();
    if (job.due !== null) times.push(job.due);
    if (this.sql.exec("SELECT id FROM inbox LIMIT 1").toArray().length) times.push(now + 1000);
    if (times.length) await this.ctx.storage.setAlarm(Math.max(now + 100, Math.min(...times)));
    else await this.ctx.storage.deleteAlarm();
  }
  private prune(): void {
    const now = Date.now();
    this.sql.exec("DELETE FROM samples WHERE at < ?", now - 300_000);
    this.sql.exec("DELETE FROM processed WHERE at < ?", now - 86_400_000);
    this.sql.exec("DELETE FROM flags WHERE created_at < ?", now - 30 * 86_400_000);
    this.sql.exec("DELETE FROM daily WHERE day < ?", new Date(now - 30 * 86_400_000).toISOString().slice(0, 10));
    this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", now);
    this.sql.exec("DELETE FROM oauth_states WHERE expires_at < ?", now);
  }
}

function isChannel(value: unknown): value is Channel {
  return record(value) && isSnowflake(value.id) && typeof value.name === "string" && typeof value.type === "number";
}
function isMessage(value: unknown): value is DiscordMessage {
  return record(value) && isSnowflake(value.id) && isSnowflake(value.guild_id) && isSnowflake(value.channel_id) &&
    record(value.author) && isSnowflake(value.author.id) && typeof value.author.username === "string" &&
    (value.content === undefined || typeof value.content === "string");
}
