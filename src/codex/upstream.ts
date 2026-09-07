import { GatewayError, upstreamError, type UpstreamDiagnostic } from "../errors";
import type { StoredCredentials } from "../types";
import type { OutboundFetch } from "./auth";
import { CLIENT_VERSION, CODEX_BASE_URL, CODEX_ORIGINATOR, CODEX_USER_AGENT } from "./constants";

async function rejectRedirect(response: Response, operation: string): Promise<void> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel("redirect response body is not retained").catch(() => undefined);
    throw new GatewayError(
      502,
      "upstream_redirect_rejected",
      `${operation} 尝试重定向；为防止凭据跨域外带，网关已拒绝该响应。`
    );
  }
}

function safeDiagnosticToken(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : "";
}

function safeHeaderText(value: string | null): string {
  return (value ?? "").replace(/[^\x20-\x7E]/g, "?").slice(0, 100);
}

function safeContentEncoding(value: string | null): UpstreamDiagnostic["contentEncoding"] | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "gzip" || normalized === "br" || normalized === "deflate" || normalized === "zstd" || normalized === "identity"
    ? normalized
    : undefined;
}

interface BoundedText {
  text: string;
  bytes: Uint8Array;
  truncated: boolean;
}

async function readBoundedText(response: Response): Promise<BoundedText> {
  if (!response.body) return { text: "", bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const maxBytes = 64 * 1024;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = maxBytes - size;
      if (next.value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(next.value.slice(0, remaining));
          size += remaining;
        }
        truncated = true;
        await reader.cancel("upstream error body exceeded diagnostic limit");
        break;
      }
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } catch {
    await reader.cancel("upstream error body read failed").catch(() => undefined);
    return { text: "", bytes: new Uint8Array(), truncated: true };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8").decode(bytes), bytes, truncated };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function diagnosticBodyFormat(bytes: Uint8Array, text: string): UpstreamDiagnostic["bodyFormat"] {
  if (bytes.byteLength === 0) return "empty";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip_magic";
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) return "zstd_magic";
  const normalized = text.replace(/^\uFEFF?\s*/, "").toLowerCase();
  if (normalized.startsWith("<!doctype html") || normalized.startsWith("<html") || normalized.slice(0, 512).includes("<html")) {
    return "html_text";
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /^[\x09\x0A\x0D\x20-\x7E\u0080-\uFFFF]*$/.test(text) ? "text" : "binary";
  } catch {
    return "binary";
  }
}

export async function readBoundedErrorCode(response: Response): Promise<string> {
  const body = await readBoundedText(response);
  if (body.truncated) return "";
  try {
    const value = JSON.parse(body.text) as { error?: { code?: unknown } };
    return safeDiagnosticToken(value.error?.code).toLowerCase();
  } catch {
    return "";
  }
}

function redactedHtmlTitle(html: string): string {
  const match = html.match(/<title(?:\s[^>]*)?>([\s\S]{0,2048}?)<\/title>/i);
  if (!match) return "";
  const normalized = match[1]!
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (normalized.startsWith("just a moment")) return "Just a moment...";
  if (normalized.includes("attention required") && normalized.includes("cloudflare")) return "Attention Required! | Cloudflare";
  if (normalized.includes("access denied")) return "Access denied";
  if (normalized === "forbidden" || normalized.startsWith("403 forbidden")) return "Forbidden";
  if (normalized === "error" || normalized.startsWith("server error")) return "Error";
  return "[redacted]";
}

function htmlErrorCategory(title: string, server: string, cfRay: string, cfMitigated: string): string {
  const hasCloudflareSignal = server.toLowerCase().includes("cloudflare") || Boolean(cfRay) || Boolean(cfMitigated);
  if (cfMitigated.toLowerCase() === "challenge") return "cloudflare_challenge";
  if (title === "Attention Required! | Cloudflare") return hasCloudflareSignal ? "cloudflare_attention_required" : "html_attention_required";
  if (title === "Just a moment...") return hasCloudflareSignal ? "cloudflare_interstitial" : "html_interstitial";
  if (title === "Access denied" || title === "Forbidden") {
    return hasCloudflareSignal ? "cloudflare_access_denied" : "html_access_denied";
  }
  return hasCloudflareSignal ? "cloudflare_html_error" : "unclassified_html_error";
}

