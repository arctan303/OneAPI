export const RELAY_PROTOCOL_VERSION = 1 as const;
export const RELAY_REQUEST_MAX_BYTES = 64 * 1024;
export const RELAY_REQUEST_ENVELOPE_MAX_BYTES = 96 * 1024;
export const RELAY_RESPONSE_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const RELAY_RESPONSE_PLAINTEXT_MAX_BYTES = 3 * 1024 * 1024;
export const RELAY_RESPONSE_ENVELOPE_MAX_BYTES = 4 * 1024 * 1024;
export const RELAY_GENERATION_MODEL = "gpt-5.5";
export const RELAY_GENERATION_PROMPT = "Reply only EGRESS_OK";

const REQUEST_AAD = "oneapi:egress-relay:request:v1";
const RESPONSE_AAD = "oneapi:egress-relay:response:v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_VERSION_PATTERN = /^[0-9]{1,4}(?:\.[0-9]{1,4}){1,3}$/;
const HEADER_VALUE_PATTERN = /^[\x20-\x7E]{1,16384}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type RelayOperation = "ping" | "models" | "usage" | "generate";

export interface RelayEnvelope {
  v: 1;
  iv: string;
  data: string;
}

export interface RelayRequest {
  requestId: string;
  issuedAt: number;
  operation: RelayOperation;
  headers: Record<string, string>;
  clientVersion?: string;
  bodyText?: string;
}

export interface RelayResponse {
  requestId: string;
  status: number;
  headers: Record<string, string>;
  bodyBase64?: string;
  service?: "oneapi-egress-relay";
}

export function fixedRelayGenerationBody(): Record<string, unknown> {
  return {
    model: RELAY_GENERATION_MODEL,
    instructions: "",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: RELAY_GENERATION_PROMPT }]
    }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"]
  };
}

const REQUEST_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "accept",
  "content-type",
  "originator",
  "user-agent",
  "version"
]);

const RESPONSE_HEADERS = new Set([
  "content-type",
  "server",
  "cf-ray",
  "cf-mitigated",
  "x-request-id",
  "openai-request-id",
  "cf-request-id"
]);

function ownRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw new Error(`${label} contains unsupported fields`);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }
  return btoa(binary);
}

function decodeBase64(value: unknown, label: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maxBytes / 3) * 4 || !BASE64_PATTERN.test(value)) {
    throw new Error(`${label} must be canonical base64`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`${label} must be canonical base64`);
  }
  if (binary.length > maxBytes) throw new Error(`${label} exceeds the byte limit`);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (encodeBase64(bytes) !== value) throw new Error(`${label} must be canonical base64`);
  return bytes;
}

function encodedJson(value: unknown, maxBytes: number, label: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength > maxBytes) throw new Error(`${label} exceeds the byte limit`);
  const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  copy.set(encoded);
  return copy;
}

function parseHeaderMap(value: unknown, allowed: Set<string>, label: string): Record<string, string> {
  const record = ownRecord(value, label);
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(record)) {
    if (name !== name.toLowerCase() || !allowed.has(name) || typeof headerValue !== "string" || !HEADER_VALUE_PATTERN.test(headerValue)) {
      throw new Error(`${label} contains an invalid header`);
    }
    result[name] = headerValue;
  }
  return result;
}

export function parseRelayKey(value: string): Uint8Array<ArrayBuffer> {
  const key = decodeBase64(value, "relay key", 32);
  if (key.byteLength !== 32) throw new Error("relay key must decode to 32 bytes");
  return key;
}

export function validateRelayRequest(value: unknown): RelayRequest {
  const request = ownRecord(value, "relay request");
  onlyKeys(request, ["requestId", "issuedAt", "operation", "headers", "clientVersion", "bodyText"], "relay request");
  if (typeof request.requestId !== "string" || !UUID_PATTERN.test(request.requestId)) throw new Error("relay requestId is invalid");
  if (typeof request.issuedAt !== "number" || !Number.isSafeInteger(request.issuedAt) || request.issuedAt < 0) throw new Error("relay issuedAt is invalid");
  if (request.operation !== "ping" && request.operation !== "models" && request.operation !== "usage" && request.operation !== "generate") {
    throw new Error("relay operation is invalid");
  }
  const headers = parseHeaderMap(request.headers, REQUEST_HEADERS, "relay request headers");
  if (request.clientVersion !== undefined && (typeof request.clientVersion !== "string" || !CLIENT_VERSION_PATTERN.test(request.clientVersion))) {
    throw new Error("relay clientVersion is invalid");
  }
  if (request.bodyText !== undefined && (typeof request.bodyText !== "string" || new TextEncoder().encode(request.bodyText).byteLength > RELAY_REQUEST_MAX_BYTES)) {
    throw new Error("relay bodyText is invalid");
  }
  if (request.operation === "ping") {
    if (Object.keys(headers).length !== 0 || request.clientVersion !== undefined || request.bodyText !== undefined) throw new Error("ping request contains upstream fields");
  } else {
    for (const required of ["authorization", "chatgpt-account-id", "accept", "content-type", "originator", "user-agent", "version"]) {
      if (!headers[required]) throw new Error("relay request headers are incomplete");
    }
    if (request.operation === "models" && request.clientVersion === undefined) throw new Error("models request requires clientVersion");
    if (request.operation === "models" && request.clientVersion !== headers.version) throw new Error("models clientVersion must match version header");
    if (request.operation !== "models" && request.clientVersion !== undefined) throw new Error("clientVersion is only valid for models");
    if (request.operation === "generate" && request.bodyText === undefined) throw new Error("generate request requires bodyText");
    if (request.operation !== "generate" && request.bodyText !== undefined) throw new Error("bodyText is only valid for generate");
    if (request.operation === "generate" && request.bodyText !== JSON.stringify(fixedRelayGenerationBody())) {
      throw new Error("generate request body is not the fixed diagnostic request");
    }
  }
  return {
    requestId: request.requestId,
    issuedAt: request.issuedAt,
    operation: request.operation,
    headers,
    ...(request.clientVersion !== undefined ? { clientVersion: request.clientVersion } : {}),
    ...(request.bodyText !== undefined ? { bodyText: request.bodyText } : {})
  } as RelayRequest;
}

