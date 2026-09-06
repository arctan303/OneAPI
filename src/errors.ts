export class GatewayError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly param?: string;

  constructor(status: number, code: string, message: string, param?: string, type = "invalid_request_error") {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
  }
}

export function errorResponse(error: unknown, requestId?: string): Response {
  const known = error instanceof GatewayError
    ? error
    : new GatewayError(500, "internal_error", "网关发生内部错误。", undefined, "server_error");
  const body = {
    error: {
      message: known.message,
      type: known.type,
      code: known.code,
      ...(known.param ? { param: known.param } : {})
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

export function upstreamError(status: number, fallback = "上游请求失败。"): GatewayError {
  if (status === 401) {
    return new GatewayError(503, "account_reauthentication_required", "Codex 登录已失效，请重新连接账户。", undefined, "authentication_error");
  }
  if (status === 403) {
    return new GatewayError(
      403,
      "upstream_http_403",
      "Codex 上游返回 HTTP 403；未获得可确认的业务错误类别。",
      undefined,
      "server_error"
    );
  }
  if (status === 429) {
    return new GatewayError(429, "upstream_rate_limited", "Codex 上游当前限流，请稍后重试。", undefined, "rate_limit_error");
  }
  return new GatewayError(502, "upstream_error", `${fallback}（HTTP ${status}）`, undefined, "server_error");
}
