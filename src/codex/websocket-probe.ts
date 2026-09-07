import { GatewayError, type UpstreamDiagnostic } from "../errors";
import type { StoredCredentials } from "../types";
import type { OutboundFetch } from "./auth";
import { CODEX_BASE_URL } from "./constants";
import { codexHeaders, collectUpstreamDiagnostic } from "./upstream";

const TARGET_URL = `${CODEX_BASE_URL}/responses`;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const OBSERVATION_MS = 300;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024 + 1;

export interface WebSocketProbeResult {
  status: number;
  upgraded: boolean;
  diagnostic?: UpstreamDiagnostic;
  serverSelectedModelPresent?: boolean;
  reasoningIncluded?: boolean;
  messageObserved?: boolean;
  errorObserved?: boolean;
  closed?: boolean;
  closeCode?: number | null;
}

export function createWebSocketProbeRequest(credentials: StoredCredentials): Request {
  const headers = codexHeaders(credentials, "application/json");
  headers.set("Upgrade", "websocket");
  headers.set("OpenAI-Beta", "responses_websockets=2026-02-06");
  return new Request(TARGET_URL, { method: "GET", headers, redirect: "manual" });
}

function discardLateResponse(response: Response): void {
  if (response.webSocket) {
    try { response.webSocket.close(1000); } catch { /* A late socket may already be closed. */ }
    return;
  }
  void response.body?.cancel("late websocket handshake response").catch(() => undefined);
}

async function boundedDiagnostic(response: Response, timeoutMs: number): Promise<UpstreamDiagnostic> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutError = new GatewayError(504, "websocket_probe_response_timeout", "WebSocket 握手错误响应读取超时。", undefined, "timeout_error");
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(timeoutError);
        void reader.cancel("websocket diagnostic response timeout").catch(() => undefined);
      }, timeoutMs);
    });
    try {
      while (size < MAX_DIAGNOSTIC_BYTES) {
        const next = await Promise.race([reader.read(), timeout]);
        if (timedOut) throw timeoutError;
        if (next.done) break;
        const remaining = MAX_DIAGNOSTIC_BYTES - size;
        chunks.push(next.value.byteLength > remaining ? next.value.slice(0, remaining) : next.value);
        size += Math.min(next.value.byteLength, remaining);
        if (size >= MAX_DIAGNOSTIC_BYTES) {
          void reader.cancel("websocket diagnostic response too large").catch(() => undefined);
          break;
        }
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return collectUpstreamDiagnostic(new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }), TARGET_URL);
}

export async function probeResponsesWebSocket(
  credentials: StoredCredentials,
  fetcher: OutboundFetch,
  observeMs = OBSERVATION_MS,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
): Promise<WebSocketProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, Math.min(handshakeTimeoutMs, HANDSHAKE_TIMEOUT_MS));
  const controller = new AbortController();
  const timeoutError = new GatewayError(504, "websocket_probe_timeout", "WebSocket 握手超过 5 秒时限。", undefined, "timeout_error");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("websocket handshake timeout"));
      reject(timeoutError);
    }, timeoutMs);
  });
  let response: Response;
  try {
    const fetchResult = fetcher(new Request(createWebSocketProbeRequest(credentials), { signal: controller.signal }))
      .then((lateResponse) => {
        if (controller.signal.aborted) {
          discardLateResponse(lateResponse);
          throw timeoutError;
        }
        return lateResponse;
      });
    response = await Promise.race([fetchResult, deadline]);
    if (controller.signal.aborted) {
      discardLateResponse(response);
      throw timeoutError;
    }
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer);
    if (error === timeoutError || controller.signal.aborted) throw timeoutError;
    throw new GatewayError(
      502,
      "websocket_probe_network_error",
      "无法连接 WebSocket 握手端点。",
      undefined,
      "server_error",
    );
  }

  if (response.status !== 101) {
    try {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      return {
        status: response.status,
        upgraded: false,
        diagnostic: await boundedDiagnostic(response, remainingMs),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  if (timer !== undefined) clearTimeout(timer);
  const webSocket = response.webSocket;
  if (!webSocket) {
    throw new GatewayError(502, "websocket_upgrade_missing", "上游返回 101 但未提供 WebSocket。", undefined, "server_error");
  }

  let messageObserved = false;
  let errorObserved = false;
  let closed = false;
  let closeCode: number | null = null;
  let observationTimer: ReturnType<typeof setTimeout> | undefined;
  let finish = () => {};
  const observed = new Promise<void>((resolve) => { finish = resolve; });
  const onMessage = () => { messageObserved = true; };
  const onError = () => { errorObserved = true; finish(); };
  const onClose = (event: CloseEvent) => {
    closed = true;
    closeCode = Number.isInteger(event.code) && event.code >= 0 && event.code <= 4999 ? event.code : null;
    finish();
  };
  webSocket.addEventListener("message", onMessage);
  webSocket.addEventListener("error", onError);
  webSocket.addEventListener("close", onClose);
  try {
    webSocket.accept();
    observationTimer = setTimeout(finish, Math.max(0, Math.min(observeMs, OBSERVATION_MS)));
    await observed;
    return {
      status: response.status,
      upgraded: true,
      serverSelectedModelPresent: response.headers.has("openai-model"),
      reasoningIncluded: response.headers.has("x-reasoning-included"),
      messageObserved,
      errorObserved,
      closed,
      closeCode,
    };
  } finally {
    if (observationTimer !== undefined) clearTimeout(observationTimer);
    webSocket.removeEventListener("message", onMessage);
    webSocket.removeEventListener("error", onError);
    webSocket.removeEventListener("close", onClose);
    try { webSocket.close(1000); } catch { /* Connection may already be closed. */ }
  }
}
