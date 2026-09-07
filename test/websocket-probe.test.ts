import { describe, expect, it } from "vitest";
import { createWebSocketProbeRequest, probeResponsesWebSocket } from "../src/codex/websocket-probe";
import { CLIENT_VERSION, CODEX_ORIGINATOR, CODEX_USER_AGENT } from "../src/codex/constants";
import type { StoredCredentials } from "../src/types";

const credentials: StoredCredentials = {
  idToken: "fixture-id-token",
  accessToken: "fixture-access-token",
  refreshToken: "fixture-refresh-token",
  accountId: "acct_fixture",
  expiresAt: Date.now() + 60_000,
  lastRefreshAt: Date.now(),
  version: 1,
};

class FakeWebSocket extends EventTarget {
  accepted = false;
  sent = 0;
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(private readonly event: "close" | "error" | "none" = "close") { super(); }

  accept(): void {
    this.accepted = true;
    if (this.event === "none") return;
    queueMicrotask(() => {
      if (this.event === "error") {
        this.dispatchEvent(new Event("error"));
        return;
      }
      this.dispatchEvent(new MessageEvent("message", { data: "SECRET_FRAME" }));
      const close = new Event("close");
      Object.defineProperty(close, "code", { value: 4001 });
      Object.defineProperty(close, "reason", { value: "SECRET_CLOSE_REASON" });
      this.dispatchEvent(close);
    });
  }

  send(): void { this.sent += 1; }
  close(code?: number, reason?: string): void { this.closeCalls.push({ code, reason }); }
}

function upgradedResponse(webSocket: FakeWebSocket): Response {
  const response = new Response(null, { headers: { "OpenAI-Model": "SECRET_MODEL", "X-Reasoning-Included": "true" } });
  Object.defineProperty(response, "status", { value: 101 });
  Object.defineProperty(response, "webSocket", { value: webSocket });
  return response;
}

describe("Responses WebSocket handshake probe", () => {
  it("builds the fixed authenticated handshake without a body, query, or model", () => {
    const request = createWebSocketProbeRequest(credentials);
    expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("manual");
    expect(request.body).toBeNull();
    expect(Object.fromEntries(request.headers)).toEqual({
      accept: "application/json",
      authorization: "Bearer fixture-access-token",
      "chatgpt-account-id": "acct_fixture",
      "content-type": "application/json",
      "openai-beta": "responses_websockets=2026-02-06",
      originator: CODEX_ORIGINATOR,
      upgrade: "websocket",
      "user-agent": CODEX_USER_AGENT,
      version: CLIENT_VERSION,
    });
  });

  it("accepts an upgrade, observes events without payloads, sends no frame, and closes normally", async () => {
    const socket = new FakeWebSocket();
    const result = await probeResponsesWebSocket(credentials, async () => upgradedResponse(socket), 20);
    expect(result).toEqual({
      status: 101,
      upgraded: true,
      serverSelectedModelPresent: true,
      reasoningIncluded: true,
      messageObserved: true,
      errorObserved: false,
      closed: true,
      closeCode: 4001,
    });
    expect(socket.accepted).toBe(true);
    expect(socket.sent).toBe(0);
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
    expect(JSON.stringify(result)).not.toContain("SECRET_FRAME");
    expect(JSON.stringify(result)).not.toContain("SECRET_CLOSE_REASON");
    expect(JSON.stringify(result)).not.toContain("SECRET_MODEL");
  });

  it("returns the existing redacted diagnostic for a normal HTTP response", async () => {
    const result = await probeResponsesWebSocket(credentials, async () => new Response(
      "<!doctype html><title>Just a moment...</title>SECRET_BODY",
      { status: 403, headers: { "Content-Type": "text/html", Server: "cloudflare", "CF-Ray": "abc-SIN" } },
    ));
    expect(result).toMatchObject({
      status: 403,
      upgraded: false,
      diagnostic: { status: 403, cfRay: "abc-SIN", errorCategory: "cloudflare_interstitial" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_BODY");
  });

  it("rejects a 101 response without a WebSocket", async () => {
    const response = new Response(null);
    Object.defineProperty(response, "status", { value: 101 });
    await expect(probeResponsesWebSocket(credentials, async () => response)).rejects.toMatchObject({
      code: "websocket_upgrade_missing",
    });
  });

  it("bounds no-event observation and records an error event without exposing details", async () => {
    const quiet = new FakeWebSocket("none");
    const quietResult = await probeResponsesWebSocket(credentials, async () => upgradedResponse(quiet), 10);
    expect(quietResult).toMatchObject({ upgraded: true, messageObserved: false, errorObserved: false, closed: false, closeCode: null });
    expect(quiet.closeCalls).toEqual([{ code: 1000, reason: undefined }]);

    const failed = new FakeWebSocket("error");
    const failedResult = await probeResponsesWebSocket(credentials, async () => upgradedResponse(failed), 20);
    expect(failedResult).toMatchObject({ upgraded: true, messageObserved: false, errorObserved: true, closed: false, closeCode: null });
    expect(failed.sent).toBe(0);
  });

  it("times out fetch and non-ending HTTP bodies and cancels the body", async () => {
    await expect(probeResponsesWebSocket(credentials, async (request) => new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    }), 20, 10)).rejects.toMatchObject({ code: "websocket_probe_timeout" });

    let cancelled = false;
    const body = new ReadableStream({ pull() {}, cancel() { cancelled = true; } });
    await expect(probeResponsesWebSocket(
      credentials,
      async () => new Response(body, { status: 403, headers: { "Content-Type": "text/html" } }),
      20,
      10,
    )).rejects.toMatchObject({ code: "websocket_probe_response_timeout" });
    expect(cancelled).toBe(true);
  });

  it("enforces the deadline when fetch ignores abort and closes a late 101 without accepting it", async () => {
    const socket = new FakeWebSocket("none");
    await expect(probeResponsesWebSocket(
      credentials,
      async () => new Promise((resolve) => setTimeout(() => resolve(upgradedResponse(socket)), 25)),
      20,
      5,
    )).rejects.toMatchObject({ code: "websocket_probe_timeout" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(socket.accepted).toBe(false);
    expect(socket.sent).toBe(0);
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
  });

  it("caps oversized non-101 bodies before applying the existing diagnostic", async () => {
    const result = await probeResponsesWebSocket(
      credentials,
      async () => new Response(new Uint8Array(64 * 1024 + 2), { status: 403, headers: { "Content-Type": "text/plain" } }),
    );
    expect(result.diagnostic).toMatchObject({ bodyBytes: 64 * 1024, bodyTruncated: true });
  });
});
