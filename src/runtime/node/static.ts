import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

const ASSETS = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }]
]);

interface LoadedAsset { bytes: Uint8Array<ArrayBuffer>; type: string; }

export async function createStaticHandler(publicDir: string): Promise<(request: Request) => Promise<Response>> {
  const root = await realpath(publicDir);
  const loaded = new Map<string, LoadedAsset>();
  for (const [pathname, definition] of ASSETS) {
    if (pathname === "/") continue;
    const filename = await realpath(resolve(root, definition.file));
    if (filename !== root && !filename.startsWith(root + "\\") && !filename.startsWith(root + "/")) {
      throw new Error("Static asset escaped the configured public directory");
    }
    const source = await readFile(filename);
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    loaded.set(pathname, { bytes, type: definition.type });
  }
  loaded.set("/", loaded.get("/index.html")!);
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" } });
    }
    const url = new URL(request.url);
    const asset = loaded.get(url.pathname);
    if (!asset || url.search) return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const headers = new Headers({
      "Content-Type": asset.type,
      "Content-Length": String(asset.bytes.byteLength),
      "Cache-Control": "no-cache"
    });
    return new Response(request.method === "HEAD" ? null : asset.bytes.slice(), { status: 200, headers });
  };
}