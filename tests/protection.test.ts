import { describe, expect, it } from "vitest";
import { fingerprintMessage, isHoneypot, shouldIgnore } from "../worker/protection";
import { validateSettings } from "../shared/settings";
import { DEFAULT_SETTINGS, type DiscordMessage } from "../shared/types";

const guildId = "100000000000000002";
const channelId = "100000000000000010";
const userId = "100000000000000100";
const message: DiscordMessage = { id: "100000000000000200", guild_id: guildId, channel_id: channelId, author: { id: userId, username: "member" } };

describe("HAFBot matching semantics", () => {
  it("matches Unicode width, case, and whitespace differences without retaining message text", async () => {
    expect(await fingerprintMessage("  ＦＲＥＥ  Nitro\nHERE ")).toBe(await fingerprintMessage("free nitro here"));
    expect(await fingerprintMessage("one message")).not.toBe(await fingerprintMessage("a different message"));
    expect(await fingerprintMessage("   \n ")).toBeNull();
    expect((await fingerprintMessage("private text"))?.length).toBe(64);
  });
  it("ignores other guilds, bots, webhooks, and excluded roles", () => {
    const settings = { ...DEFAULT_SETTINGS, excludedRoleIds: ["100000000000000020"] };
    expect(shouldIgnore(message, guildId, settings)).toBe(false);
    expect(shouldIgnore({ ...message, guild_id: "100000000000000003" }, guildId, settings)).toBe(true);
    expect(shouldIgnore({ ...message, author: { ...message.author, bot: true } }, guildId, settings)).toBe(true);
    expect(shouldIgnore({ ...message, webhook_id: "hook" }, guildId, settings)).toBe(true);
    expect(shouldIgnore({ ...message, member: { roles: settings.excludedRoleIds } }, guildId, settings)).toBe(true);
  });
  it("includes text-channel threads and excludes forum and media posts", () => {
    const settings = { ...DEFAULT_SETTINGS, honeypotEnabled: true, honeypotChannelIds: [channelId] };
    const threadId = "100000000000000011";
    expect(isHoneypot(channelId, settings, [{ id: channelId, name: "trap", type: 0 }])).toBe(true);
    expect(isHoneypot(threadId, settings, [{ id: channelId, name: "trap", type: 0 }, { id: threadId, name: "thread", type: 11, parent_id: channelId }])).toBe(true);
    for (const type of [15, 16]) {
      expect(isHoneypot(threadId, settings, [{ id: channelId, name: "forum", type }, { id: threadId, name: "post", type: 11, parent_id: channelId }])).toBe(false);
    }
    expect(isHoneypot(channelId, { ...settings, honeypotEnabled: false }, [])).toBe(false);
  });
});

describe("settings boundary", () => {
  it("accepts defaults and rejects malformed policies", () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    for (const settings of [
      { ...DEFAULT_SETTINGS, honeypotEnabled: true },
      { ...DEFAULT_SETTINGS, spamThreshold: 1 },
      { ...DEFAULT_SETTINGS, spamWindowSeconds: 301 },
      { ...DEFAULT_SETTINGS, spamWindowSeconds: 2.5 },
      { ...DEFAULT_SETTINGS, spamEnabled: "yes" },
      { ...DEFAULT_SETTINGS, excludedRoleIds: [123] },
      { ...DEFAULT_SETTINGS, honeypotChannelIds: Array(11).fill(channelId) },
      { ...DEFAULT_SETTINGS, honeypotChannelIds: [channelId], reviewChannelId: channelId },
    ]) expect(() => validateSettings(settings)).toThrow();
  });
});
