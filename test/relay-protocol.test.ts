import { describe, expect, it } from "vitest";
import { normalizeResponses } from "../src/protocol/requests";
import {
  decryptRelayRequest,
  decryptRelayResponse,
  encryptRelayRequest,
  encryptRelayResponse,
  fixedRelayGenerationBody,
  parseRelayKey,
  RELAY_GENERATION_MODEL,
  RELAY_GENERATION_PROMPT,
  type RelayRequest
} from "../src/relay-protocol";

const key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

function fixedRequest(overrides: Partial<RelayRequest> = {}): RelayRequest {
  return {
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    issuedAt: 1_800_000_000_000,
    operation: "generate",
    headers: {
      authorization: "Bearer access-token",
      "chatgpt-account-id": "acct_test",
      accept: "text/event-stream",
      "content-type": "application/json",
      originator: "codex_cli_rs",
      "user-agent": "OneAPI test",
      version: "0.153.4"
    },
    bodyText: JSON.stringify(fixedRelayGenerationBody()),
    ...overrides
  };
}

describe("egress relay protocol", () => {
  it("round-trips authenticated request and response envelopes with different AAD", async () => {
    const requestEnvelope = await encryptRelayRequest(key, fixedRequest());
    expect(await decryptRelayRequest(key, requestEnvelope)).toEqual(fixedRequest());
    await expect(decryptRelayResponse(key, requestEnvelope)).rejects.toThrow("authentication failed");

    const response = {
      requestId: fixedRequest().requestId,
      status: 403,
      headers: { "content-type": "text/html", "cf-ray": "test-SIN" },
      bodyBase64: btoa("blocked")
    } as const;
    const responseEnvelope = await encryptRelayResponse(key, response);
    expect(await decryptRelayResponse(key, responseEnvelope)).toEqual(response);
    const empty = { requestId: response.requestId, status: 204, headers: {}, bodyBase64: "" } as const;
    expect(await decryptRelayResponse(key, await encryptRelayResponse(key, empty))).toEqual(empty);
    await expect(encryptRelayResponse(key, { requestId: response.requestId, status: 101, headers: {} }))
      .rejects.toThrow("status is invalid");
  });

  it("rejects tampering, wrong keys, malformed base64 and unsupported envelope fields", async () => {
    const envelope = await encryptRelayRequest(key, fixedRequest());
    const replacement = envelope.data[0] === "A" ? "B" : "A";
    await expect(decryptRelayRequest(key, { ...envelope, data: replacement + envelope.data.slice(1) }))
      .rejects.toThrow("authentication failed");
    const wrongKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    await expect(decryptRelayRequest(wrongKey, envelope)).rejects.toThrow("authentication failed");
    expect(() => parseRelayKey("not base64")).toThrow("canonical base64");
    await expect(decryptRelayRequest(key, { ...envelope, extra: true })).rejects.toThrow("unsupported fields");
  });

  it("allows only whitelisted headers and the exact fixed generation request", async () => {
    await expect(encryptRelayRequest(key, fixedRequest({
      headers: { ...fixedRequest().headers, cookie: "forbidden" }
    }))).rejects.toThrow("invalid header");
    await expect(encryptRelayRequest(key, fixedRequest({
      bodyText: JSON.stringify({ ...fixedRelayGenerationBody(), model: "gpt-other" })
    }))).rejects.toThrow("fixed diagnostic request");
    await expect(encryptRelayRequest(key, fixedRequest({
      bodyText: JSON.stringify({ ...fixedRelayGenerationBody(), stream: false })
    }))).rejects.toThrow("fixed diagnostic request");
  });

  it("keeps the shared fixed body aligned with the existing Responses normalizer", () => {
    const normalized = normalizeResponses({
      model: RELAY_GENERATION_MODEL,
      input: RELAY_GENERATION_PROMPT
    });
    expect(normalized.upstream).toEqual(fixedRelayGenerationBody());
  });
});
