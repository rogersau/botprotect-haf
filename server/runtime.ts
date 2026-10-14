import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database, GuildRuntime, SqlRows, SqlValue } from "../core/contracts";
import type { GuildService } from "../core/guild";

export class SqliteDatabase implements Database {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    try {
      // Keep one owner for a data volume, including across multiple containers.
      this.database.exec("PRAGMA busy_timeout = 1000; PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    } catch (error) { this.database.close(); throw error; }
  }

  script(sql: string): void { this.database.exec(sql); }
  exec<T extends Record<string, SqlValue>>(sql: string, ...bindings: SqlValue[]): SqlRows<T> {
    // The application's schema uses only TEXT, INTEGER, and NULL columns.
    const rows = this.database.prepare(sql).all(...bindings) as T[];
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error("Expected exactly one SQL row.");
        return rows[0];
      },
    };
  }
  transactionSync<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.database.close(); }
}

export class NodeRuntime implements GuildRuntime {
  readonly platform = "node";
  readonly sql: SqliteDatabase;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly tasks = new Set<Promise<void>>();
  private alarm: (() => Promise<void>) | null = null;
  private alarmRunning = false;
  private closed = false;

  constructor(path: string) { this.sql = new SqliteDatabase(path); }
  transactionSync<T>(callback: () => T): T { return this.sql.transactionSync(callback); }

  start(service: GuildService, configured: boolean): void {
    this.alarm = () => service.alarm();
    if (!configured) return;
    this.waitUntil(service.watchdog());
    this.watchdog = setInterval(() => this.waitUntil(service.watchdog()), 300_000);
    this.watchdog.unref();
  }

  async setAlarm(at: number | null): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (at === null || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.alarmRunning) { this.waitUntil(this.setAlarm(Date.now() + 100)); return; }
      if (!this.alarm) return;
      this.alarmRunning = true;
      this.waitUntil(this.alarm().finally(() => { this.alarmRunning = false; }));
    }, Math.max(0, Math.min(at - Date.now(), 2_147_483_647)));
    this.timer.unref();
  }

  waitUntil(task: Promise<void>): void {
    const tracked = task.catch(() => { console.error(JSON.stringify({ event: "background_task_failed" })); }).finally(() => { this.tasks.delete(tracked); });
    this.tasks.add(tracked);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.setAlarm(null);
    if (this.watchdog) clearInterval(this.watchdog);
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    this.sql.close();
  }
}
