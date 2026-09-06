import { CODEX_BASE_URL, AUTH_BASE_URL } from "./constants";

type MockMode = "normal" | "pending" | "delay" | "late" | "network" | "invalid_grant" | "slow_body" | "challenge" | "oversized_error" | "invalid_models";
interface MockControl { devicePoll: MockMode; refresh: MockMode; models: MockMode; usage: MockMode; persistDelayMs: number; loginStateDelayMs: number }
const control: MockControl = {
  devicePoll: "normal",
  refresh: "normal",
  models: "normal",
  usage: "normal",
  persistDelayMs: 0,
  loginStateDelayMs: 0
};
const stats = {
  devicePoll: 0,
  refresh: 0,
  codexRequests: 0,
  modelRequests: 0,
  usageRequests: 0,
  lastReasoningPresent: false,
  lastReasoningEffort: "",
  lastReasoningSummary: "",
  lastOriginator: "",
  lastUserAgent: "",
  lastVersion: "",
  lastClientVersion: "",
  lastAuthorizationIsBearer: false,
  lastAccountHeaderPresent: false
};

export function configureMockUpstream(next: Partial<typeof control>): void {
  Object.assign(control, next);
}

export function resetMockUpstream(): void {
  control.devicePoll = "normal";
  control.refresh = "normal";
  control.models = "normal";
  control.usage = "normal";
  control.persistDelayMs = 0;
  control.loginStateDelayMs = 0;
  stats.devicePoll = 0;
  stats.refresh = 0;
  stats.codexRequests = 0;
  stats.modelRequests = 0;
  stats.usageRequests = 0;
  stats.lastReasoningPresent = false;
  stats.lastReasoningEffort = "";
  stats.lastReasoningSummary = "";
  stats.lastOriginator = "";
  stats.lastUserAgent = "";
  stats.lastVersion = "";
  stats.lastClientVersion = "";
  stats.lastAuthorizationIsBearer = false;
  stats.lastAccountHeaderPresent = false;
}

export function mockUpstreamStats(): Readonly<typeof stats> {
  return { ...stats };
}

export function mockPersistenceDelayMs(): number {
  return control.persistDelayMs;
}

export function mockLoginStateDelayMs(): number {
  return control.loginStateDelayMs;
}

function recordCodexRequest(request: Request, url: URL): void {
  stats.codexRequests += 1;
  stats.lastOriginator = request.headers.get("originator") ?? "";
  stats.lastUserAgent = request.headers.get("user-agent") ?? "";
  stats.lastVersion = request.headers.get("version") ?? "";
  stats.lastClientVersion = url.searchParams.get("client_version") ?? "";
  stats.lastAuthorizationIsBearer = request.headers.get("authorization")?.startsWith("Bearer ") === true;
  stats.lastAccountHeaderPresent = Boolean(request.headers.get("chatgpt-account-id"));
}

function trackedBody(chunks: Uint8Array[], status: number, headers: Record<string, string>): Response {
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    }
  }), { status, headers });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function delayedJson(value: unknown, signal: AbortSignal): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await delay(250, signal);
        controller.enqueue(bytes);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  }), { headers: { "Content-Type": "application/json" } });
}

