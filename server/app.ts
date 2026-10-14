import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { handleRequest } from "../core/http";
import { GuildService } from "../core/guild";
import { missingConfiguration, type AppEnvironment } from "../core/contracts";
import { staticAssets } from "./assets";
import type { ServerConfig } from "./config";
import { NodeRuntime } from "./runtime";

function webRequest(incoming: IncomingMessage, publicUrl: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  // PUBLIC_URL is authoritative. Proxy and Host headers cannot change OAuth URLs or cookie security.
  const target = incoming.url || "/";
  const url = new URL(publicUrl);
  const separator = target.indexOf("?");
  url.pathname = separator < 0 ? target : target.slice(0, separator);
  url.search = separator < 0 ? "" : target.slice(separator);
  const init: RequestInit & { duplex?: "half" } = { method: incoming.method, headers };
  if (!["GET", "HEAD"].includes(incoming.method || "GET")) {
    init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function sendResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  for (const [key, value] of response.headers) if (key !== "set-cookie") outgoing.setHeader(key, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("Set-Cookie", cookies);
  if (!response.body) { outgoing.end(); return; }
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), outgoing);
}

export async function startServer(config: ServerConfig) {
  const runtime = new NodeRuntime(join(config.dataDir, "guild.sqlite"));
  let service: GuildService;
  try { service = new GuildService(runtime, config); }
  catch (error) { await runtime.close(); throw error; }
  const environment: AppEnvironment = { ...config, guild: service, assets: staticAssets(config.assetsDir), hosting: "docker" };
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (incoming, outgoing) => {
    void (async () => {
      if (incoming.url === "/healthz" && incoming.method === "GET") {
        runtime.sql.exec("SELECT 1 AS ok").one();
        await sendResponse(Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } }), outgoing);
      } else await sendResponse(await handleRequest(webRequest(incoming, config.publicUrl), environment), outgoing);
    })().catch(() => {
      console.error(JSON.stringify({ event: "http_request_failed" }));
      if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end('{"error":"Request failed."}');
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { await service.shutdown(); await runtime.close(); throw error; }
  runtime.start(service, !missingConfiguration(config).length);
  let closing: Promise<void> | null = null;
  return {
    server, service, runtime,
    close(): Promise<void> {
      closing ??= (async () => {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await service.shutdown();
        await runtime.close();
      })();
      return closing;
    },
  };
}
