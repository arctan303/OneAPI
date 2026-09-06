import { AccountDurableObject } from "./account";
import { errorResponse, GatewayError } from "./errors";
import { ADMIN_SESSION_COOKIE } from "./security";
import type { Env } from "./types";

export { AccountDurableObject };

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function sameOrigin(value: string, expected: string): boolean {
  try {
    const parsed = new URL(value);
    return value !== "null" && value === parsed.origin && parsed.origin === expected;
  } catch {
    return false;
  }
}

function hasAdminSessionCookie(request: Request): boolean {
  return (request.headers.get("Cookie") ?? "")
    .split(";")
    .some((part) => part.trim().startsWith(`${ADMIN_SESSION_COOKIE}=`));
}

function enforceAdminBrowserBoundary(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new GatewayError(403, "site_not_allowed", "非同源页面的管理请求已拒绝。", undefined, "permission_error");
  }
  if (origin !== null && !sameOrigin(origin, url.origin)) {
    throw new GatewayError(403, "origin_not_allowed", "跨站管理请求已拒绝。", undefined, "permission_error");
  }
  const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
  if (!mutation) return;
  const login = request.method === "POST" && url.pathname === "/admin/session";
  if ((login || hasAdminSessionCookie(request)) && origin === null) {
    throw new GatewayError(403, "origin_required", "使用管理会话的写操作必须来自当前页面同源。", undefined, "permission_error");
  }
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new GatewayError(415, "json_required", "管理写操作只接受 application/json。", undefined, "invalid_request_error");
  }
}

function secureHeaders(response: Response, sensitive: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  if (sensitive) headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function bridgeStreamCancellation(response: Response, stub: DurableObjectStub, internalKey: string): Response {
  const leaseId = response.headers.get("X-OneAPI-Internal-Lease");
  if (!leaseId || !response.body) return response;
  const headers = new Headers(response.headers);
  headers.delete("X-OneAPI-Internal-Lease");
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await Promise.allSettled([
        reader.cancel(reason),
        stub.fetch(`https://oneapi.internal/__internal/cancel?lease_id=${encodeURIComponent(leaseId)}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${internalKey}` }
        })
      ]);
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const url = new URL(request.url);
    let response: Response;
    try {
      if (env.ALLOW_TEST_HOSTS !== "true" && !isLoopback(url.hostname)) {
        throw new GatewayError(403, "host_not_allowed", "本地 Demo 只接受 loopback Host。", undefined, "permission_error");
      }
      const protectedRoute = url.pathname.startsWith("/admin/") || url.pathname.startsWith("/v1/");
      if (url.pathname.startsWith("/admin/")) {
        enforceAdminBrowserBoundary(request, url);
      }
      if (request.method === "GET" && url.pathname === "/health") {
        response = Response.json({
          ok: true,
          service: "oneapi-codex-gateway-demo",
          ...(env.MOCK_UPSTREAM === "true" && env.MOCK_INSTANCE_NONCE ? { instanceNonce: env.MOCK_INSTANCE_NONCE } : {})
        });
      } else if (protectedRoute) {
        const id = env.ACCOUNT.idFromName("primary");
        const stub = env.ACCOUNT.get(id);
        response = bridgeStreamCancellation(await stub.fetch(request), stub, env.TOKEN_ENCRYPTION_KEY);
      } else {
        response = await env.ASSETS.fetch(request);
      }
      response = secureHeaders(response, protectedRoute);
    } catch (error) {
      response = secureHeaders(errorResponse(error, requestId), true);
    }
    console.log(JSON.stringify({ requestId, path: url.pathname, method: request.method, status: response.status, durationMs: Date.now() - startedAt }));
    return response;
  }
};
