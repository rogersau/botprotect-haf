import { DEFAULT_SETTINGS, type AppSession, type Dashboard, type GuildResources } from "../shared/types";

export const demoSession: AppSession = { configured: false, authenticated: false, missing: [] };
export const demoResources: GuildResources = {
  guild: { id: "100000000000000001", name: "The Harbour", icon: null, owner_id: "100000000000000002" },
  channels: [
    { id: "100000000000000010", name: "do-not-post", type: 0 },
    { id: "100000000000000011", name: "general", type: 0 },
    { id: "100000000000000012", name: "introductions", type: 0 },
    { id: "100000000000000013", name: "bot-review", type: 0 },
    { id: "100000000000000014", name: "off-topic", type: 0 },
    { id: "100000000000000015", name: "memes", type: 0 },
    { id: "100000000000000016", name: "help", type: 0 },
  ],
  roles: [
    { id: "100000000000000020", name: "Moderators", color: 0 },
    { id: "100000000000000021", name: "Trusted members", color: 0 },
  ],
};

export function createDemoDashboard(): Dashboard {
  return {
    settings: { ...DEFAULT_SETTINGS, honeypotEnabled: true, honeypotChannelIds: ["100000000000000010"], reviewChannelId: "100000000000000013", excludedRoleIds: ["100000000000000020"] },
    gateway: { status: "ready", error: null, connectedAt: Date.now() - 3_600_000, lastEventAt: Date.now() - 10000 },
    stats: { messages: 1248, honeypot: 4, spam: 7, pending: 2 }, jobsPending: 0, jobsFailed: 0,
    activity: [3, 5, 2, 8, 4, 6, 11].map((count, i) => ({ day: new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10), honeypot: Math.floor(count * 0.4), spam: count - Math.floor(count * 0.4) })),
    flags: [
      { id: "00000000-0000-4000-a000-000000000001", userId: "100000000000000101", username: "crypto_airdrop", detector: "honeypot", channelId: "100000000000000010", messageId: "100000000000000201", channelIds: ["100000000000000010"], preview: "Claim your exclusive reward. Limited spots available!", createdAt: Date.now() - 120_000, status: "open", resolvedBy: null, resolvedAt: null },
      { id: "00000000-0000-4000-a000-000000000002", userId: "100000000000000102", username: "free_nitro_2026", detector: "spam", channelId: "100000000000000011", messageId: "100000000000000202", channelIds: ["100000000000000011", "100000000000000012", "100000000000000014", "100000000000000015", "100000000000000016"], preview: "Free Nitro for everyone! Visit this link to get yours.", createdAt: Date.now() - 960_000, status: "open", resolvedBy: null, resolvedAt: null },
      { id: "00000000-0000-4000-a000-000000000003", userId: "100000000000000103", username: "a_very_real_human", detector: "spam", channelId: "100000000000000014", messageId: "100000000000000203", channelIds: ["100000000000000011", "100000000000000012", "100000000000000014", "100000000000000015", "100000000000000016"], preview: "Thanks for the warm welcome!", createdAt: Date.now() - 4_200_000, status: "dismissed", resolvedBy: "100000000000000002", resolvedAt: Date.now() - 4_100_000 },
    ],
  };
}
