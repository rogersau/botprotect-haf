import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { expect, it, vi } from "vitest";
import { GuildService } from "../../core/guild";
import { NodeRuntime } from "../../server/runtime";
import { DEFAULT_SETTINGS } from "../../shared/types";

it("uses Node WebSockets and resumes the saved gateway after a process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "botprotect-gateway-"));
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP gateway.");
  const localUrl = `ws://127.0.0.1:${address.port}`;
  const NativeWebSocket = globalThis.WebSocket;
  vi.stubGlobal("WebSocket", class extends NativeWebSocket { constructor(_url: string) { super(localUrl); } });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ url: "wss://gateway.discord.gg", session_start_limit: { remaining: 10, reset_after: 60000 } }));
  const received: { op: number; d: { seq?: number; session_id?: string } }[] = [];
  let active: ServerSocket | undefined;
  gateway.on("connection", (connection) => {
    active = connection;
    connection.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
    connection.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as typeof received[number];
      received.push(frame);
      if (frame.op === 2) connection.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "node-session", resume_gateway_url: "wss://gateway.discord.gg" } }));
      if (frame.op === 6) connection.send(JSON.stringify({ op: 0, t: "RESUMED", s: 3, d: {} }));
      if (frame.op === 1) connection.send(JSON.stringify({ op: 11 }));
    });
  });
  const config = { DISCORD_GUILD_ID: "100000000000000002", DISCORD_BOT_TOKEN: "test-only" };
  const path = join(directory, "guild.sqlite");
  let runtime = new NodeRuntime(path);
  let service = new GuildService(runtime, config);
  let firstClosed = false;
  try {
    runtime.start(service, true);
    await service.saveSettings({ ...DEFAULT_SETTINGS, honeypotEnabled: true, honeypotChannelIds: ["100000000000000010"] });
    await service.start();
    await vi.waitFor(async () => expect((await service.dashboard()).gateway.status).toBe("ready"));
    const message = { id: (((BigInt(Date.now()) - 1420070400000n) << 22n)).toString(), guild_id: config.DISCORD_GUILD_ID, channel_id: "100000000000000010", content: "test", author: { id: "100000000000000100", username: "member" } };
    active!.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 2, d: message }));
    await vi.waitFor(async () => expect((await service.dashboard()).flags).toHaveLength(1));
    await service.shutdown();
    await runtime.close();
    firstClosed = true;
    runtime = new NodeRuntime(path);
    service = new GuildService(runtime, config);
    firstClosed = false;
    runtime.start(service, true);
    await vi.waitFor(() => expect(received.find((frame) => frame.op === 6)).toMatchObject({ d: { session_id: "node-session", seq: 2 } }));
    await vi.waitFor(async () => expect((await service.dashboard()).gateway.status).toBe("ready"));
    active!.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 4, d: message }));
    await vi.waitFor(() => expect(JSON.parse(runtime.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", "gateway").one().value).sequence).toBe(4));
    expect((await service.dashboard()).flags).toHaveLength(1);
    expect(received.filter((frame) => frame.op === 2)).toHaveLength(1);
  } finally {
    if (!firstClosed) { await service.shutdown(); await runtime.close(); }
    for (const client of gateway.clients) client.terminate();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});
