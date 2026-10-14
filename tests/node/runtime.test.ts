import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuildService } from "../../core/guild";
import { NodeRuntime, SqliteDatabase } from "../../server/runtime";
import { DEFAULT_SETTINGS, type DiscordMessage } from "../../shared/types";

const config = { DISCORD_GUILD_ID: "100000000000000002", DISCORD_BOT_TOKEN: "test-bot-token" };
const trap = "100000000000000010";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "botprotect-node-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "guild.sqlite");
  let runtime = new NodeRuntime(path);
  let service = new GuildService(runtime, config);
  cleanups.push(async () => { await service.shutdown(); await runtime.close(); });
  return {
    get runtime() { return runtime; }, get service() { return service; }, path,
    async restart() { await service.shutdown(); await runtime.close(); runtime = new NodeRuntime(path); service = new GuildService(runtime, config); },
  };
}
let counter = 0n;
function message(channel = trap, content = "same message"): DiscordMessage {
  return { id: (((BigInt(Date.now()) - 1420070400000n) << 22n) + counter++).toString(), guild_id: config.DISCORD_GUILD_ID, channel_id: channel, content, author: { id: "100000000000000100", username: "member" } };
}

describe("Node SQLite runtime", () => {
  it("processes a persisted inbox, matches distinct channels, and deduplicates replay", async () => {
    const f = await fixture();
    await f.service.saveSettings({ ...DEFAULT_SETTINGS, spamThreshold: 2 });
    const first = message();
    for (const item of [first, message(trap), message("100000000000000011", "ＳＡＭＥ  message")]) f.runtime.sql.exec("INSERT INTO inbox VALUES (?, ?, ?)", item.id, JSON.stringify(item), Date.now());
    await f.service.watchdog();
    const dashboard = await f.service.dashboard();
    expect(dashboard.flags).toHaveLength(1);
    expect(dashboard.flags[0]).toMatchObject({ detector: "spam", status: "open" });
    expect(dashboard.flags[0].channelIds).toHaveLength(2);
    await f.service.resolveFlag(dashboard.flags[0].id, "dismissed", "100000000000000001");
    f.runtime.sql.exec("INSERT INTO inbox VALUES (?, ?, ?)", first.id, JSON.stringify(first), Date.now());
    await f.service.watchdog();
    expect((await f.service.dashboard()).flags).toHaveLength(1);
  });
  it("keeps settings, flags, and server-side sessions after closing and reopening the database", async () => {
    const f = await fixture();
    const settings = { ...DEFAULT_SETTINGS, honeypotEnabled: true, honeypotChannelIds: [trap] };
    await f.service.saveSettings(settings);
    const item = message();
    f.runtime.sql.exec("INSERT INTO inbox VALUES (?, ?, ?)", item.id, JSON.stringify(item), Date.now());
    await f.service.watchdog();
    const flag = (await f.service.dashboard()).flags[0];
    await f.service.createSession("hashed-id", { user: { id: item.author.id, username: "manager", avatar: null }, accessToken: "test-only", expiresAt: Date.now() + 60000 });
    await f.restart();
    expect((await f.service.dashboard()).settings).toEqual(settings);
    expect((await f.service.dashboard()).flags[0].id).toBe(flag.id);
    expect((await f.service.getSession("hashed-id"))?.accessToken).toBe("test-only");
    expect(await f.service.resolveFlag(flag.id, "confirmed", item.author.id)).toBe(true);
    expect(await f.service.resolveFlag(flag.id, "dismissed", item.author.id)).toBe(false);
  });
  it("rolls back all writes if a detection transaction fails", async () => {
    const f = await fixture();
    expect(() => f.runtime.transactionSync(() => { f.runtime.sql.exec("INSERT INTO processed VALUES (?, ?)", "one", Date.now()); throw new Error("Simulated interruption"); })).toThrow("Simulated interruption");
    expect(f.runtime.sql.exec("SELECT * FROM processed").toArray()).toHaveLength(0);
  });
  it("prevents two writers from owning the same data volume", async () => {
    const f = await fixture();
    expect(() => new SqliteDatabase(f.path)).toThrow(/locked/);
  });
  it("refuses to reuse one guild’s data directory for another guild", async () => {
    const f = await fixture();
    expect(() => new GuildService(f.runtime, { ...config, DISCORD_GUILD_ID: "100000000000000003" })).toThrow("different Discord guild");
  });
  it("delivers deletion jobs through Node timers without an open dashboard", async () => {
    const f = await fixture();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    f.runtime.start(f.service, true);
    f.runtime.sql.exec("INSERT INTO jobs(id, path, method, body, due) VALUES (?, ?, ?, ?, ?)", "delete-test", `/channels/${trap}/messages/100000000000000200`, "DELETE", null, Date.now() + 150);
    await f.runtime.setAlarm(Date.now() + 150);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect((await f.service.dashboard()).jobsPending).toBe(0);
  });
});
