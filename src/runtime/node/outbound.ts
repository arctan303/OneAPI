import { AUTH_BASE_URL, CODEX_BASE_URL } from "../../codex/constants";

export type NodeFetch = (request: Request) => Promise<Response>;

const allowed = new Map<string, ReadonlyMap<string, string>>([
  [new URL(AUTH_BASE_URL).hostname, new Map([
    ["/api/accounts/deviceauth/usercode", "POST"],
    ["/api/accounts/deviceauth/token", "POST"],
    ["/oauth/token", "POST"]
  ])],
  [new URL(CODEX_BASE_URL).hostname, new Map([
    ["/backend-api/codex/models", "GET"],
    ["/backend-api/codex/responses", "POST"],
    ["/backend-api/wham/usage", "GET"]
  ])]
]);

export function createDirectOutbound(fetchImpl: NodeFetch = (request) => fetch(request)): NodeFetch {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const accessCerts = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(url.hostname)
      && url.pathname === "/cdn-cgi/access/certs";
    const expectedMethod = accessCerts ? "GET" : allowed.get(url.hostname)?.get(url.pathname);
    if (
      url.protocol !== "https:" || url.port || url.username || url.password ||
      request.method !== expectedMethod
    ) {
      throw new Error("Node outbound rejected an unauthorized target");
    }
    if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/models") {
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 1 || keys[0] !== "client_version" || !url.searchParams.get("client_version")) {
        throw new Error("Node outbound rejected an invalid models query");
      }
    } else if (url.search) {
      throw new Error("Node outbound rejected an unauthorized query");
    }
    if (request.headers.has("cf-worker") || request.headers.has("cf-connecting-ip")) {
      throw new Error("Node outbound rejected Cloudflare provenance headers");
    }
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : new Uint8Array(await request.arrayBuffer());
    const upstreamRequest = new Request(url, {
      method: request.method,
      headers: request.headers,
      body,
      redirect: "manual",
      signal: request.signal
    });
    const upstream = await fetchImpl(upstreamRequest);
    if (upstream.status >= 300 && upstream.status < 400) {
      void upstream.body?.cancel().catch(() => undefined);
      throw new Error("Node outbound rejected an upstream redirect");
    }
    const headers = new Headers(upstream.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  };
}