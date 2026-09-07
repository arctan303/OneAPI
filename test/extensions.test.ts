import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { configureMockUpstream, mockUpstreamStats, resetMockUpstream } from "../src/codex/mock";
import { StreamBodyCapture } from "../src/observability";
import { normalizeUsagePayload } from "../src/usage";
import type { StoredApiKey } from "../src/types";

const origin = "https://example.com";
const admin = "mock-admin-key-for-tests-only-00000001";
const legacy = "mock-gateway-key-for-tests-only-0001";
const auth = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });
const accountStub = () => {
  const testEnv = env as unknown as import("../src/types").Env;
  return testEnv.ACCOUNT.get(testEnv.ACCOUNT.idFromName("primary"));
};

async function connect(): Promise<void> {
  const started = await SELF.fetch(`${origin}/admin/device/start`, { method: "POST", headers: auth(admin), body: "{}" });
  expect(started.status).toBe(200);
  const state = await started.json() as { id: string; nextPollAt: number };
  await new Promise((resolve) => setTimeout(resolve, Math.max(30, state.nextPollAt - Date.now() + 2)));
  const completed = await SELF.fetch(`${origin}/admin/device/poll`, {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify({ login_id: state.id })
  });
  expect(completed.status).toBe(200);
}

async function createKey(name: string, policy: Record<string, unknown> = {}): Promise<{ id: string; key: string }> {
  const response = await SELF.fetch(`${origin}/admin/api-keys`, {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify({ name, ...policy })
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; key: string }>;
}

async function patchKey(id: string, patch: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${origin}/admin/api-keys/${id}`, {
    method: "PATCH",
    headers: auth(admin),
    body: JSON.stringify(patch)
  });
}

async function generate(key: string, input: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return SELF.fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: auth(key),
    body: JSON.stringify({ model: "gpt-mock", input, ...extra })
  });
}

async function logs(keyId?: string): Promise<{ data: Array<Record<string, unknown>> }> {
  const query = keyId ? `?keyId=${encodeURIComponent(keyId)}` : "";
  return (await SELF.fetch(`${origin}/admin/logs${query}`, { headers: auth(admin) })).json() as Promise<{ data: Array<Record<string, unknown>> }>;
}

describe("Phase-01 account usage, per-key controls, and request logs", () => {
  beforeEach(async () => {
    resetMockUpstream();
    await SELF.fetch(`${origin}/admin/disconnect`, { method: "POST", headers: auth(admin), body: "{}" });
    await runInDurableObject(accountStub(), async (_instance, state) => {
      await state.storage.delete(["api-keys", "legacy-key-policy", "api-key-rate-windows", "log-settings", "usage-cache", "model-capabilities"]);
      await state.storage.deleteAlarm();
      state.storage.sql.exec("DELETE FROM request_logs");
    });
  });

  it("shows real account claims and classifies cached official usage by duration rather than position", async () => {
    await connect();
    const status = await (await SELF.fetch(`${origin}/admin/status`, { headers: auth(admin) })).json() as {
      account: Record<string, unknown>;
    };
    expect(status.account).toMatchObject({
      id: "acct_mock",
      idHint: "…t_mock",
      email: "mock@example.com",
      plan: "mock"
    });
    expect(typeof status.account.tokenExpiresAt).toBe("number");
    expect(typeof status.account.lastRefreshAt).toBe("number");

    const first = await (await SELF.fetch(`${origin}/admin/usage`, { headers: auth(admin) })).json() as any;
    expect(first).toMatchObject({
      available: true,
      windows: {
        fiveHour: { usedPercent: 40, remainingPercent: 60, windowDurationMins: 300, resetsAt: 2000003600000 },
        sevenDay: { usedPercent: 25, remainingPercent: 75, windowDurationMins: 10080, resetsAt: 2000007200000 }
      },
      additional: [{ limitId: "gpt-mock-special", label: "Mock special", windowDurationMins: 60 }]
    });
    expect(mockUpstreamStats().usageRequests).toBe(1);
    expect((await SELF.fetch(`${origin}/admin/usage`, { headers: auth(admin) })).status).toBe(200);
    expect(mockUpstreamStats().usageRequests).toBe(1);
    const refreshed = await (await SELF.fetch(`${origin}/admin/usage?refresh=true`, { headers: auth(admin) })).json() as any;
    expect(refreshed.available).toBe(true);
    expect(mockUpstreamStats().usageRequests).toBe(2);
    configureMockUpstream({ usage: "network" });
    const unavailable = await (await SELF.fetch(`${origin}/admin/usage?refresh=true`, { headers: auth(admin) })).json() as any;
    expect(unavailable).toMatchObject({
      available: false,
      lastSuccessAt: refreshed.lastSuccessAt,
      windows: { fiveHour: null, sevenDay: null }
    });

    configureMockUpstream({ usage: "challenge" });
    const rejectedUsage = await (await SELF.fetch(`${origin}/admin/usage?refresh=true`, { headers: auth(admin) })).json() as any;
    expect(rejectedUsage.error).toMatchObject({
      code: "upstream_http_403",
      diagnostic: {
        upstreamHostname: "chatgpt.com",
        upstreamPath: "/backend-api/wham/usage",
        status: 403,
        server: "cloudflare",
        cfRay: "usage-mockray-SIN",
        cfErrorCode: "1020",
        bodyMarker: "cloudflare_blocked",
        errorCategory: "cloudflare_attention_required",
        bodyBytes: expect.any(Number),
        bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        bodyFormat: "html_text"
      }
    });
    expect(JSON.stringify(rejectedUsage)).not.toContain("SECRET_USAGE_BODY");

    await SELF.fetch(`${origin}/admin/disconnect`, { method: "POST", headers: auth(admin), body: "{}" });
    const disconnected = await (await SELF.fetch(`${origin}/admin/usage`, { headers: auth(admin) })).json() as any;
    expect(disconnected).toMatchObject({ available: false, lastSuccessAt: null, windows: { fiveHour: null, sevenDay: null } });
  });

  it("does not cache an in-flight usage response after disconnect changes the account generation", async () => {
    await connect();
    configureMockUpstream({ usage: "delay" });
    const pending = SELF.fetch(`${origin}/admin/usage?refresh=true`, { headers: auth(admin) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await SELF.fetch(`${origin}/admin/disconnect`, { method: "POST", headers: auth(admin), body: "{}" });
    const result = await (await pending).json() as any;
    expect(result).toMatchObject({ available: false, lastSuccessAt: null });
    await runInDurableObject(accountStub(), async (_instance, state) => {
      expect(await state.storage.get("usage-cache")).toBeUndefined();
    });
  });

  it("keeps additional 5-hour windows separate when the main quota is absent", () => {
    const snapshot = normalizeUsagePayload({
      additional_rate_limits: [{
        metered_feature: "special",
        limit_name: "Special model",
        rate_limit: {
          primary_window: { used_percent: 12, limit_window_seconds: 5 * 60 * 60, reset_at: 2000000000 }
        }
      }]
    }, 1234);
    expect(snapshot.windows).toEqual({ fiveHour: null, sevenDay: null });
    expect(snapshot.additional).toMatchObject([{ limitId: "special", label: "Special model", windowDurationMins: 300 }]);
  });

  it("filters models and rejects disallowed, disabled, expired, and legacy-key requests before upstream", async () => {
    await connect();
    const key = await createKey("restricted", {
      modelAccess: { mode: "allowlist", models: ["gpt-other"] }
    });
    const models = await (await SELF.fetch(`${origin}/v1/models`, { headers: auth(key.key) })).json() as { data: unknown[] };
    expect(models.data).toEqual([]);
    const afterModels = mockUpstreamStats().codexRequests;
    const denied = await generate(key.key, "denied");
    expect(denied.status).toBe(403);
    expect((await denied.json() as any).error.code).toBe("model_not_allowed");
    expect(mockUpstreamStats().codexRequests).toBe(afterModels);
    const deniedLog = (await logs(key.id)).data[0] as any;
    expect(deniedLog).toMatchObject({ keyId: key.id, model: "gpt-mock", httpStatus: 403, outcome: "error" });
    expect(deniedLog.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });

    expect((await patchKey(key.id, { modelAccess: { mode: "allowlist", models: ["gpt-mock"] } })).status).toBe(200);
    expect((await generate(key.key, "allowed")).status).toBe(200);
    const beforeDisabled = mockUpstreamStats().codexRequests;
    expect((await patchKey(key.id, { enabled: false })).status).toBe(200);
    expect((await generate(key.key, "disabled")).status).toBe(401);
    expect(mockUpstreamStats().codexRequests).toBe(beforeDisabled);

    await runInDurableObject(accountStub(), async (_instance, state) => {
      const keys = (await state.storage.get<StoredApiKey[]>("api-keys"))!;
      await state.storage.put("api-keys", keys.map((stored) => stored.id === key.id ? { ...stored, enabled: true, expiresAt: Date.now() - 1 } : stored));
    });
    expect((await generate(key.key, "expired")).status).toBe(401);
    expect(mockUpstreamStats().codexRequests).toBe(beforeDisabled);

    expect((await patchKey("legacy", { modelAccess: { mode: "allowlist", models: ["gpt-other"] } })).status).toBe(200);
    const legacyDenied = await generate(legacy, "legacy denied");
    expect(legacyDenied.status).toBe(403);
    expect(mockUpstreamStats().codexRequests).toBe(beforeDisabled);
  });

  it("exposes account catalog reasoning metadata with key filtering and safe default semantics", async () => {
    await connect();
    const key = await createKey("reasoning catalog", {
      modelAccess: { mode: "allowlist", models: ["gpt-mock"] }
    });
    const adminModels = await (await SELF.fetch(origin + "/admin/test/models", { headers: auth(admin) })).json() as any;
    expect(adminModels.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "gpt-mock",
        capabilities: { reasoning: { supported_efforts: ["none", "low", "medium", "high", "max"], default_effort: "low" } }
      }),
      expect.objectContaining({
        id: "gpt-empty",
        capabilities: { reasoning: { supported_efforts: [], default_effort: null } }
      }),
      expect.objectContaining({
        id: "gpt-unknown",
        capabilities: { reasoning: { supported_efforts: null, default_effort: null } }
      })
    ]));
    const keyModels = await (await SELF.fetch(origin + "/v1/models?client_version=0.153.4", { headers: auth(key.key) })).json() as any;
    expect(keyModels.data).toHaveLength(1);
    expect(keyModels.data[0]).toMatchObject({
      id: "gpt-mock",
      object: "model",
      created: 0,
      owned_by: "openai",
      capabilities: { reasoning: { supported_efforts: ["none", "low", "medium", "high", "max"], default_effort: "low" } }
    });
    expect(keyModels.data.map((model: { id: string }) => model.id)).toEqual(["gpt-mock"]);
    expect(keyModels.models.map((model: { slug: string }) => model.slug)).toEqual(["gpt-mock"]);
    expect(JSON.stringify(keyModels)).not.toContain("gpt-hidden");

    configureMockUpstream({ models: "invalid_models" });
    const invalid = await SELF.fetch(origin + "/admin/test/models", { headers: auth(admin) });
    expect(invalid.status).toBe(502);
    expect((await invalid.json() as any).error.code).toBe("invalid_models_response");
  });

  it("keeps subscription-listed models independent of Platform API support while preserving key scope", async () => {
    await connect();
    configureMockUpstream({ models: "subscription_catalog" });
    const key = await createKey("subscription preview", {
      modelAccess: { mode: "allowlist", models: ["gpt-subscription-preview"] }
    });

    const adminModels = await (await SELF.fetch(origin + "/admin/test/models", { headers: auth(admin) })).json() as any;
    expect(adminModels.data).toEqual([expect.objectContaining({
      id: "gpt-subscription-preview",
      capabilities: {
        reasoning: {
          supported_efforts: ["low", "medium", "high", "xhigh"],
          default_effort: "medium"
        }
      }
    })]);

    const keyModels = await (await SELF.fetch(origin + "/v1/models", { headers: auth(key.key) })).json() as any;
    expect(keyModels.data.map((model: { id: string }) => model.id)).toEqual(["gpt-subscription-preview"]);
    const generated = await SELF.fetch(origin + "/v1/responses", {
      method: "POST",
      headers: auth(key.key),
      body: JSON.stringify({ model: "gpt-subscription-preview", input: "preview", reasoning: { effort: "xhigh" } })
    });
    expect(generated.status).toBe(200);
    expect(mockUpstreamStats().lastReasoningEffort).toBe("xhigh");

    const beforeDenied = mockUpstreamStats().codexRequests;
    const denied = await SELF.fetch(origin + "/v1/responses", {
      method: "POST",
      headers: auth(key.key),
      body: JSON.stringify({ model: "gpt-hidden-preview", input: "denied" })
    });
    expect(denied.status).toBe(403);
    expect((await denied.json() as any).error.code).toBe("model_not_allowed");
    expect(mockUpstreamStats().codexRequests).toBe(beforeDenied);
  });

  it("auto-loads reasoning capabilities once and validates and forwards both protocols exactly", async () => {
    await connect();
    const key = await createKey("reasoning generation");
    await runInDurableObject(accountStub(), async (_instance, state) => {
      await state.storage.put("model-capabilities", [{ id: "gpt-mock", reasoningEfforts: ["high"] }]);
    });
    configureMockUpstream({ models: "delay" });
    const [first, concurrent] = await Promise.all([
      generate(key.key, "first reasoning", { reasoning: { effort: "none" } }),
      generate(key.key, "concurrent reasoning", { reasoning: { effort: "max" } })
    ]);
    expect(first.status).toBe(200);
    expect(concurrent.status).toBe(200);
    expect(mockUpstreamStats().modelRequests).toBe(1);

    await runInDurableObject(accountStub(), async (_instance, state) => {
      const cached = await state.storage.get<any>("model-capabilities");
      await state.storage.put("model-capabilities", { ...cached, fetchedAt: Date.now() - 5 * 60 * 1000 - 1 });
    });
    configureMockUpstream({ models: "normal" });
    expect((await generate(key.key, "expired capability cache", { reasoning: { effort: "high" } })).status).toBe(200);
    expect(mockUpstreamStats().modelRequests).toBe(2);
    await runInDurableObject(accountStub(), async (_instance, state) => {
      const cached = await state.storage.get<any>("model-capabilities");
      await state.storage.put("model-capabilities", { ...cached, fetchedAt: Date.now() + 60_000 });
    });
    expect((await generate(key.key, "future capability cache", { reasoning: { effort: "low" } })).status).toBe(200);
    expect(mockUpstreamStats().modelRequests).toBe(3);

    const responseReasoning = await generate(key.key, "responses reasoning", { reasoning: { effort: "none" } });
    expect(responseReasoning.status).toBe(200);
    expect(mockUpstreamStats()).toMatchObject({
      modelRequests: 3,
      lastReasoningPresent: true,
      lastReasoningEffort: "none",
      lastReasoningSummary: "auto"
    });

    const chatReasoning = await SELF.fetch(origin + "/v1/chat/completions", {
      method: "POST",
      headers: auth(key.key),
      body: JSON.stringify({
        model: "gpt-mock",
        messages: [{ role: "user", content: "chat reasoning" }],
        reasoning_effort: "max"
      })
    });
    expect(chatReasoning.status).toBe(200);
    expect(mockUpstreamStats()).toMatchObject({ lastReasoningPresent: true, lastReasoningEffort: "max", lastReasoningSummary: "auto" });

    const beforeUnsupported = mockUpstreamStats().codexRequests;
    const unsupported = await generate(key.key, "unsupported reasoning", { reasoning: { effort: "ultra" } });
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json() as any).error).toMatchObject({ code: "unsupported_reasoning_effort", param: "reasoning.effort" });
    expect(mockUpstreamStats().codexRequests).toBe(beforeUnsupported);

    const unsupportedChat = await SELF.fetch(origin + "/v1/chat/completions", {
      method: "POST",
      headers: auth(key.key),
      body: JSON.stringify({ model: "gpt-mock", messages: [{ role: "user", content: "bad chat effort" }], reasoning_effort: "ultra" })
    });
    expect(unsupportedChat.status).toBe(400);
    expect((await unsupportedChat.json() as any).error.param).toBe("reasoning_effort");

    for (const model of ["gpt-empty", "gpt-unknown"]) {
      const denied = await SELF.fetch(origin + "/v1/responses", {
        method: "POST",
        headers: auth(key.key),
        body: JSON.stringify({ model, input: "unconfirmed", reasoning: { effort: "low" } })
      });
      expect(denied.status).toBe(400);
    }

    const withoutEffort = await generate(key.key, "catalog default");
    expect(withoutEffort.status).toBe(200);
    expect(mockUpstreamStats().lastReasoningPresent).toBe(false);
    expect(mockUpstreamStats().modelRequests).toBe(3);
  });

  it("does not write a late reasoning catalog result after account disconnect", async () => {
    await connect();
    const key = await createKey("late reasoning catalog");
    configureMockUpstream({ models: "late" });
    const pending = generate(key.key, "late catalog", { reasoning: { effort: "high" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await SELF.fetch(origin + "/admin/disconnect", {
      method: "POST",
      headers: auth(admin),
      body: "{}"
    })).status).toBe(204);
    expect((await pending).status).not.toBe(200);
    await runInDurableObject(accountStub(), async (_instance, state) => {
      expect(await state.storage.get("model-capabilities")).toBeUndefined();
    });
  });

  it("enforces per-key rate and concurrency limits atomically and releases cancellation slots", async () => {
    await connect();
    const rateKey = await createKey("one per minute", { rateLimitPerMinute: 1 });
    const beforeRate = mockUpstreamStats().codexRequests;
    expect((await generate(rateKey.key, "first")).status).toBe(200);
    const limited = await generate(rateKey.key, "second");
    expect(limited.status).toBe(429);
    expect((await limited.json() as any).error.code).toBe("api_key_rate_limit");
    expect(mockUpstreamStats().codexRequests - beforeRate).toBe(1);
    await runInDurableObject(accountStub(), async (_instance, state) => {
      const windows = await state.storage.get<Record<string, { windowStart: number; count: number }>>("api-key-rate-windows");
      expect(windows?.[rateKey.id]).toMatchObject({ count: 1 });
      expect(Array.isArray(windows?.[rateKey.id])).toBe(false);
      expect(JSON.stringify(windows).length).toBeLessThan(4096);
    });
    expect((await SELF.fetch(`${origin}/admin/api-keys/${rateKey.id}`, {
      method: "DELETE",
      headers: auth(admin),
      body: "{}"
    })).status).toBe(204);
    await runInDurableObject(accountStub(), async (_instance, state) => {
      const windows = await state.storage.get<Record<string, unknown>>("api-key-rate-windows");
      expect(windows?.[rateKey.id]).toBeUndefined();
    });

    const concurrent = await createKey("single concurrency", { concurrencyLimit: 1 });
    const testEnv = env as unknown as import("../src/types").Env;
    const stub = accountStub();
    const directGenerate = (input: string, stream: boolean) => stub.fetch(new Request(`${origin}/v1/responses`, {
      method: "POST",
      headers: auth(concurrent.key),
      body: JSON.stringify({ model: "gpt-mock", input, stream })
    }));
    const first = await directGenerate("slow", true);
    expect(first.status).toBe(200);
    const leaseId = first.headers.get("X-OneAPI-Internal-Lease");
    expect(leaseId).toBeTruthy();
    const second = await directGenerate("second slow", true);
    expect(second.status).toBe(429);
    expect((await second.json() as any).error.code).toBe("api_key_concurrency_limit");
    const cancelled = await stub.fetch(new Request(`${origin}/__internal/cancel?lease_id=${encodeURIComponent(leaseId!)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testEnv.TOKEN_ENCRYPTION_KEY}` }
    }));
    expect(cancelled.status).toBe(204);
    const afterCancellation = await directGenerate("after cancellation", false);
    expect(afterCancellation.status).toBe(200);
    await afterCancellation.body?.cancel();
    const outcomes = (await logs(concurrent.id)).data.map((entry: any) => entry.outcome);
    expect(outcomes).toContain("cancelled");
  });

  it("keeps account disconnect distinct from client cancellation during non-streaming collection", async () => {
    await connect();
    const key = await createKey("disconnect classification");
    const pending = generate(key.key, "slow disconnect", { stream: false });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await SELF.fetch(`${origin}/admin/disconnect`, {
      method: "POST",
      headers: auth(admin),
      body: "{}"
    })).status).toBe(204);
    const response = await pending;
    expect(response.status).toBe(503);
    expect((await response.json() as any).error.code).toBe("account_disconnected");
    const entry = (await logs(key.id)).data[0] as any;
    expect(entry).toMatchObject({ outcome: "error", httpStatus: 503 });
  });

  it("validates and reports compatibility-only generation parameters without forwarding them", async () => {
    await connect();
    const key = await createKey("compat audit");
    const responseTool = {
      type: "function", name: "get_weather", description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
    };
    const chatTool = { type: "function", function: { name: "get_weather", description: "Get weather", parameters: responseTool.parameters } };
    const invoke = async (path: string, body: Record<string, unknown>, expected: string[]) => {
      const before = mockUpstreamStats().generationRequests;
      const response = await SELF.fetch(`${origin}${path}`, {
        method: "POST", headers: auth(key.key), body: JSON.stringify(body)
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("X-OneAPI-Ignored-Parameters")).toBe(expected.join(", "));
      const text = await response.text();
      expect(text).toContain("get_weather");
      const stats = mockUpstreamStats();
      expect(stats.generationRequests).toBe(before + 1);
      expect(stats.lastGenerationBodyKeys).not.toEqual(expect.arrayContaining([
        "max_completion_tokens", "max_tokens", "max_output_tokens", "temperature", "top_p"
      ]));
      return text;
    };

    const responsesBase = { model: "gpt-mock", input: "call_tool weather", tools: [responseTool] };
    const chatBase = { model: "gpt-mock", messages: [{ role: "user", content: "call_tool weather" }], tools: [chatTool] };
    expect(await invoke("/v1/responses", {
      ...responsesBase, stream: false, max_output_tokens: 128, temperature: 0.2, top_p: 0.9
    }, ["max_output_tokens", "temperature", "top_p"])).toContain('"total_tokens":12');
    expect(await invoke("/v1/responses", {
      ...responsesBase, service_tier: "priority", future_option: true
    }, ["service_tier", "future_option"])).toContain('"total_tokens":12');
    expect(await invoke("/v1/responses", {
      ...responsesBase, stream: true, max_output_tokens: 64
    }, ["max_output_tokens"])).toContain("response.completed");
    expect(await invoke("/v1/chat/completions", {
      ...chatBase, stream: false, max_completion_tokens: 128, max_tokens: 256, temperature: 0, top_p: 1
    }, ["max_completion_tokens", "max_tokens", "temperature", "top_p"])).toContain('"total_tokens":12');
    expect(await invoke("/v1/chat/completions", {
      ...chatBase, stream: true, stream_options: { include_usage: true }, max_completion_tokens: 64
    }, ["max_completion_tokens"])).toContain("[DONE]");
    expect(await invoke("/v1/chat/completions", {
      ...chatBase, max_output_tokens: 10
    }, ["max_output_tokens"])).toContain('"total_tokens":12');

    const nullResponse = await SELF.fetch(`${origin}/v1/chat/completions`, {
      method: "POST", headers: auth(key.key),
      body: JSON.stringify({ ...chatBase, max_completion_tokens: null, max_tokens: null, temperature: null, top_p: null })
    });
    expect(nullResponse.status).toBe(200);
    expect(nullResponse.headers.has("X-OneAPI-Ignored-Parameters")).toBe(false);
    await nullResponse.text();

    const entries = (await logs(key.id)).data as any[];
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ protocol: "responses", ignoredParameters: ["max_output_tokens", "temperature", "top_p"], bodyCaptured: false }),
      expect.objectContaining({ protocol: "responses", ignoredParameters: ["max_output_tokens"], bodyCaptured: false }),
      expect.objectContaining({ protocol: "chat", ignoredParameters: ["max_completion_tokens", "max_tokens", "temperature", "top_p"], bodyCaptured: false }),
      expect.objectContaining({ protocol: "chat", ignoredParameters: ["max_completion_tokens"], bodyCaptured: false }),
      expect.objectContaining({ protocol: "chat", ignoredParameters: [], bodyCaptured: false })
    ]));
    for (const entry of entries) {
      const detail = await (await SELF.fetch(`${origin}/admin/logs/${entry.id}`, { headers: auth(admin) })).json() as any;
      expect(detail.ignoredParameters).toEqual(entry.ignoredParameters);
      expect(detail.requestBody).toBeNull();
    }

    const generationBeforeInvalid = mockUpstreamStats().generationRequests;
    for (const [path, body, param] of [
      ["/v1/responses", { ...responsesBase, max_output_tokens: 0 }, "max_output_tokens"],
      ["/v1/responses", { ...responsesBase, max_output_tokens: 1.5 }, "max_output_tokens"],
      ["/v1/responses", { ...responsesBase, temperature: -0.1 }, "temperature"],
      ["/v1/responses", { ...responsesBase, top_p: 1.1 }, "top_p"],
      ["/v1/chat/completions", { ...chatBase, max_tokens: "128" }, "max_tokens"],
      ["/v1/chat/completions", { ...chatBase, max_completion_tokens: 0 }, "max_completion_tokens"],
    ] as const) {
      const response = await SELF.fetch(`${origin}${path}`, { method: "POST", headers: auth(key.key), body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      expect((await response.json() as any).error.param).toBe(param);
    }
    expect(mockUpstreamStats().generationRequests).toBe(generationBeforeInvalid);

    expect((await patchKey(key.id, { modelAccess: { mode: "allowlist", models: ["gpt-other"] } })).status).toBe(200);
    const denied = await generate(key.key, "denied after log start", { max_output_tokens: 32 });
    expect(denied.status).toBe(403);
    expect(((await logs(key.id)).data[0] as any)).toMatchObject({
      outcome: "error", ignoredParameters: ["max_output_tokens"], bodyCaptured: false
    });
  });
  it("keeps summary logs by default, preserves unknown usage, and keeps revoked-key history", async () => {
    await connect();
    const key = await createKey("audited");
    expect((await generate(key.key, "normal")).status).toBe(200);
    expect((await generate(key.key, "mock:no-usage")).status).toBe(200);
    const list = await logs(key.id);
    expect(list.data).toHaveLength(2);
    expect((list.data[0] as any).usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect((list.data[1] as any).usage).toEqual({ inputTokens: 4, outputTokens: 3, totalTokens: 7 });
    expect(list.data.every((entry: any) => entry.bodyCaptured === false)).toBe(true);

    const deleted = await SELF.fetch(`${origin}/admin/api-keys/${key.id}`, {
      method: "DELETE",
      headers: auth(admin),
      body: "{}"
    });
    expect(deleted.status).toBe(204);
    const afterDelete = await logs(key.id);
    expect(afterDelete.data).toHaveLength(2);
    expect(afterDelete.data.every((entry: any) => entry.keyName === "audited")).toBe(true);

    const beforeInvalid = (await logs()).data.length;
    expect((await generate("random-invalid-secret", "never logged")).status).toBe(401);
    expect((await logs()).data.length).toBe(beforeInvalid);
  });

  it("records Chat streaming usage and preserves HTTP 200 when a streamed protocol error follows headers", async () => {
    await connect();
    const key = await createKey("chat audit");
    const chat = await SELF.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: auth(key.key),
      body: JSON.stringify({
        model: "gpt-mock",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        stream_options: { include_usage: true }
      })
    });
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain("[DONE]");
    const chatLog = (await logs(key.id)).data[0] as any;
    expect(chatLog).toMatchObject({
      protocol: "chat",
      httpStatus: 200,
      outcome: "completed",
      usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 }
    });

    const broken = await generate(key.key, "mock:invalid-event", { stream: true });
    expect(broken.status).toBe(200);
    expect(await broken.text()).toContain("invalid_upstream_event");
    const brokenLog = (await logs(key.id)).data[0] as any;
    expect(brokenLog).toMatchObject({ protocol: "responses", httpStatus: 200, outcome: "error" });
    expect(brokenLog.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it("captures redacted/truncated bodies, retains actual client SSE, and stores the maximum legal body size in SQLite", async () => {
    await connect();
    const key = await createKey("body audit");
    const defaults = await (await SELF.fetch(`${origin}/admin/log-settings`, { headers: auth(admin) })).json();
    expect(defaults).toEqual({ summaryRetentionDays: 30, bodyRetentionDays: 7, captureBodies: false, maxBodyBytes: 65536 });

    const enabled = await SELF.fetch(`${origin}/admin/log-settings`, {
      method: "PATCH",
      headers: auth(admin),
      body: JSON.stringify({ captureBodies: true, maxBodyBytes: 4096 })
    });
    expect(enabled.status).toBe(200);
    const secret = "oneapi_sk_SUPER_SECRET_MUST_NOT_PERSIST";
    const streamed = await generate(key.key, `Bearer oauth-secret ${secret} ${"x".repeat(10000)}`, { stream: true });
    expect(streamed.status).toBe(200);
    expect(await streamed.text()).toContain("response.output_item.done");
    const firstSummary = (await logs(key.id)).data[0] as any;
    expect(firstSummary).toMatchObject({ bodyCaptured: true, requestTruncated: true, outcome: "completed" });
    const detail = await (await SELF.fetch(`${origin}/admin/logs/${firstSummary.id}`, { headers: auth(admin) })).json() as any;
    expect(JSON.stringify(detail)).not.toContain("oauth-secret");
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(detail.responseBody).toMatchObject({ format: "sse" });
    expect(detail.responseBody.content).toContain("response.output_item.done");
    expect(detail.responseBody.content).toContain("你好，mock");
    const responseSecretCapture = new StreamBodyCapture(4096, "sse");
    responseSecretCapture.append(new TextEncoder().encode("data: Bearer response-secret oneapi_sk_PARTIAL"));
    expect(JSON.stringify(responseSecretCapture.body())).not.toContain("response-secret");
    expect(JSON.stringify(responseSecretCapture.body())).not.toContain("oneapi_sk_PARTIAL");

    expect((await SELF.fetch(`${origin}/admin/log-settings`, {
      method: "PATCH",
      headers: auth(admin),
      body: JSON.stringify({ maxBodyBytes: 1024 })
    })).status).toBe(200);
    expect(await (await generate(key.key, "response truncation", { stream: true })).text()).toContain("response.completed");
    const truncatedResponseSummary = (await logs(key.id)).data[0] as any;
    expect(truncatedResponseSummary.responseTruncated).toBe(true);
    const truncatedResponseDetail = await (await SELF.fetch(`${origin}/admin/logs/${truncatedResponseSummary.id}`, { headers: auth(admin) })).json() as any;
    expect(truncatedResponseDetail.responseBody).toMatchObject({ format: "sse", truncated: true });

    expect((await SELF.fetch(`${origin}/admin/log-settings`, {
      method: "PATCH",
      headers: auth(admin),
      body: JSON.stringify({ maxBodyBytes: 262144 })
    })).status).toBe(200);
    const largeInput = "z".repeat(150_000);
    expect((await generate(key.key, largeInput, { max_output_tokens: 32 })).status).toBe(200);
    const largeSummary = (await logs(key.id)).data[0] as any;
    expect(largeSummary.requestTruncated).toBe(false);
    expect(largeSummary.ignoredParameters).toEqual(["max_output_tokens"]);
    const largeDetail = await (await SELF.fetch(`${origin}/admin/logs/${largeSummary.id}`, { headers: auth(admin) })).json() as any;
    expect(largeDetail.requestBody.input).toBe(largeInput);

    const forcedExpiry = Date.now() - 1_000;
    await runInDurableObject(accountStub(), async (_instance, state) => {
      state.storage.sql.exec("UPDATE request_logs SET body_expires_at = ? WHERE id = ?", forcedExpiry, largeSummary.id);
    });
    const expired = await (await SELF.fetch(`${origin}/admin/logs/${largeSummary.id}`, { headers: auth(admin) })).json() as any;
    expect(expired).toMatchObject({ bodyCaptured: true, bodyExpired: true, requestBody: null, responseBody: null, bodyExpiresAt: forcedExpiry, ignoredParameters: ["max_output_tokens"] });
  });

  it("schedules alarm cleanup, preserves expiry reasons and bounds completed logs while retaining active rows", async () => {
    await connect();
    const key = await createKey("settings snapshot");
    expect((await SELF.fetch(`${origin}/admin/log-settings`, {
      method: "PATCH",
      headers: auth(admin),
      body: JSON.stringify({ captureBodies: true })
    })).status).toBe(200);
    const inFlight = await generate(key.key, "slow", { stream: true });
    expect((await SELF.fetch(`${origin}/admin/log-settings`, {
      method: "PATCH",
      headers: auth(admin),
      body: JSON.stringify({ captureBodies: false, summaryRetentionDays: 3, bodyRetentionDays: 1 })
    })).status).toBe(200);
    await inFlight.text();
    expect((await generate(key.key, "new summary only")).status).toBe(200);
    const current = await logs(key.id);
    expect((current.data[0] as any).bodyCaptured).toBe(false);
    expect((current.data[1] as any).bodyCaptured).toBe(true);

    const summaryId = (current.data[0] as any).id;
    const bodyId = (current.data[1] as any).id;
    const alarmResult = await runInDurableObject(accountStub(), async (instance, state) => {
      const credentialsBefore = await state.storage.get("credentials");
      const generationBefore = await state.storage.get("generation");
      const scheduledBefore = await state.storage.getAlarm();
      const expiredBodyStartedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
      const expiredSummaryStartedAt = Date.now() - 4 * 24 * 60 * 60 * 1000;
      state.storage.sql.exec("UPDATE request_logs SET started_at = ? WHERE id = ?", expiredBodyStartedAt, bodyId);
      state.storage.sql.exec(
        "UPDATE request_logs SET started_at = ?, completed_at = ? WHERE id = ?",
        expiredSummaryStartedAt,
        expiredSummaryStartedAt,
        summaryId
      );
      await instance.alarm!();
      const body = state.storage.sql.exec<{
        requestBody: string | null;
        responseBody: string | null;
        bodyCaptured: number;
        bodyExpiresAt: number | null;
      }>(
        "SELECT request_body AS requestBody, response_body AS responseBody, body_captured AS bodyCaptured, body_expires_at AS bodyExpiresAt FROM request_logs WHERE id = ?",
        bodyId
      ).toArray()[0];
      const summary = state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM request_logs WHERE id = ?",
        summaryId
      ).toArray()[0];
      return {
        scheduledBefore,
        body,
        summary,
        credentialsPreserved: JSON.stringify(credentialsBefore) === JSON.stringify(await state.storage.get("credentials")),
        generationPreserved: generationBefore === await state.storage.get("generation"),
        scheduledAfter: await state.storage.getAlarm()
      };
    });
    expect(typeof alarmResult.scheduledBefore).toBe("number");
    expect(alarmResult.scheduledBefore).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    expect(alarmResult.body).toMatchObject({ requestBody: null, responseBody: null, bodyCaptured: 1 });
    expect(alarmResult.body.bodyExpiresAt).toBeGreaterThan(0);
    expect(alarmResult.body.bodyExpiresAt).toBeLessThanOrEqual(Date.now());
    expect(alarmResult.summary).toEqual({ total: 0 });
    expect(alarmResult.credentialsPreserved).toBe(true);
    expect(alarmResult.generationPreserved).toBe(true);
    expect(typeof alarmResult.scheduledAfter).toBe("number");

    const expiredDetail = await (await SELF.fetch(`${origin}/admin/logs/${bodyId}`, { headers: auth(admin) })).json() as any;
    expect(expiredDetail).toMatchObject({
      bodyCaptured: true,
      bodyExpired: true,
      requestBody: null,
      responseBody: null,
      bodyExpiresAt: alarmResult.body.bodyExpiresAt
    });

    const capacity = await runInDurableObject(accountStub(), async (instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(`WITH RECURSIVE sequence(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 5002
      ) INSERT INTO request_logs (
        id, request_id, key_id, key_name, protocol, model, started_at, completed_at,
        duration_ms, http_status, outcome, input_tokens, output_tokens, total_tokens,
        body_captured, request_truncated, response_truncated
      ) SELECT
        'capacity-' || n, 'capacity-request-' || n, 'capacity-key', 'capacity',
        'responses', 'gpt-mock', ? - n, ? - n, 0, 200, 'completed',
        NULL, NULL, NULL, 0, 0, 0
      FROM sequence`, now, now);
      state.storage.sql.exec(`INSERT INTO request_logs (
        id, request_id, key_id, key_name, protocol, model, started_at, outcome,
        body_captured, request_truncated, response_truncated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "capacity-active", "capacity-active-request", "capacity-key", "capacity",
      "responses", "gpt-mock", now, "incomplete", 0, 0, 0);
      await instance.alarm!();
      return state.storage.sql.exec<{ total: number; completed: number; active: number }>(
        `SELECT COUNT(*) AS total,
          SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS active
        FROM request_logs`
      ).toArray()[0];
    });
    expect(capacity).toEqual({ total: 5001, completed: 5000, active: 1 });
  });

  it("keeps admin data routes inaccessible to gateway credentials", async () => {
    for (const path of ["/admin/usage", "/admin/log-settings", "/admin/logs", "/admin/api-keys"]) {
      expect((await SELF.fetch(`${origin}${path}`, { headers: auth(legacy) })).status).toBe(401);
    }
  });
});
