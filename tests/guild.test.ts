import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type DiscordMessage } from "../shared/types";
import type { Env } from "../worker/env";

const bindings = env as Env;
const guildId = "100000000000000002";
const trap = "100000000000000010";
const member = "100000000000000100";
let counter = 0n;
function message(channelId = trap, content = "same message", at = Date.now()): DiscordMessage {
  return { id: (((BigInt(at) - 1420070400000n) << 22n) + counter++).toString(), guild_id: guildId, channel_id: channelId, content, author: { id: member, username: "test-member" } };
}
async function enqueue(stub: ReturnType<Env["GUILD"]["getByName"]>, messages: DiscordMessage[]) {
  await runInDurableObject(stub, (_instance, state) => {
    for (const item of messages) state.storage.sql.exec("INSERT OR IGNORE INTO inbox VALUES (?, ?, ?)", item.id, JSON.stringify(item), Date.now());
  });
  await stub.watchdog();
}
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe("persistent guild protection", () => {
  it("counts distinct channels for the same author and normalized message", async () => {
    const stub = bindings.GUILD.getByName("distinct-channels");
    await stub.saveSettings({ ...DEFAULT_SETTINGS, spamThreshold: 3 });
    await enqueue(stub, [message(trap), message(trap), message(trap)]);
    expect((await stub.dashboard()).flags).toHaveLength(0);
    await enqueue(stub, [message("100000000000000011", "ＳＡＭＥ  message"), message("100000000000000012", "Same\nMessage")]);
    const snapshot = await stub.dashboard();
    expect(snapshot.flags).toHaveLength(1);
    expect(snapshot.flags[0].detector).toBe("spam");
    expect(snapshot.flags[0].channelIds).toHaveLength(3);
    expect(snapshot.stats.messages).toBe(5);
  });
  it("excludes old messages and does not mix authors or different content", async () => {
    const stub = bindings.GUILD.getByName("window-and-author");
    await stub.saveSettings({ ...DEFAULT_SETTINGS, spamThreshold: 2, spamWindowSeconds: 10 });
    await enqueue(stub, [message(trap, "same", Date.now() - 20_000), message("100000000000000011", "same")]);
    expect((await stub.dashboard()).flags).toHaveLength(0);
    const other = message(trap, "same"); other.author.id = "100000000000000101";
    await enqueue(stub, [other, message(trap, "different"), message(trap, " ")]);
    expect((await stub.dashboard()).flags).toHaveLength(0);
  });
  it("keeps one open flag per member, deduplicates replays, and audits the exact flag generation", async () => {
    const stub = bindings.GUILD.getByName("review-generation");
    await stub.saveSettings({ ...DEFAULT_SETTINGS, honeypotEnabled: true, honeypotChannelIds: [trap] });
    const first = message();
    await enqueue(stub, [first, message()]);
    const initial = await stub.dashboard();
    expect(initial.flags).toHaveLength(1);
    expect(initial.stats.messages).toBe(2);
    await enqueue(stub, [first]);
    expect((await stub.dashboard()).stats.messages).toBe(2);
    const id = initial.flags[0].id;
    expect(await stub.resolveFlag(id, "dismissed", member)).toBe(true);
    await enqueue(stub, [message()]);
    expect(await stub.resolveFlag(id, "confirmed", member)).toBe(false);
    const final = await stub.dashboard();
    expect(final.flags).toHaveLength(2);
    expect(final.stats.pending).toBe(1);
    expect(final.flags.find((flag) => flag.id === id)).toMatchObject({ status: "dismissed", resolvedBy: member });
    expect(final.flags.find((flag) => flag.id !== id)?.status).toBe("open");
  });
  it("preserves settings and flags across eviction", async () => {
    const stub = bindings.GUILD.getByName("restart");
    const settings = { ...DEFAULT_SETTINGS, honeypotEnabled: true, honeypotChannelIds: [trap] };
    await stub.saveSettings(settings);
    await enqueue(stub, [message()]);
    const id = (await stub.dashboard()).flags[0].id;
    await evictDurableObject(stub);
    expect((await stub.dashboard()).settings).toEqual(settings);
    expect((await stub.dashboard()).flags[0].id).toBe(id);
  });
  it("makes OAuth state single-use and expires sessions", async () => {
    const stub = bindings.GUILD.getByName("auth-state");
    await stub.createOAuthState("hashed-state");
    expect(await stub.consumeOAuthState("unrelated-state")).toBe(false);
    expect(await stub.consumeOAuthState("hashed-state")).toBe(true);
    expect(await stub.consumeOAuthState("hashed-state")).toBe(false);
    const user = { id: member, username: "manager", avatar: null };
    await stub.createSession("expired", { user, accessToken: "test-only", expiresAt: Date.now() - 1 });
    expect(await stub.getSession("expired")).toBeNull();
    await stub.createSession("valid", { user, accessToken: "test-only", expiresAt: Date.now() + 30_000 });
    expect((await stub.getSession("valid"))?.user.id).toBe(member);
    await stub.deleteSession("valid");
    expect(await stub.getSession("valid")).toBeNull();
  });
  it("retries rate-limited message actions and still deletes every honeypot trip", async () => {
    const stub = bindings.GUILD.getByName("actions");
    await stub.saveSettings({ ...DEFAULT_SETTINGS, honeypotEnabled: true, honeypotChannelIds: [trap], honeypotDelete: true });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "1" } })).mockResolvedValue(new Response(null, { status: 204 }));
    await enqueue(stub, [message(), message()]);
    expect((await stub.dashboard()).flags).toHaveLength(1);
    expect((await stub.dashboard()).jobsPending).toBe(2);
    await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("UPDATE jobs SET due = 0"); });
    await stub.watchdog();
    expect((await stub.dashboard()).jobsPending).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/discord.com\/api\/v10\/channels\/\d+\/messages\/\d+$/);
      expect(init?.method).toBe("DELETE");
    }
  });
  it("does not create member punishment requests when confirming a flag", async () => {
    const stub = bindings.GUILD.getByName("no-punishment");
    const fetcher = vi.spyOn(globalThis, "fetch");
    await stub.saveSettings({ ...DEFAULT_SETTINGS, honeypotEnabled: true, honeypotChannelIds: [trap] });
    await enqueue(stub, [message()]);
    const flag = (await stub.dashboard()).flags[0];
    await stub.resolveFlag(flag.id, "confirmed", member);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await stub.dashboard()).flags[0].status).toBe("confirmed");
  });
});
