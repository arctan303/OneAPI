import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { configureMockUpstream, mockUpstreamStats, resetMockUpstream } from "../src/codex/mock";
import { collectUpstreamDiagnostic, readBoundedErrorCode } from "../src/codex/upstream";
import type { StoredCredentials } from "../src/types";

const admin = "mock-admin-key-for-tests-only-00000001";
const gateway = "mock-gateway-key-for-tests-only-0001";
const auth = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });
const accountStub = () => {
  const testEnv = env as unknown as import("../src/types").Env;
  return testEnv.ACCOUNT.get(testEnv.ACCOUNT.idFromName("primary"));
};

async function expireCredentials(): Promise<void> {
  await runInDurableObject(accountStub(), async (instance) => {
    const account = instance as unknown as {
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
    expect(diagnostic).toEqual({
      event: "codex_upstream_rejected",
      upstreamHostname: "chatgpt.com",
      upstreamPath: "/backend-api/codex/models",
      status: 403,
      contentType: "text/html; charset=UTF-8",
      server: "cloudflare",
      cfRay: "abc123-SIN",
      cfMitigated: "challenge",
      upstreamRequestId: "req_edge_123",
      htmlTitle: "Just a moment...",
      errorCategory: "cloudflare_challenge"
    });
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

  it("rejects unknown and unsupported parameters instead of silently dropping them", async () => {
    await connect();
    for (const body of [
      { model: "gpt-mock", input: "x", temperature: 0.2 },
      { model: "gpt-mock", input: "x", store: true },
      { model: "gpt-mock", input: "x", background: true },
      { model: "gpt-mock", input: "x", previous_response_id: "resp_x" }
    ]) {
      const response = await SELF.fetch("https://example.com/v1/responses", { method: "POST", headers: auth(gateway), body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: { param?: string } }).error.param).toBeTruthy();
    }
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
    expect((await challengedModels.json() as { error: { code: string } }).error.code).toBe("upstream_edge_challenge");
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
