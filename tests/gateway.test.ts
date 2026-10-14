import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";

class GatewaySocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: GatewaySocket[] = [];
  readyState = 1;
  closedWith: number | undefined;
  sent: { op: number; d: Record<string, unknown> | number | null }[] = [];
  constructor(public url: string) { super(); GatewaySocket.instances.push(this); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close(code?: number) { this.readyState = 3; this.closedWith = code; }
  frame(payload: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })); }
}
const bindings = env as Env;
const stub = () => bindings.GUILD.getByName("gateway-test");
const socket = () => GatewaySocket.instances[GatewaySocket.instances.length - 1];
async function frame(payload: unknown) { await runInDurableObject(stub(), () => socket().frame(payload)); }
async function ready() {
  await stub().start();
  await frame({ op: 10, d: { heartbeat_interval: 45000 } });
  await frame({ op: 0, t: "READY", s: 1, d: { session_id: "test-session", resume_gateway_url: "wss://gateway-us-east1-b.discord.gg" } });
  await expect.poll(async () => (await stub().dashboard()).gateway.status).toBe("ready");
}
beforeEach(() => {
  GatewaySocket.instances = [];
  vi.stubGlobal("WebSocket", GatewaySocket);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ url: "wss://gateway.discord.gg", session_start_limit: { remaining: 10, reset_after: 60000 } })));
});
afterEach(async () => { await reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Discord gateway lifecycle", () => {
  it("identifies with only guild, guild message, and message content intents", async () => {
    await ready();
    expect(socket().url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    expect(socket().sent.find((item) => item.op === 2)).toMatchObject({ d: { intents: 33281, token: "test-bot-token" } });
    expect((await stub().dashboard()).gateway.error).toBeNull();
  });
  it("responds immediately to requested heartbeats with the latest sequence", async () => {
    await ready();
    await frame({ op: 1 });
    expect(socket().sent.find((item) => item.op === 1)).toEqual({ op: 1, d: 1 });
    await frame({ op: 11 });
    expect((await stub().dashboard()).gateway.status).toBe("ready");
  });
  it("resumes a persisted session after Discord requests a reconnect", async () => {
    await ready();
    const previous = socket();
    await frame({ op: 7 });
    expect(previous.closedWith).toBe(4000);
    await stub().start();
    await frame({ op: 10, d: { heartbeat_interval: 45000 } });
    expect(socket().sent).toContainEqual({ op: 6, d: { token: "test-bot-token", session_id: "test-session", seq: 1 } });
    expect(socket().sent.some((item) => item.op === 2)).toBe(false);
  });
  it("starts a fresh session after a deliberate pause so paused events are not replayed", async () => {
    await ready();
    const previous = socket();
    await stub().stop();
    expect(previous.closedWith).toBe(1000);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10000);
    await stub().start();
    await frame({ op: 10, d: { heartbeat_interval: 45000 } });
    expect(socket().sent.some((item) => item.op === 2)).toBe(true);
    expect(socket().sent.some((item) => item.op === 6)).toBe(false);
  });
  it("reconnects when a heartbeat goes unacknowledged", async () => {
    await ready();
    const previous = socket();
    await frame({ op: 1 });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 50000);
    await runInDurableObject(stub(), (instance) => instance.alarm());
    expect((await stub().dashboard()).gateway.status).toBe("reconnecting");
    expect(previous.closedWith).toBe(4000);
  });
  it("drops an invalid session before identifying again", async () => {
    await ready();
    await frame({ op: 9, d: false });
    await expect.poll(async () => (await stub().dashboard()).gateway.status).toBe("reconnecting");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10000);
    await stub().start();
    await frame({ op: 10, d: { heartbeat_interval: 45000 } });
    expect(socket().sent.some((item) => item.op === 2)).toBe(true);
    expect(socket().sent.some((item) => item.op === 6)).toBe(false);
  });
  it("stops on a fatal intent error instead of retrying indefinitely", async () => {
    await ready();
    await runInDurableObject(stub(), () => { socket().dispatchEvent(new CloseEvent("close", { code: 4014 })); });
    await expect.poll(async () => (await stub().dashboard()).gateway.status).toBe("error");
    expect((await stub().dashboard()).gateway.error).toContain("Message Content Intent");
    const count = GatewaySocket.instances.length;
    await stub().watchdog();
    expect(GatewaySocket.instances).toHaveLength(count);
  });
});
