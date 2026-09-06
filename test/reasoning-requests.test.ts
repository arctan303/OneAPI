import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/errors";
import { normalizeChat, normalizeResponses } from "../src/protocol/requests";

const responseBody = (reasoning?: unknown) => ({
  model: "gpt-test",
  input: "hello",
  ...(reasoning !== undefined ? { reasoning } : {})
});

const chatBody = (reasoningEffort?: unknown) => ({
  model: "gpt-test",
  messages: [{ role: "user", content: "hello" }],
  ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {})
});

function expectGateway400(run: () => unknown, param: string, code?: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GatewayError);
  const gateway = caught as GatewayError;
  expect(gateway.status).toBe(400);
  expect(gateway.param).toBe(param);
  if (code) expect(gateway.code).toBe(code);
}

describe("reasoning request normalization", () => {
  it.each(["none", "max", "ultra", "adaptive_v2", "reasoning-fast"])(
    "accepts bounded effort identifier %s without a static semantic enum",
    (effort) => {
      expect(normalizeResponses(responseBody({ effort })).upstream.reasoning).toEqual({
        effort,
        summary: "auto"
      });
    }
  );

  it("maps Responses reasoning.effort and Chat reasoning_effort to the same upstream shape", () => {
    expect(normalizeResponses(responseBody({ effort: "high" })).upstream.reasoning).toEqual({
      effort: "high",
      summary: "auto"
    });
    expect(normalizeChat(chatBody("high")).upstream.reasoning).toEqual({
      effort: "high",
      summary: "auto"
    });
  });

  it("does not inject upstream reasoning when the client omits the field", () => {
    expect(normalizeResponses(responseBody()).upstream).not.toHaveProperty("reasoning");
    expect(normalizeChat(chatBody()).upstream).not.toHaveProperty("reasoning");
  });

  it("rejects an invalid Responses reasoning object or extra nested fields", () => {
    expectGateway400(() => normalizeResponses(responseBody(null)), "reasoning", "invalid_type");
    expectGateway400(
      () => normalizeResponses(responseBody({ effort: "low", summary: "auto" })),
      "reasoning.summary",
      "unsupported_parameter"
    );
  });

  it.each([
    ["non-string", 1],
    ["empty", ""],
    ["leading whitespace", " low"],
    ["uppercase", "HIGH"],
    ["invalid punctuation", "high/fast"],
    ["too long", "a".repeat(33)]
  ])("rejects Responses %s effort with a field-specific 400", (_label, effort) => {
    expectGateway400(
      () => normalizeResponses(responseBody({ effort })),
      "reasoning.effort"
    );
  });

  it.each([
    ["non-string", { value: "high" }],
    ["empty", ""],
    ["leading digit", "1high"],
    ["uppercase", "HIGH"],
    ["invalid punctuation", "high/fast"],
    ["too long", "a".repeat(33)]
  ])("rejects Chat %s effort with the public Chat parameter", (_label, effort) => {
    expectGateway400(
      () => normalizeChat(chatBody(effort)),
      "reasoning_effort"
    );
  });
});