function strictCloudflareErrorCode(body: string, contentType: string, hasCloudflareSignal: boolean): string {
  if (!hasCloudflareSignal) return "";
  const normalizedContentType = contentType.toLowerCase();
  const html = normalizedContentType.includes("html");
  if (!html && !normalizedContentType.includes("text/plain")) return "";
  const match = html
    ? body.match(/<(?:span|div)\b[^>]*\bclass=["'][^"']*\bcf-error-code\b[^"']*["'][^>]*>\s*(?:error(?:\s+code)?\s*:?\s*)?([1-9][0-9]{3})\s*<\/(?:span|div)>/i)
    : body.match(/(?:^|\s)error\s+code\s*:\s*([1-9][0-9]{3})(?=\s|$)/i);
  if (!match) return "";
  const value = Number.parseInt(match[1]!, 10);
  return value >= 1000 && value <= 1999 ? String(value) : "";
}

export async function collectUpstreamDiagnostic(response: Response, targetUrl: string): Promise<UpstreamDiagnostic> {
  const target = new URL(targetUrl);
  const contentType = safeHeaderText(response.headers.get("content-type"));
  const contentEncoding = safeContentEncoding(response.headers.get("content-encoding"));
  const server = safeHeaderText(response.headers.get("server"));
  const cfRay = safeDiagnosticToken(response.headers.get("cf-ray"));
  const cfMitigated = safeDiagnosticToken(response.headers.get("cf-mitigated"));
  const upstreamRequestId = safeDiagnosticToken(
    response.headers.get("x-request-id") ?? response.headers.get("openai-request-id") ?? response.headers.get("cf-request-id")
  );
  const body = await readBoundedText(response);
  const bodySha256 = await sha256Hex(body.bytes);
  const bodyFormat = diagnosticBodyFormat(body.bytes, body.text);
  const hasCloudflareSignal = server.toLowerCase().includes("cloudflare") || Boolean(cfRay) || Boolean(cfMitigated);
  let htmlTitle = "";
  let errorCategory = "unclassified_http_error";
  if (contentType.toLowerCase().includes("json")) {
    if (!body.truncated) {
      try {
        const value = JSON.parse(body.text) as { error?: unknown };
        if (value && typeof value === "object" && value.error && typeof value.error === "object") {
          errorCategory = "structured_json_error";
        }
      } catch {
        // Invalid JSON remains an unclassified transport error.
      }
    }
    if (errorCategory !== "structured_json_error") errorCategory = "unclassified_json_error";
  } else if (contentType.toLowerCase().includes("html")) {
    htmlTitle = redactedHtmlTitle(body.text);
    errorCategory = htmlErrorCategory(htmlTitle, server, cfRay, cfMitigated);
  }
  const cfErrorCode = body.truncated ? "" : strictCloudflareErrorCode(body.text, contentType, hasCloudflareSignal);
  if (cfErrorCode && !contentType.toLowerCase().includes("html")) errorCategory = "cloudflare_error_code";
  const bodyMarker = hasCloudflareSignal && !body.truncated && /\bsorry, you have been blocked\b/i.test(body.text)
    ? "cloudflare_blocked" as const
    : undefined;
  return {
    event: "codex_upstream_rejected",
    upstreamHostname: target.hostname,
    upstreamPath: target.pathname,
    status: response.status,
    contentType,
    ...(contentEncoding ? { contentEncoding } : {}),
    bodyBytes: body.bytes.byteLength,
    bodySha256,
    bodyFormat,
    ...(bodyMarker ? { bodyMarker } : {}),
    ...(server ? { server } : {}),
    ...(cfRay ? { cfRay } : {}),
    ...(cfMitigated ? { cfMitigated } : {}),
    ...(cfErrorCode ? { cfErrorCode } : {}),
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
    ...(htmlTitle ? { htmlTitle } : {}),
    errorCategory,
    ...(body.truncated ? { bodyTruncated: true as const } : {})
  };
}

async function throwUpstreamFailure(response: Response, targetUrl: string, fallback: string): Promise<never> {
  const diagnostic = await collectUpstreamDiagnostic(response, targetUrl);
  console.warn(JSON.stringify(diagnostic));
  if (response.status === 403 && diagnostic.errorCategory === "cloudflare_challenge") {
    throw new GatewayError(
      403,
      "upstream_edge_challenge",
      "Codex 上游的 Cloudflare 校验拒绝了当前运行环境的请求。",
      undefined,
      "server_error",
      diagnostic
    );
  }
  throw upstreamError(response.status, fallback, diagnostic);
}

export function generationAbortError(signal: AbortSignal): GatewayError {
  const message = signal.reason instanceof Error ? signal.reason.message : "";
  if (message === "generation timeout") {
    return new GatewayError(504, "generation_timeout", "生成请求超过本地 5 分钟时限。", undefined, "timeout_error");
  }
  if (message === "account disconnected") {
    return new GatewayError(503, "account_disconnected", "账户已在请求期间断开。", undefined, "authentication_error");
  }
  return new GatewayError(499, "request_cancelled", "生成请求已取消。", undefined, "request_error");
}

export function codexHeaders(credentials: StoredCredentials, accept: string): Headers {
  return new Headers({
    Authorization: `Bearer ${credentials.accessToken}`,
    "ChatGPT-Account-ID": credentials.accountId,
    Accept: accept,
    "Content-Type": "application/json",
    originator: CODEX_ORIGINATOR,
    "User-Agent": CODEX_USER_AGENT,
    version: CLIENT_VERSION
  });
}

export function createUsageRequest(credentials: StoredCredentials): Request {
  return new Request("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers: codexHeaders(credentials, "application/json"),
    redirect: "manual"
  });
}

export function createModelsRequest(credentials: StoredCredentials): Request {
  return new Request(`${CODEX_BASE_URL}/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`, {
    method: "GET",
    headers: codexHeaders(credentials, "application/json"),
    redirect: "manual"
  });
}

export function createResponseRequest(
  credentials: StoredCredentials,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Request {
  return new Request(`${CODEX_BASE_URL}/responses`, {
    method: "POST",
    headers: codexHeaders(credentials, "text/event-stream"),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
    redirect: "manual"
  });
}

export async function fetchUsage(fetcher: OutboundFetch, credentials: StoredCredentials): Promise<Response> {
  const targetUrl = "https://chatgpt.com/backend-api/wham/usage";
  const response = await fetcher(createUsageRequest(credentials));
  await rejectRedirect(response, "额度请求");
  if (!response.ok) await throwUpstreamFailure(response, targetUrl, "额度请求失败");
  return response;
}

export async function fetchModels(fetcher: OutboundFetch, credentials: StoredCredentials): Promise<Response> {
  const targetUrl = `${CODEX_BASE_URL}/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`;
  const response = await fetcher(createModelsRequest(credentials));
  await rejectRedirect(response, "模型列表请求");
  if (!response.ok) await throwUpstreamFailure(response, targetUrl, "模型目录请求失败");
  return response;
}

export async function fetchResponseStream(
  fetcher: OutboundFetch,
  credentials: StoredCredentials,
  body: Record<string, unknown>,
  signal: AbortSignal
): Promise<Response> {
  const targetUrl = `${CODEX_BASE_URL}/responses`;
  let response: Response;
  try {
    response = await fetcher(createResponseRequest(credentials, body, signal));
  } catch {
    if (signal.aborted) throw generationAbortError(signal);
    throw new GatewayError(502, "upstream_network_error", "无法连接 Codex 生成服务。", undefined, "server_error");
  }
  await rejectRedirect(response, "响应生成请求");
  if (!response.ok) await throwUpstreamFailure(response, targetUrl, "生成请求失败");
  if (!response.body) throw new GatewayError(502, "upstream_stream_missing", "上游成功响应没有响应流。", undefined, "server_error");
  return response;
}
