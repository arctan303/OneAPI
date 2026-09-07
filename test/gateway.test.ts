import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { configureMockUpstream, mockUpstreamStats, resetMockUpstream } from "../src/codex/mock";
import { collectUpstreamDiagnostic, readBoundedErrorCode } from "../src/codex/upstream";
import { decryptRelayRequest, encryptRelayResponse, fixedRelayGenerationBody } from "../src/relay-protocol";
import type { Env, StoredCredentials } from "../src/types";

const admin = "mock-admin-key-for-tests-only-00000001";
const gateway = "mock-gateway-key-for-tests-only-0001";
const auth = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });
const relayKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const relayOrigin = "https://relay-test.example";
const base64Text = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const accountStub = () => {
  const testEnv = env as unknown as import("../src/types").Env;
  return testEnv.ACCOUNT.get(testEnv.ACCOUNT.idFromName("primary"));
};

async function expireCredentials(): Promise<void> {
  await runInDurableObject(accountStub(), async (instance) => {
    const account = (instance as unknown as { service: unknown }).service as {
      readCredentials(): Promise<StoredCredentials>;
      writeCredentials(value: StoredCredentials): Promise<void>;
    };
    const credentials = await account.readCredentials();
    await account.writeCredentials({ ...credentials, expiresAt: 0 });
  });
}

async function connect(): Promise<void> {
  const started = await SELF.fetch("https://example.com/admin/device/start", { method: "POST", headers: auth(admin), body: "{}" });
  expect(started.status).toBe(200);
  const login = await started.json() as { id: string; nextPollAt: number };
  await new Promise((resolve) => setTimeout(resolve, Math.max(30, login.nextPollAt - Date.now() + 2)));
  const polled = await SELF.fetch("https://example.com/admin/device/poll", { method: "POST", headers: auth(admin), body: JSON.stringify({ login_id: login.id }) });
  expect(polled.status).toBe(200);
  expect((await polled.json() as { status: string }).status).toBe("connected");
}