function base64Url(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function token(payload: Record<string, unknown>): string {
  return `${base64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64Url(JSON.stringify(payload))}.mock`;
}

function mockTokens(suffix: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const auth = { chatgpt_account_id: "acct_mock", chatgpt_plan_type: "mock" };
  return {
    id_token: token({ exp, email: "mock@example.com", "https://api.openai.com/auth": auth }),
    access_token: token({ exp, scope: "codex" }),
    refresh_token: `mock-refresh-${suffix}`
  };
}

function collectText(value: unknown): string {
  return JSON.stringify(value);
}

function event(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\r\ndata: ${JSON.stringify({ type, ...payload })}\r\n\r\n`;
}

function sseResponse(body: Record<string, unknown>, signal: AbortSignal): Response {
  const id = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const model = String(body.model ?? "gpt-mock");
  const wantsTool = Array.isArray(body.tools) && body.tools.length > 0 && /call_tool|工具|天气/.test(collectText(body.input));
  const output = wantsTool
    ? [{ id: "fc_mock", type: "function_call", call_id: "call_mock_weather", name: "get_weather", arguments: "{\"city\":\"Singapore\"}", status: "completed" }]
    : [{ id: "msg_mock", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "你好，mock", annotations: [] }] }];
  const completed = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    output_text: wantsTool ? "" : "你好，mock",
    ...(/mock:no-usage/.test(collectText(body.input)) ? {} : { usage: { input_tokens: 4, output_tokens: wantsTool ? 8 : 3, total_tokens: wantsTool ? 12 : 7 } })
  };
  const parts: string[] = [event("response.created", { response: { ...completed, status: "in_progress", output: [] } })];
  if (wantsTool) {
    parts.push(event("response.output_item.added", { output_index: 0, item: { id: "fc_mock", type: "function_call", call_id: "call_mock_weather", name: "get_weather", arguments: "", status: "in_progress" } }));
    parts.push(event("response.function_call_arguments.delta", { item_id: "fc_mock", output_index: 0, delta: "{\"city\":" }));
    parts.push(event("response.function_call_arguments.delta", { item_id: "fc_mock", output_index: 0, delta: "\"Singapore\"}" }));
    parts.push(event("response.function_call_arguments.done", { item_id: "fc_mock", output_index: 0, arguments: "{\"city\":\"Singapore\"}" }));
    parts.push(event("response.output_item.done", { output_index: 0, item: output[0] }));
  } else {
    parts.push(event("response.output_item.added", { output_index: 0, item: { id: "msg_mock", type: "message", role: "assistant", status: "in_progress", content: [] } }));
    parts.push(event("response.content_part.added", { item_id: "msg_mock", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    parts.push(event("response.output_text.delta", { item_id: "msg_mock", output_index: 0, content_index: 0, delta: "你" }));
    parts.push(event("response.output_text.delta", { item_id: "msg_mock", output_index: 0, content_index: 0, delta: "好，mock" }));
    parts.push(event("response.output_text.done", { item_id: "msg_mock", output_index: 0, content_index: 0, text: "你好，mock" }));
    parts.push(event("response.output_item.done", { output_index: 0, item: output[0] }));
  }
  parts.push(event("response.completed", { response: completed }));
  const bytes = new TextEncoder().encode(parts.join(""));
  const chunks: Uint8Array[] = [];
  const step = 17;
  for (let index = 0; index < bytes.length; index += step) chunks.push(bytes.slice(index, Math.min(bytes.length, index + step)));
  const slow = /slow/.test(collectText(body.input));
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        controller.error(signal.reason ?? new Error("aborted"));
        return;
      }
      if (slow) await new Promise((resolve) => setTimeout(resolve, 10));
      if (signal.aborted) {
        controller.error(signal.reason ?? new Error("aborted"));
        return;
      }
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    }
  }), { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

export async function mockUpstreamFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.href.startsWith(`${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`)) {
    return Response.json({ device_auth_id: "mock-device-auth-id", user_code: "MOCK-CODE", interval: "0" });
  }
  if (url.href.startsWith(`${AUTH_BASE_URL}/api/accounts/deviceauth/token`)) {
    stats.devicePoll += 1;
    if (control.devicePoll === "pending") return new Response(null, { status: 403 });
    if (control.devicePoll === "delay") await delay(75, request.signal);
    return Response.json({ authorization_code: "mock-auth-code", code_challenge: "mock-challenge", code_verifier: "mock-verifier" });
  }
  if (url.href.startsWith(`${AUTH_BASE_URL}/oauth/token`)) {
    const refresh = request.headers.get("content-type")?.includes("json") === true;
    if (refresh) {
      stats.refresh += 1;
      if (control.refresh === "delay") await delay(75, request.signal);
      if (control.refresh === "network") throw new Error("synthetic refresh network failure");
      if (control.refresh === "invalid_grant") return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json(mockTokens(refresh ? "refreshed" : "initial"));
  }
  if (url.href === "https://chatgpt.com/backend-api/wham/usage") {
    recordCodexRequest(request, url);
    stats.usageRequests += 1;
    if (control.usage === "delay") await delay(75, request.signal);
    if (control.usage === "network") throw new Error("synthetic usage network failure");
    if (control.usage === "invalid_grant") return Response.json({ error: { code: "invalid_grant" } }, { status: 401 });
    return Response.json({
      plan_type: "mock",
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 7 * 24 * 60 * 60, reset_at: 2000007200 },
        secondary_window: { used_percent: 40, limit_window_seconds: 5 * 60 * 60, reset_at: 2000003600 }
      },
      additional_rate_limits: [{
        metered_feature: "gpt-mock-special",
        limit_name: "Mock special",
        normal_model_slug: "gpt-mock",
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 60 * 60, reset_at: 2000001800 }
        }
      }]
    });
  }
  if (url.href.startsWith(`${CODEX_BASE_URL}/models`)) {
    recordCodexRequest(request, url);
    stats.modelRequests += 1;
    const value = { models: [
      {
        slug: "gpt-mock",
        display_name: "Mock model",
        supported_in_api: true,
        supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "max" }],
        default_reasoning_level: "low"
      },
      { slug: "gpt-empty", display_name: "No reasoning", supported_in_api: true, supported_reasoning_levels: [], default_reasoning_level: "high" },
      { slug: "gpt-unknown", display_name: "Unknown reasoning", supported_in_api: true, default_reasoning_level: "high" }
    ] };
    if (control.models === "invalid_models") return Response.json(null);
    if (control.models === "delay") await delay(75, request.signal);
    if (control.models === "late") await new Promise((resolve) => setTimeout(resolve, 75));
    if (control.models === "challenge") {
      return trackedBody(
        [new TextEncoder().encode("<!doctype html><title>Just a moment...</title><p>SECRET_BODY_MUST_NOT_APPEAR</p>"), new TextEncoder().encode("pending")],
        403,
        {
          "Content-Type": "text/html; charset=UTF-8",
          Server: "cloudflare",
          "cf-ray": "mockray-SIN",
          "cf-mitigated": "challenge",
          "x-request-id": "req_mock_edge"
        }
      );
    }
    if (control.models === "oversized_error") {
      const chunk = new TextEncoder().encode("x".repeat(40 * 1024));
      return trackedBody(Array.from({ length: 10 }, () => chunk), 403, { "Content-Type": "application/json" });
    }
    if (control.models === "slow_body") return delayedJson(value, request.signal);
    return Response.json(value);
  }
  if (url.href.startsWith(`${CODEX_BASE_URL}/responses`)) {
    recordCodexRequest(request, url);
    const body = await request.json() as Record<string, unknown>;
    stats.lastReasoningPresent = Object.prototype.hasOwnProperty.call(body, "reasoning");
    const reasoning = body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
      ? body.reasoning as Record<string, unknown>
      : null;
    stats.lastReasoningEffort = typeof reasoning?.effort === "string" ? reasoning.effort : "";
    stats.lastReasoningSummary = typeof reasoning?.summary === "string" ? reasoning.summary : "";
    const marker = collectText(body.input);
    if (marker.includes("mock:http401")) return Response.json({}, { status: 401 });
    if (marker.includes("mock:http403")) return Response.json({}, { status: 403 });
    if (marker.includes("mock:http429")) return Response.json({}, { status: 429 });
    if (marker.includes("mock:http500")) return Response.json({}, { status: 500 });
    if (marker.includes("mock:redirect")) {
      const chunk = new TextEncoder().encode("redirect-body");
      return trackedBody([chunk, chunk, chunk], 302, { Location: "https://evil.example/steal" });
    }
    if (marker.includes("mock:header-timeout")) await delay(250, request.signal);
    if (marker.includes("mock:invalid-event")) return new Response("event: response.created\ndata: not-json\n\n", { headers: { "Content-Type": "text/event-stream" } });
    if (marker.includes("mock:invalid-utf8")) return new Response(new Uint8Array([0xc3, 0x28]), { headers: { "Content-Type": "text/event-stream" } });
    if (marker.includes("mock:truncated")) return new Response(event("response.created", { response: { id: "resp_truncated", status: "in_progress" } }), { headers: { "Content-Type": "text/event-stream" } });
    if (marker.includes("mock:failed")) return new Response(event("response.failed", { response: { id: "resp_failed", status: "failed", error: { message: "synthetic failure" } } }), { headers: { "Content-Type": "text/event-stream" } });
    return sseResponse(body, request.signal);
  }
  return Response.json({ error: "unexpected mock upstream path" }, { status: 404 });
}
