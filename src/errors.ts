export interface UpstreamDiagnostic {
  event: "codex_upstream_rejected";
  upstreamHostname: string;
  upstreamPath: string;
  status: number;
  contentType: string;
  contentEncoding?: "gzip" | "br" | "deflate" | "zstd" | "identity";
  bodyBytes: number;
  bodySha256: string;
  bodyFormat: "empty" | "gzip_magic" | "zstd_magic" | "html_text" | "text" | "binary";
  bodyMarker?: "cloudflare_blocked";
  server?: string;
  cfRay?: string;
  cfMitigated?: string;
  cfErrorCode?: string;
  upstreamRequestId?: string;
  htmlTitle?: string;
  errorCategory: string;
  bodyTruncated?: true;
}

export class GatewayError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly param?: string;
  readonly diagnostic?: UpstreamDiagnostic;

  constructor(
    status: number,
    code: string,
    message: string,
    param?: string,
    type = "invalid_request_error",
    diagnostic?: UpstreamDiagnostic
  ) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
    this.diagnostic = diagnostic;
  }
}

export function errorResponse(error: unknown, requestId?: string, includeDiagnostic = false): Response {
  const known = error instanceof GatewayError
    ? error
    : new GatewayError(500, "internal_error", "网关发生内部错误。", undefined, "server_error");
  const body = {
    error: {
      message: known.message,
      type: known.type,
      code: known.code,
      ...(known.param ? { param: known.param } : {}),
      ...(includeDiagnostic && known.diagnostic ? { diagnostic: known.diagnostic } : {})
    }
  };
  return Response.json(body, {
    status: known.status,
    headers: {
      "Cache-Control": "no-store",
      ...(requestId ? { "x-request-id": requestId } : {})
    }
  });
}

export function upstreamError(status: number, fallback = "上游请求失败。", diagnostic?: UpstreamDiagnostic): GatewayError {
  if (status === 401) {
    return new GatewayError(503, "account_reauthentication_required", "Codex 登录已失效，请重新连接账户。", undefined, "authentication_error", diagnostic);
  }
  if (status === 403) {
    return new GatewayError(
      403,
      "upstream_http_403",
      "Codex 上游返回 HTTP 403；未获得可确认的业务错误类别。",
      undefined,
      "server_error",
      diagnostic
    );
  }
  if (status === 429) {
    return new GatewayError(429, "upstream_rate_limited", "Codex 上游当前限流，请稍后重试。", undefined, "rate_limit_error", diagnostic);
  }
  return new GatewayError(502, "upstream_error", `${fallback}（HTTP ${status}）`, undefined, "server_error", diagnostic);
}
