import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

export function staticAssets(directory: string) {
  const root = resolve(directory);
  return {
    async fetch(request: Request): Promise<Response> {
      if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(request.url).pathname); }
      catch { return new Response("Invalid path", { status: 400 }); }
      if (pathname.includes("\0") || pathname.split("/").some((part) => part.startsWith("."))) return new Response("Not found", { status: 404 });
      let file = resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(root + sep)) return new Response("Not found", { status: 404 });
      let metadata = await stat(file).catch(() => null);
      if (!metadata?.isFile()) {
        if (extname(pathname)) return new Response("Not found", { status: 404 });
        file = resolve(root, "index.html");
        metadata = await stat(file).catch(() => null);
      }
      if (!metadata?.isFile()) return new Response("Frontend build is missing. Run npm run build:docker.", { status: 503 });
      const headers = {
        "Content-Type": contentTypes[extname(file)] || "application/octet-stream",
        "Content-Length": String(metadata.size),
        "Cache-Control": file.startsWith(resolve(root, "assets") + sep) ? "public, max-age=31536000, immutable" : "no-cache",
      };
      return new Response(request.method === "HEAD" ? null : Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, { headers });
    },
  };
}
