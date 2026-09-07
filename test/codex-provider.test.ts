import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/errors";
import { createResponseRequest } from "../src/codex/upstream";
import { normalizeChat, normalizeResponses } from "../src/protocol/requests";
import type { StoredCredentials } from "../src/types";

const credentials: StoredCredentials = {
  idToken: "id-token",
  accessToken: "account-access-token",
  refreshToken: "refresh-token",
  accountId: "acct_gateway",
  expiresAt: null,
  lastRefreshAt: 0,
  version: 1
};

function expectUnsupported(body: Record<string, unknown>, param: string): void {
  let caught: unknown;
  try {
    normalizeResponses({ model: "gpt-test", input: "hello", ...body });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GatewayError);
  expect(caught).toMatchObject({ status: 400, code: "unsupported_parameter", param });
}

describe("Codex native provider compatibility", () => {
  it("keeps current Codex input and known options opaque while ignoring unknown fields", () => {
    const input = [
      {
        type: "additional_tools",
        id: "tools_1",
        tools: [
          { type: "function", name: "read_file", namespace: "workspace", description: "read", parameters: { type: "object" } },
          { type: "custom", name: "shell", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
          { type: "namespace", name: "functions", description: "client-executed tool namespace" }
        ]
      },
      {
        type: "message",
        id: "msg_user",
        role: "user",
        content: [{ type: "input_text", text: "inspect" }]
      },
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "opaque-encrypted-state",
        summary: []
      },
      {
        type: "function_call",
        id: "fc_1",
        name: "read_file",
        namespace: "workspace",
        arguments: "{\"path\":\"README.md\"}",
        call_id: "call_1"
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_text", text: "contents" }]
      },
      {
        type: "custom_tool_call",
        id: "ctc_1",
        name: "shell",
        input: "pwd",
        call_id: "call_2"
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_2",
        output: "C:\\repo"
      }
    ];
    const tools = [{ type: "custom", name: "shell", description: "execute", format: { type: "text" } }];
    const toolChoice = { type: "custom", name: "shell" };
    const normalized = normalizeResponses({
      model: "gpt-test",
      input,
      tools,
      tool_choice: toolChoice,
      reasoning: { effort: "low", context: "all_turns" },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session-123",
      text: { verbosity: "low" },
      client_metadata: {
        "x-codex-installation-id": "install-1",
        session_id: "session-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        root_turn_id: "root-1",
        "x-codex-window-id": "window-1",
        "x-codex-turn-metadata": "{\"kind\":\"test\"}",
        future_metadata: "drop-me"
      },
      future_top_level: { drop: true }
    });

    expect(normalized.codexNative).toBe(true);
    expect(normalized.ignoredParameters).toEqual(["future_top_level", "client_metadata.future_metadata"]);
    expect(normalized.upstream).toEqual({
      model: "gpt-test",
      input,
      tools,
      tool_choice: toolChoice,
      parallel_tool_calls: true,
      reasoning: { effort: "low", context: "all_turns" },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session-123",
      text: { verbosity: "low" },
      client_metadata: {
        "x-codex-installation-id": "install-1",
        session_id: "session-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        root_turn_id: "root-1",
        "x-codex-window-id": "window-1",
        "x-codex-turn-metadata": "{\"kind\":\"test\"}"
      }
    });
    expect(normalized.upstream).not.toHaveProperty("future_top_level");
  });

  it("bounds and sanitizes ignored parameter names used by logs and response headers", () => {
    const body: Record<string, unknown> = { model: "gpt-test", input: "hello" };
    body[`line${String.fromCharCode(13, 10)}break`] = true;
    for (let index = 0; index < 40; index += 1) body[`future_${index}_${"x".repeat(160)}`] = index;
    const normalized = normalizeResponses(body);
    expect(normalized.ignoredParameters).toHaveLength(32);
    expect(normalized.ignoredParameters[0]).toBe("line??break");
    expect(normalized.ignoredParameters.every((name) => name.length <= 128 && /^[A-Za-z0-9_.:? -]+$/.test(name))).toBe(true);
  });

  it("ignores unknown Chat top-level fields without forwarding them", () => {
    const normalized = normalizeChat({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      service_tier: "priority"
    });
    expect(normalized.ignoredParameters).toEqual(["service_tier"]);
    expect(normalized.upstream).not.toHaveProperty("service_tier");
  });

  it("rejects managed tools even when client_metadata selects the native path", () => {
    for (const type of ["web_search", "file_search", "computer_use_preview"]) {
      expect(() => normalizeResponses({
        model: "gpt-test",
        input: "hello",
        client_metadata: {},
        tools: [{ type }]
      })).toThrowError(expect.objectContaining({ status: 400, code: "unsupported_tool", param: "tools[0].type" }));
      expect(() => normalizeResponses({
        model: "gpt-test",
        input: [{ type: "additional_tools", tools: [{ type }] }]
      })).toThrowError(expect.objectContaining({ status: 400, code: "unsupported_tool", param: "input[0].tools[0].type" }));
    }
    expect(() => normalizeResponses({
      model: "gpt-test",
      input: "hello",
      client_metadata: {},
      tool_choice: { type: "web_search" }
    })).toThrowError(expect.objectContaining({ status: 400, code: "unsupported_tool", param: "tool_choice.type" }));
  });
  it("still rejects unsupported stateful Responses semantics", () => {
    expectUnsupported({ store: true }, "store");
    expectUnsupported({ background: true }, "background");
    expectUnsupported({ previous_response_id: "resp_1" }, "previous_response_id");
    expectUnsupported({ conversation: "conv_1" }, "conversation");
  });

  it("forwards only reviewed Codex headers and always replaces client credentials", async () => {
    const request = createResponseRequest(credentials, { model: "gpt-test", input: [] }, undefined, new Headers({
      Authorization: "Bearer attacker",
      "ChatGPT-Account-ID": "acct_attacker",
      Cookie: "session=secret",
      "X-Codex-Beta-Features": "remote_compaction_v2",
      "X-Codex-Window-Id": "window-1",
      "X-Codex-Turn-Metadata": "turn-meta",
      "X-OpenAI-Internal-Codex-Responses-Lite": "true",
      "X-Client-Request-Id": "client-request-1",
      "Session-Id": "session-1",
      "Thread-Id": "thread-1",
      "X-Codex-Parent-Thread-Id": "parent-1",
      "X-OpenAI-Subagent": "reviewer",
      "X-Future-Header": "drop-me"
    }));

    expect(request.headers.get("authorization")).toBe("Bearer account-access-token");
    expect(request.headers.get("chatgpt-account-id")).toBe("acct_gateway");
    expect(request.headers.get("cookie")).toBeNull();
    expect(request.headers.get("x-future-header")).toBeNull();
    expect(request.headers.get("x-codex-beta-features")).toBe("remote_compaction_v2");
    expect(request.headers.get("x-codex-window-id")).toBe("window-1");
    expect(request.headers.get("x-codex-turn-metadata")).toBe("turn-meta");
    expect(request.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
    expect(request.headers.get("x-client-request-id")).toBe("client-request-1");
    expect(request.headers.get("session-id")).toBe("session-1");
    expect(request.headers.get("thread-id")).toBe("thread-1");
    expect(request.headers.get("x-codex-parent-thread-id")).toBe("parent-1");
    expect(request.headers.get("x-openai-subagent")).toBe("reviewer");
    expect(await request.json()).toEqual({ model: "gpt-test", input: [] });
  });

  it("bounds forwarded metadata headers", () => {
    expect(() => createResponseRequest(
      credentials,
      { model: "gpt-test", input: [] },
      undefined,
      new Headers({ "X-Codex-Window-Id": "x".repeat(16 * 1024 + 1) })
    )).toThrowError(expect.objectContaining({ status: 400, code: "invalid_header", param: "x-codex-window-id" }));
    expect(() => normalizeResponses({
      model: "gpt-test",
      input: "hello",
      client_metadata: { "x-codex-window-id": "界".repeat(6000) }
    })).toThrowError(expect.objectContaining({ status: 400, code: "invalid_type", param: "client_metadata.x-codex-window-id" }));
  });
});