export function validateRelayResponse(value: unknown): RelayResponse {
  const response = ownRecord(value, "relay response");
  onlyKeys(response, ["requestId", "status", "headers", "bodyBase64", "service"], "relay response");
  if (typeof response.requestId !== "string" || !UUID_PATTERN.test(response.requestId)) throw new Error("relay response requestId is invalid");
  if (typeof response.status !== "number" || !Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
    throw new Error("relay response status is invalid");
  }
  const headers = parseHeaderMap(response.headers, RESPONSE_HEADERS, "relay response headers");
  let bodyBase64: string | undefined;
  if (response.bodyBase64 !== undefined) {
    if (typeof response.bodyBase64 !== "string") throw new Error("relay response body is invalid");
    if (response.bodyBase64 !== "") decodeBase64(response.bodyBase64, "relay response body", RELAY_RESPONSE_BODY_MAX_BYTES);
    bodyBase64 = response.bodyBase64;
  }
  if (response.service !== undefined && response.service !== "oneapi-egress-relay") throw new Error("relay response service is invalid");
  return {
    requestId: response.requestId,
    status: response.status,
    headers,
    ...(bodyBase64 !== undefined ? { bodyBase64 } : {}),
    ...(response.service !== undefined ? { service: response.service } : {})
  };
}

async function importRelayKey(value: string): Promise<CryptoKey> {
  const key = parseRelayKey(value);
  return crypto.subtle.importKey("raw", key.buffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encrypt(keyBase64: string, value: unknown, aad: string, maxPlaintextBytes: number): Promise<RelayEnvelope> {
  const key = await importRelayKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const plaintext = encodedJson(value, maxPlaintextBytes, "relay plaintext");
  const additionalData = new TextEncoder().encode(aad);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plaintext));
  return { v: RELAY_PROTOCOL_VERSION, iv: encodeBase64(iv), data: encodeBase64(encrypted) };
}

async function decrypt(keyBase64: string, envelopeValue: unknown, aad: string, maxPlaintextBytes: number): Promise<unknown> {
  const envelope = ownRecord(envelopeValue, "relay envelope");
  onlyKeys(envelope, ["v", "iv", "data"], "relay envelope");
  if (envelope.v !== RELAY_PROTOCOL_VERSION) throw new Error("relay protocol version is unsupported");
  const iv = decodeBase64(envelope.iv, "relay IV", 12);
  if (iv.byteLength !== 12) throw new Error("relay IV must decode to 12 bytes");
  const ciphertext = decodeBase64(envelope.data, "relay ciphertext", maxPlaintextBytes + 16);
  if (ciphertext.byteLength < 16) throw new Error("relay ciphertext is invalid");
  const key = await importRelayKey(keyBase64);
  const additionalData = new TextEncoder().encode(aad);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, key, ciphertext);
  } catch {
    throw new Error("relay envelope authentication failed");
  }
  if (plaintext.byteLength > maxPlaintextBytes) throw new Error("relay plaintext exceeds the byte limit");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
  } catch {
    throw new Error("relay plaintext is not valid JSON");
  }
}

export async function encryptRelayRequest(keyBase64: string, request: RelayRequest): Promise<RelayEnvelope> {
  const validated = validateRelayRequest(request);
  return encrypt(keyBase64, validated, REQUEST_AAD, RELAY_REQUEST_MAX_BYTES);
}

export async function decryptRelayRequest(keyBase64: string, envelope: unknown): Promise<RelayRequest> {
  return validateRelayRequest(await decrypt(keyBase64, envelope, REQUEST_AAD, RELAY_REQUEST_MAX_BYTES));
}

export async function encryptRelayResponse(keyBase64: string, response: RelayResponse): Promise<RelayEnvelope> {
  const validated = validateRelayResponse(response);
  return encrypt(keyBase64, validated, RESPONSE_AAD, RELAY_RESPONSE_PLAINTEXT_MAX_BYTES);
}

export async function decryptRelayResponse(keyBase64: string, envelope: unknown): Promise<RelayResponse> {
  return validateRelayResponse(await decrypt(keyBase64, envelope, RESPONSE_AAD, RELAY_RESPONSE_PLAINTEXT_MAX_BYTES));
}

export function decodeRelayBody(response: RelayResponse): Uint8Array<ArrayBuffer> {
  return !response.bodyBase64
    ? new Uint8Array(new ArrayBuffer(0))
    : decodeBase64(response.bodyBase64, "relay response body", RELAY_RESPONSE_BODY_MAX_BYTES);
}

export function relayEnvelopeBytes(envelope: RelayEnvelope): number {
  return new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
}