describe("gateway Worker + Durable Object", () => {
  beforeEach(async () => {
    resetMockUpstream();
    await SELF.fetch("https://example.com/admin/disconnect", { method: "POST", headers: auth(admin), body: "{}" });
  });

  it("separates admin and gateway authentication and rejects cross-site admin calls", async () => {
    expect((await SELF.fetch("https://example.com/admin/status")).status).toBe(401);
    expect((await SELF.fetch("https://example.com/admin/status", { headers: auth(gateway) })).status).toBe(401);
    expect((await SELF.fetch("https://example.com/v1/models", { headers: auth(admin) })).status).toBe(401);
    const crossSite = await SELF.fetch("https://example.com/admin/status", { headers: { ...auth(admin), Origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps egress diagnostics admin-only and disabled by default", async () => {
    const request = { method: "POST", headers: auth(gateway), body: JSON.stringify({ operation: "ping" }) };
    const ordinary = await SELF.fetch("https://example.com/admin/diagnostics/egress", request);
    expect(ordinary.status).toBe(401);
    const disabled = await SELF.fetch("https://example.com/admin/diagnostics/egress", {
      ...request,
      headers: auth(admin)
    });
    expect(disabled.status).toBe(503);
    expect((await disabled.json() as { error: { code: string; diagnostic?: unknown } }).error)
      .toEqual(expect.objectContaining({ code: "egress_diagnostic_disabled" }));
  });

  it("keeps websocket diagnostics admin-only and disabled by default", async () => {
    const request = { method: "POST", headers: auth(gateway), body: "{}" };
    expect((await SELF.fetch("https://example.com/admin/diagnostics/websocket", request)).status).toBe(401);
    const disabled = await SELF.fetch("https://example.com/admin/diagnostics/websocket", {
      ...request,
      headers: auth(admin),
    });
    expect(disabled.status).toBe(503);
    expect((await disabled.json() as { error: { code: string } }).error.code).toBe("websocket_diagnostic_disabled");
  });

  it("compares direct and relay models with one credential without exposing it", async () => {
    await connect();
    await runInDurableObject(accountStub(), async (instance) => {
      const account = (instance as unknown as { service: unknown }).service as {
        env: Env;
        readCredentials(): Promise<StoredCredentials>;
        performFetch(request: Request): Promise<Response>;
        diagnoseEgress(request: Request, requestId: string): Promise<Response>;
      };
      const originalFetch = account.performFetch;
      account.env.ONEAPI_RELAY_ORIGIN = relayOrigin;
      account.env.ONEAPI_RELAY_KEY = relayKey;
      const credentials = await account.readCredentials();
      const calls: string[] = [];
      let directAuthorization = "";
      let relayedAuthorization = "";
      account.performFetch = async (outbound) => {
        const url = new URL(outbound.url);
        if (url.origin === "https://chatgpt.com") {
          calls.push("direct");
          directAuthorization = outbound.headers.get("authorization") ?? "";
          return Response.json({ models: [{ slug: "gpt-direct", supported_in_api: true }] });
        }
        expect(url.href).toBe(`${relayOrigin}/relay`);
        calls.push("relay");
        const plain = await decryptRelayRequest(relayKey, await outbound.json());
        expect(plain.operation).toBe("models");
        expect(plain.clientVersion).toBe("0.153.4");
        expect(plain).not.toHaveProperty("bodyText");
        relayedAuthorization = plain.headers.authorization ?? "";
        const bodyText = JSON.stringify({ models: [{ slug: "gpt-relay", supported_in_api: true }] });
        const envelope = await encryptRelayResponse(relayKey, {
          requestId: plain.requestId,
          status: 200,
          headers: { "content-type": "application/json" },
          bodyBase64: base64Text(bodyText)
        });
        return Response.json(envelope);
      };
      const response = await account.diagnoseEgress(new Request("https://example.com/admin/diagnostics/egress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "models" })
      }), crypto.randomUUID());
      expect(response.status).toBe(200);
      const result = await response.json() as {
        direct: { modelCount: number; modelIds: string[] };
        relay: { modelCount: number; modelIds: string[] };
        sameCredential: boolean;
      };
      expect(calls).toEqual(["direct", "relay"]);
      expect(directAuthorization).toBe(`Bearer ${credentials.accessToken}`);
      expect(relayedAuthorization).toBe(directAuthorization);
      expect(result).toMatchObject({
        direct: { modelCount: 1, modelIds: ["gpt-direct"] },
        relay: { modelCount: 1, modelIds: ["gpt-relay"] },
        sameCredential: true
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(credentials.accessToken);
      expect(serialized).not.toContain(credentials.accountId);
      account.performFetch = originalFetch;
      delete account.env.ONEAPI_RELAY_ORIGIN;
      delete account.env.ONEAPI_RELAY_KEY;
    });
  });

  it("binds relay responses to the request and summarizes fixed generation without text", async () => {
    await connect();
    await runInDurableObject(accountStub(), async (instance) => {
      const account = (instance as unknown as { service: unknown }).service as {
        env: Env;
        readCredentials(): Promise<StoredCredentials>;
        performFetch(request: Request): Promise<Response>;
        diagnoseEgress(request: Request, requestId: string): Promise<Response>;
      };
      const originalFetch = account.performFetch;
      account.env.ONEAPI_RELAY_ORIGIN = relayOrigin;
      account.env.ONEAPI_RELAY_KEY = relayKey;
      const credentials = await account.readCredentials();
      let mismatch = true;
      account.performFetch = async (outbound) => {
        const plain = await decryptRelayRequest(relayKey, await outbound.json());
        if (mismatch) {
          return Response.json(await encryptRelayResponse(relayKey, {
            requestId: crypto.randomUUID(),
            status: 200,
            headers: {},
            service: "oneapi-egress-relay"
          }));
        }
        expect(plain.operation).toBe("generate");
        expect(plain.bodyText).toBe(JSON.stringify(fixedRelayGenerationBody()));
        expect(plain.headers.authorization).toBe(`Bearer ${credentials.accessToken}`);
        const terminal = {
          type: "response.completed",
          response: {
            id: "resp_egress",
            object: "response",
            status: "completed",
            model: "gpt-5.5",
            output: [],
            output_text: "EGRESS_OK",
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
          }
        };
        const sse = `event: response.completed\ndata: ${JSON.stringify(terminal)}\n\n`;
        return Response.json(await encryptRelayResponse(relayKey, {
          requestId: plain.requestId,
          status: 200,
          headers: { "content-type": "text/event-stream" },
          bodyBase64: base64Text(sse)
        }));
      };
      await expect(account.diagnoseEgress(new Request("https://example.com/admin/diagnostics/egress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "ping" })
      }), crypto.randomUUID())).rejects.toMatchObject({ code: "relay_response_mismatch" });

      mismatch = false;
      const response = await account.diagnoseEgress(new Request("https://example.com/admin/diagnostics/egress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "generate" })
      }), crypto.randomUUID());
      const result = await response.json() as {
        relay: { completed: boolean; responseChars: number; usage: Record<string, number> };
      };
      expect(result.relay).toMatchObject({
        completed: true,
        responseChars: 9,
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }
      });
      expect(JSON.stringify(result)).not.toContain("EGRESS_OK");
      account.performFetch = originalFetch;
      delete account.env.ONEAPI_RELAY_ORIGIN;
      delete account.env.ONEAPI_RELAY_KEY;
    });
  });

  it("completes mock device login and stores only encrypted credential material", async () => {
    await connect();
    const status = await SELF.fetch("https://example.com/admin/status", { headers: auth(admin) });
    const body = await status.json() as { connected: boolean; account: { idHint: string }; login: { userCode: string } };
    expect(body.connected).toBe(true);
    expect(body.account.idHint).toMatch(/^…/);
    expect(body.login.userCode).toBe("");

    await runInDurableObject(accountStub(), async (_instance, state) => {
      const stored = await state.storage.get("credentials");
      const serialized = JSON.stringify(stored);
      expect(serialized).not.toContain("mock-refresh");
      expect(serialized).not.toContain("acct_mock");
      expect(serialized).toContain("ciphertext");
    });
  });

  it("supports models, Responses and Chat ordinary/streaming text without corrupting Chinese", async () => {
    await connect();
    const models = await SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) });
    expect(models.status).toBe(200);
    expect((await models.json() as { data: Array<{ id: string }> }).data[0]?.id).toBe("gpt-mock");
    const codexModels = await SELF.fetch("https://example.com/v1/models?client_version=0.153.4&future_catalog_option=1", { headers: auth(gateway) });
    expect(codexModels.status).toBe(200);
    const codexCatalog = await codexModels.json() as { data: Array<{ id: string }>; models: Array<Record<string, unknown>> };
    expect(codexCatalog.models[0]).toMatchObject({
      slug: "gpt-mock",
      shell_type: "shell_command",
      base_instructions: "You are a test coding agent.",
      future_catalog_field: { preserved: true }
    });
    expect(codexCatalog.data[0]?.id).toBe("gpt-mock");

    const response = await SELF.fetch("https://example.com/v1/responses", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", input: "hello" }) });
    expect(response.status).toBe(200);
    expect((await response.json() as { output_text: string }).output_text).toBe("你好，mock");

    const streamed = await SELF.fetch("https://example.com/v1/responses", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", input: "hello", stream: true }) });
    const streamText = await streamed.text();
    expect(streamText).toContain("response.output_text.delta");
    expect(streamText).toContain("你好");
    expect(streamText).toContain("response.completed");

    const chat = await SELF.fetch("https://example.com/v1/chat/completions", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", messages: [{ role: "user", content: "hello" }] }) });
    expect((await chat.json() as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe("你好，mock");

    const chatStream = await SELF.fetch("https://example.com/v1/chat/completions", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", messages: [{ role: "user", content: "hello" }], stream: true, stream_options: { include_usage: true } }) });
    const chatText = await chatStream.text();
    expect(chatText).toContain("chat.completion.chunk");
    expect(chatText).toContain("[DONE]");
    expect(chatText).toContain("prompt_tokens");
  });

  it("sends the official Codex protocol identity while retaining an explicit integration suffix", async () => {
    await connect();
    const models = await SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) });
    expect(models.status).toBe(200);
    const modelStats = mockUpstreamStats();
    expect(modelStats).toMatchObject({
      codexRequests: 1,
      lastOriginator: "codex_cli_rs",
      lastVersion: "0.153.4",
      lastClientVersion: "0.153.4",
      lastAuthorizationIsBearer: true,
      lastAccountHeaderPresent: true
    });
    expect(modelStats.lastUserAgent).toBe("codex_cli_rs/0.153.4 (Cloudflare Workers; JavaScript) OneAPI/0.1.0");

    const response = await SELF.fetch("https://example.com/v1/responses", {
      method: "POST",
      headers: auth(gateway),
      body: JSON.stringify({ model: "gpt-mock", input: "hello" })
    });
    expect(response.status).toBe(200);
    expect(mockUpstreamStats()).toMatchObject({ codexRequests: 2, lastClientVersion: "" });
  });

  it("forwards reviewed Codex metadata headers through the authenticated gateway path", async () => {
    await connect();
    const headers = new Headers(auth(gateway));
    headers.set("Cookie", "client-secret=must-not-forward");
    headers.set("X-Codex-Beta-Features", "remote_compaction_v2");
    headers.set("X-Codex-Window-Id", "window-integration");
    headers.set("X-Future-Header", "must-not-forward");
    const response = await SELF.fetch("https://example.com/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-mock",
        input: [{ type: "additional_tools", tools: [] }, { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
        client_metadata: { "x-codex-installation-id": "install-integration" }
      })
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(mockUpstreamStats()).toMatchObject({
      lastCodexBetaFeatures: "remote_compaction_v2",
      lastCodexWindowId: "window-integration",
      lastCookiePresent: false
    });
  });

  it("bounds upstream diagnostic JSON and ignores arbitrary detail text", async () => {
    const detailOnly = Response.json({ detail: "acct_internal_marker" }, { status: 403 });
    expect(await readBoundedErrorCode(detailOnly)).toBe("");

    let pulls = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode("x".repeat(40 * 1024));
    const oversized = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      }
    }), { status: 403, headers: { "Content-Type": "application/json" } });
    expect(await readBoundedErrorCode(oversized)).toBe("");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);

    const coded = Response.json({ error: { code: "permission_denied" }, detail: "ignored" }, { status: 403 });
    expect(await readBoundedErrorCode(coded)).toBe("permission_denied");

    const html = new Response("<!doctype html><title>Just a moment...</title><p>SECRET_BODY_MUST_NOT_APPEAR</p>", {
      status: 403,
      headers: {
        "Content-Type": "text/html; charset=UTF-8",
        Server: "cloudflare",
        "cf-ray": "abc123-SIN",
        "cf-mitigated": "challenge",
        "x-request-id": "req_edge_123"
      }
    });
    const diagnostic = await collectUpstreamDiagnostic(html, "https://chatgpt.com/backend-api/codex/models?client_version=test");
    expect(diagnostic).toMatchObject({
      event: "codex_upstream_rejected",
      upstreamHostname: "chatgpt.com",
      upstreamPath: "/backend-api/codex/models",
      status: 403,
      contentType: "text/html; charset=UTF-8",
      bodyBytes: expect.any(Number),
      bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      bodyFormat: "html_text",
      server: "cloudflare",
      cfRay: "abc123-SIN",
      cfMitigated: "challenge",
      upstreamRequestId: "req_edge_123",
      htmlTitle: "Just a moment...",
      errorCategory: "cloudflare_challenge"
    });
    expect(diagnostic.bodyBytes).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostic)).not.toContain("SECRET_BODY_MUST_NOT_APPEAR");

    const unknownTitle = new Response("<title>Account user@example.com abcdefghijklmnopqrstuvwxyz</title>", {
      status: 403,
      headers: { "Content-Type": "text/html" }
    });
    const redacted = await collectUpstreamDiagnostic(unknownTitle, "https://chatgpt.com/backend-api/codex/responses");
    expect(redacted.htmlTitle).toBe("[redacted]");
    expect(JSON.stringify(redacted)).not.toContain("user@example.com");

    const ambiguousAttention = await collectUpstreamDiagnostic(new Response("<title>Attention Required! | Cloudflare</title>", {
      status: 403,
      headers: { "Content-Type": "text/html", Server: "cloudflare" }
    }), "https://chatgpt.com/backend-api/codex/models");
    expect(ambiguousAttention.errorCategory).toBe("cloudflare_attention_required");

    const sensitiveCode = await collectUpstreamDiagnostic(Response.json({
      error: { code: "acct_internal_marker" }
    }, { status: 403 }), "https://chatgpt.com/backend-api/codex/models");
    expect(sensitiveCode.errorCategory).toBe("structured_json_error");
    expect(JSON.stringify(sensitiveCode)).not.toContain("acct_internal_marker");
    expect(sensitiveCode).not.toHaveProperty("upstreamCode");

    const plainCode = await collectUpstreamDiagnostic(new Response("error code: 1003", {
      status: 403,
      headers: { "Content-Type": "text/plain", Server: "cloudflare" }
    }), "https://chatgpt.com/backend-api/codex/models");
    expect(plainCode.cfErrorCode).toBe("1003");
    expect(plainCode.errorCategory).toBe("cloudflare_error_code");
    expect(plainCode.bodyFormat).toBe("text");
    const untrustedPlainCode = await collectUpstreamDiagnostic(new Response("error code: 1003", {
      status: 403,
      headers: { "Content-Type": "text/plain" }
    }), "https://chatgpt.com/backend-api/codex/models");
    expect(untrustedPlainCode).not.toHaveProperty("cfErrorCode");

    const compressed = await collectUpstreamDiagnostic(new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]), {
      status: 403,
      headers: { "Content-Type": "text/html", "Content-Encoding": "gzip", Server: "cloudflare" }
    }), "https://chatgpt.com/backend-api/codex/models");
    expect(compressed).toMatchObject({ contentEncoding: "gzip", bodyFormat: "gzip_magic" });
    expect(compressed).not.toHaveProperty("htmlTitle");
  });

  it("preserves tool calls, tool results and explicit multi-turn context", async () => {
    await connect();
    const tools = [{ type: "function", function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];
    const first = await SELF.fetch("https://example.com/v1/chat/completions", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", messages: [{ role: "developer", content: "Be concise" }, { role: "user", content: "call_tool 天气" }], tools }) });
    const firstBody = await first.json() as { choices: Array<{ finish_reason: string; message: { tool_calls: Array<{ id: string; function: { arguments: string } }> } }> };
    expect(firstBody.choices[0]?.finish_reason).toBe("tool_calls");
    expect(JSON.parse(firstBody.choices[0]!.message.tool_calls[0]!.function.arguments)).toEqual({ city: "Singapore" });
    const callId = firstBody.choices[0]!.message.tool_calls[0]!.id;

    const second = await SELF.fetch("https://example.com/v1/chat/completions", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", messages: [{ role: "user", content: "call_tool 天气" }, { role: "assistant", content: null, tool_calls: firstBody.choices[0]!.message.tool_calls }, { role: "tool", tool_call_id: callId, content: "31 C" }, { role: "user", content: "summarize result" }] }) });
    expect(second.status).toBe(200);
  });

  it("ignores unknown parameters but rejects unsupported stateful semantics", async () => {
    await connect();
    for (const body of [
      { model: "gpt-mock", input: "x", store: true },
      { model: "gpt-mock", input: "x", background: true },
      { model: "gpt-mock", input: "x", previous_response_id: "resp_x" },
      { model: "gpt-mock", input: "x", conversation: "conv_x" }
    ]) {
      const response = await SELF.fetch("https://example.com/v1/responses", { method: "POST", headers: auth(gateway), body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: { param?: string } }).error.param).toBeTruthy();
    }

    const before = mockUpstreamStats().generationRequests;
    const ignored = await SELF.fetch("https://example.com/v1/responses", {
      method: "POST",
      headers: auth(gateway),
      body: JSON.stringify({ model: "gpt-mock", input: "x", service_tier: "priority", future_option: { value: 1 } })
    });
    expect(ignored.status).toBe(200);
    expect(ignored.headers.get("X-OneAPI-Ignored-Parameters")).toBe("service_tier, future_option");
    await ignored.text();
    const stats = mockUpstreamStats();
    expect(stats.generationRequests).toBe(before + 1);
    expect(stats.lastGenerationBodyKeys).not.toEqual(expect.arrayContaining(["service_tier", "future_option"]));
  });

  it("enforces concurrency for the full stream lifetime and releases at terminal completion", async () => {
    await connect();
    const init = { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", input: "slow", stream: true }) };
    const first = await SELF.fetch("https://example.com/v1/responses", init);
    const second = await SELF.fetch("https://example.com/v1/responses", init);
    const third = await SELF.fetch("https://example.com/v1/responses", init);
    expect(third.status).toBe(429);
    expect((await third.json() as { error: { code: string } }).error.code).toBe("local_concurrency_limit");
    await Promise.all([first.text(), second.text()]);
    const afterCancel = await SELF.fetch("https://example.com/v1/responses", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", input: "hello" }) });
    expect(afterCancel.status).toBe(200);
  });

  it("handles pending, cancel, expiry, double poll and cancel-vs-poll without reviving credentials", async () => {
    configureMockUpstream({ devicePoll: "pending" });
    const started = await SELF.fetch("https://example.com/admin/device/start", { method: "POST", headers: auth(admin), body: "{}" });
    const login = await started.json() as { id: string; nextPollAt: number };
    await new Promise((resolve) => setTimeout(resolve, Math.max(30, login.nextPollAt - Date.now() + 2)));
    const pending = await SELF.fetch("https://example.com/admin/device/poll", { method: "POST", headers: auth(admin), body: JSON.stringify({ login_id: login.id }) });
    expect((await pending.json() as { status: string }).status).toBe("pending");
    const cancelled = await SELF.fetch("https://example.com/admin/device/cancel", { method: "POST", headers: auth(admin), body: JSON.stringify({ login_id: login.id }) });
    expect(cancelled.status).toBe(204);

    configureMockUpstream({ devicePoll: "normal" });
    const expiring = await (await SELF.fetch("https://example.com/admin/device/start", { method: "POST", headers: auth(admin), body: "{}" })).json() as { id: string };
    await runInDurableObject(accountStub(), async (_instance, state) => {
      const stateValue = await state.storage.get<Record<string, unknown>>("login-public");
      await state.storage.put("login-public", { ...stateValue, expiresAt: Date.now() - 1 });
    });
    const expiredStatus = await SELF.fetch("https://example.com/admin/status", { headers: auth(admin) });
    expect((await expiredStatus.json() as { login: { status: string } }).login.status).toBe("expired");

    configureMockUpstream({ devicePoll: "delay" });
    const racing = await (await SELF.fetch("https://example.com/admin/device/start", { method: "POST", headers: auth(admin), body: "{}" })).json() as { id: string; nextPollAt: number };
    await new Promise((resolve) => setTimeout(resolve, Math.max(30, racing.nextPollAt - Date.now() + 2)));
    resetMockUpstream();
    configureMockUpstream({ devicePoll: "delay" });
    const pollBody = { method: "POST", headers: auth(admin), body: JSON.stringify({ login_id: racing.id }) };
    const firstPoll = SELF.fetch("https://example.com/admin/device/poll", pollBody);
    const secondPoll = SELF.fetch("https://example.com/admin/device/poll", pollBody);
    const [firstResult, secondResult] = await Promise.all([firstPoll, secondPoll]);
    expect(firstResult.status).toBe(200);
    expect(secondResult.status).toBe(200);
    expect(mockUpstreamStats().devicePoll).toBe(1);

    await SELF.fetch("https://example.com/admin/disconnect", { method: "POST", headers: auth(admin), body: "{}" });
    configureMockUpstream({ devicePoll: "normal", persistDelayMs: 75 });
    const cancelledRace = await (await SELF.fetch("https://example.com/admin/device/start", { method: "POST", headers: auth(admin), body: "{}" })).json() as { id: string; nextPollAt: number };
    await new Promise((resolve) => setTimeout(resolve, Math.max(30, cancelledRace.nextPollAt - Date.now() + 2)));
    const latePoll = SELF.fetch("https://example.com/admin/device/poll", { method: "POST", headers: auth(admin), body: JSON.stringify({ login_id: cancelledRace.id }) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await SELF.fetch("https://example.com/admin/device/cancel", { method: "POST", headers: auth(admin), body: JSON.stringify({ login_id: cancelledRace.id }) });
    expect((await latePoll).status).toBe(409);
    const finalStatus = await (await SELF.fetch("https://example.com/admin/status", { headers: auth(admin) })).json() as { connected: boolean; login: { status: string } };
    expect(finalStatus.connected).toBe(false);
    expect(finalStatus.login.status).toBe("cancelled");
  });

  it("does not revive login state across start and poll commit barriers", async () => {
    configureMockUpstream({ loginStateDelayMs: 75 });
    const lateStart = SELF.fetch("https://example.com/admin/device/start", { method: "POST", headers: auth(admin), body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await SELF.fetch("https://example.com/admin/disconnect", { method: "POST", headers: auth(admin), body: "{}" });
    expect((await lateStart).status).toBe(409);
    const afterStartDisconnect = await (await SELF.fetch("https://example.com/admin/status", { headers: auth(admin) })).json() as { connected: boolean; login: unknown };
    expect(afterStartDisconnect).toMatchObject({ connected: false, login: null });

    resetMockUpstream();
    const started = await (await SELF.fetch("https://example.com/admin/device/start", { method: "POST", headers: auth(admin), body: "{}" })).json() as { id: string; nextPollAt: number };
    await new Promise((resolve) => setTimeout(resolve, Math.max(30, started.nextPollAt - Date.now() + 2)));
    configureMockUpstream({ devicePoll: "pending", loginStateDelayMs: 75 });
    const lateWaiting = SELF.fetch("https://example.com/admin/device/poll", { method: "POST", headers: auth(admin), body: JSON.stringify({ login_id: started.id }) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await SELF.fetch("https://example.com/admin/device/cancel", { method: "POST", headers: auth(admin), body: JSON.stringify({ login_id: started.id }) });
    expect((await lateWaiting).status).toBe(409);
    const afterPollCancel = await (await SELF.fetch("https://example.com/admin/status", { headers: auth(admin) })).json() as { connected: boolean; login: { status: string } };
    expect(afterPollCancel.connected).toBe(false);
    expect(afterPollCancel.login.status).toBe("cancelled");
  });

  it("single-flights refresh and disables credentials after an uncertain refresh result", async () => {
    await connect();
    await expireCredentials();
    resetMockUpstream();
    configureMockUpstream({ refresh: "delay" });
    const [first, second] = await Promise.all([
      SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) }),
      SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) })
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockUpstreamStats().refresh).toBe(1);

    await expireCredentials();
    resetMockUpstream();
    configureMockUpstream({ refresh: "network" });
    const uncertain = await SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) });
    expect(uncertain.status).toBe(503);
    expect((await uncertain.json() as { error: { code: string } }).error.code).toBe("refresh_result_uncertain");
    const status = await (await SELF.fetch("https://example.com/admin/status", { headers: auth(admin) })).json() as { connected: boolean; reauthenticationRequired: boolean; reauthenticationReason: string };
    expect(status).toMatchObject({ connected: false, reauthenticationRequired: true, reauthenticationReason: "refresh_result_uncertain" });
    await SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) });
    expect(mockUpstreamStats().refresh).toBe(1);

    await connect();
    await expireCredentials();
    resetMockUpstream();
    configureMockUpstream({ refresh: "invalid_grant" });
    const invalidGrant = await SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) });
    expect(invalidGrant.status).toBe(503);
    expect((await invalidGrant.json() as { error: { code: string } }).error.code).toBe("account_reauthentication_required");

    await connect();
    await expireCredentials();
    resetMockUpstream();
    configureMockUpstream({ refresh: "normal", persistDelayMs: 75 });
    const lateRefresh = SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await SELF.fetch("https://example.com/admin/disconnect", { method: "POST", headers: auth(admin), body: "{}" });
    expect((await lateRefresh).status).toBe(409);
    const disconnected = await (await SELF.fetch("https://example.com/admin/status", { headers: auth(admin) })).json() as { connected: boolean; reauthenticationRequired: boolean };
    expect(disconnected).toMatchObject({ connected: false, reauthenticationRequired: false });
  });

  it("survives DO eviction and fails closed on encrypted credential corruption", async () => {
    await connect();
    await abortAllDurableObjects();
    const restored = await (await SELF.fetch("https://example.com/admin/status", { headers: auth(admin) })).json() as { connected: boolean };
    expect(restored.connected).toBe(true);
    await runInDurableObject(accountStub(), async (_instance, state) => {
      const stored = await state.storage.get<{ ciphertext: string }>("credentials");
      await state.storage.put("credentials", { ...stored, ciphertext: `${stored!.ciphertext.slice(0, -2)}AA` });
    });
    const corrupt = await SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) });
    expect(corrupt.status).toBe(503);
    expect((await corrupt.json() as { error: { code: string } }).error.code).toBe("credential_decryption_failed");
  });

  it("clears orphaned stream leases when the Durable Object is rebuilt", async () => {
    await connect();
    await runInDurableObject(accountStub(), async (_instance, state) => {
      await state.storage.put("leases", { orphanOne: Date.now() + 300_000, orphanTwo: Date.now() + 300_000 });
    });
    await abortAllDurableObjects();
    const recovered = await Promise.all([
      SELF.fetch("https://example.com/v1/responses", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", input: "one" }) }),
      SELF.fetch("https://example.com/v1/responses", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", input: "two" }) })
    ]);
    expect(recovered.map((response) => response.status)).toEqual([200, 200]);
  });

  it("maps upstream HTTP, redirects, malformed terminal streams and timeouts without false success", async () => {
    await connect();
    resetMockUpstream();
    const rejected = await SELF.fetch("https://example.com/v1/responses", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", input: "mock:http401" }) });
    expect(rejected.status).toBe(503);
    expect((await rejected.json() as { error: { code: string } }).error.code).toBe("account_reauthentication_required");
    const rejectedStatus = await (await SELF.fetch("https://example.com/admin/status", { headers: auth(admin) })).json() as { connected: boolean; reauthenticationReason: string };
    expect(rejectedStatus).toMatchObject({ connected: false, reauthenticationReason: "refreshed_token_rejected" });
    expect(mockUpstreamStats().refresh).toBe(1);
    await SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) });
    expect(mockUpstreamStats().refresh).toBe(1);
    await connect();
    const cases = [
      ["mock:http403", 403, "upstream_http_403"],
      ["mock:http429", 429, "upstream_rate_limited"],
      ["mock:http500", 502, "upstream_error"],
      ["mock:redirect", 502, "upstream_redirect_rejected"],
      ["mock:invalid-event", 502, "invalid_upstream_event"],
      ["mock:invalid-utf8", 502, "invalid_upstream_stream"],
      ["mock:truncated", 502, "upstream_stream_truncated"],
      ["mock:failed", 502, "upstream_generation_failed"],
      ["mock:header-timeout", 504, "generation_timeout"]
    ] as const;
    for (const [input, status, code] of cases) {
      const response = await SELF.fetch("https://example.com/v1/responses", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", input }) });
      expect(response.status, input).toBe(status);
      expect((await response.json() as { error: { code: string } }).error.code, input).toBe(code);
    }
    configureMockUpstream({ models: "slow_body" });
    const slowModels = await SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) });
    expect(slowModels.status).toBe(504);
    resetMockUpstream();
    configureMockUpstream({ models: "challenge" });
    const challengedModels = await SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) });
    expect(challengedModels.status).toBe(403);
    const gatewayChallenge = await challengedModels.json() as { error: { code: string; diagnostic?: unknown } };
    expect(gatewayChallenge.error.code).toBe("upstream_edge_challenge");
    expect(gatewayChallenge.error).not.toHaveProperty("diagnostic");
    const adminChallenge = await SELF.fetch("https://example.com/admin/test/models", { headers: auth(admin) });
    const adminChallengeBody = await adminChallenge.json() as { error: { diagnostic: Record<string, unknown> } };
    expect(adminChallenge.status).toBe(403);
    expect(adminChallengeBody.error.diagnostic).toMatchObject({
      upstreamHostname: "chatgpt.com",
      upstreamPath: "/backend-api/codex/models",
      status: 403,
      server: "cloudflare",
      cfRay: "mockray-SIN",
      cfMitigated: "challenge",
      errorCategory: "cloudflare_challenge",
      bodyBytes: expect.any(Number),
      bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      bodyFormat: "html_text"
    });
    expect(JSON.stringify(adminChallengeBody)).not.toContain("SECRET_BODY_MUST_NOT_APPEAR");
    resetMockUpstream();
    configureMockUpstream({ models: "oversized_error" });
    const oversizedError = await SELF.fetch("https://example.com/v1/models", { headers: auth(gateway) });
    expect(oversizedError.status).toBe(403);
    expect((await oversizedError.json() as { error: { code: string } }).error.code).toBe("upstream_http_403");
  });

  it("rejects oversized bodies, Chat message.name and missing function outputs locally", async () => {
    await connect();
    const oversized = await SELF.fetch("https://example.com/v1/responses", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", input: "x".repeat(1024 * 1024) }) });
    expect(oversized.status).toBe(413);
    const named = await SELF.fetch("https://example.com/v1/chat/completions", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", messages: [{ role: "user", content: "x", name: "alice" }] }) });
    expect(named.status).toBe(400);
    expect((await named.json() as { error: { param: string } }).error.param).toBe("messages[0].name");
    const missingOutput = await SELF.fetch("https://example.com/v1/responses", { method: "POST", headers: auth(gateway), body: JSON.stringify({ model: "gpt-mock", input: [{ type: "function_call_output", call_id: "call_x" }] }) });
    expect(missingOutput.status).toBe(400);
    expect((await missingOutput.json() as { error: { param: string } }).error.param).toBe("input[0].output");
  });
});
