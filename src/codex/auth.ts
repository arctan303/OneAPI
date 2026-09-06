import { GatewayError } from "../errors";
import { CODEX_CLIENT_ID, AUTH_BASE_URL, DEVICE_LOGIN_TTL_MS, DEVICE_VERIFICATION_URL } from "./constants";

export type OutboundFetch = (request: Request) => Promise<Response>;

async function jsonObject(response: Response, label: string): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value as Record<string, unknown>;
  } catch {
    throw new GatewayError(502, "invalid_upstream_response", `${label} 返回了无效 JSON。`, undefined, "server_error");
  }
}

function stringField(body: Record<string, unknown>, key: string, label: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new GatewayError(502, "invalid_upstream_response", `${label} 缺少 ${key}。`, undefined, "server_error");
  }
  return value;
}

function rejectRedirect(response: Response, operation: string): void {
  if (response.status >= 300 && response.status < 400) {
    throw new GatewayError(
      502,
      "upstream_redirect_rejected",
      `${operation} 尝试重定向；为防止凭据跨域外带，网关已拒绝该响应。`
    );
  }
}

export async function requestDeviceCode(fetcher: OutboundFetch): Promise<{
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
}> {
  const response = await fetcher(new Request(`${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    redirect: "manual"
  }));
  rejectRedirect(response, "设备码申请");
  if (response.status === 404) {
    throw new GatewayError(502, "device_auth_not_enabled", "设备码登录未启用。请先在 ChatGPT 安全设置中启用 Device Code，再重试。", undefined, "authentication_error");
  }
  if (!response.ok) throw new GatewayError(502, "device_auth_start_failed", `设备码申请失败（HTTP ${response.status}）。`, undefined, "authentication_error");
  const body = await jsonObject(response, "设备码接口");
  const rawInterval = body.interval;
  const parsed = typeof rawInterval === "string" ? Number.parseInt(rawInterval, 10) : typeof rawInterval === "number" ? rawInterval : Number.NaN;
  const intervalMs = Number.isFinite(parsed) && parsed > 0 ? Math.max(1000, parsed * 1000) : 5000;
  return {
    deviceAuthId: stringField(body, "device_auth_id", "设备码接口"),
    userCode: typeof body.user_code === "string" ? body.user_code : stringField(body, "usercode", "设备码接口"),
    verificationUrl: DEVICE_VERIFICATION_URL,
    intervalMs,
    expiresAt: Date.now() + DEVICE_LOGIN_TTL_MS
  };
}

export type PollResult =
  | { status: "pending" }
  | { status: "authorized"; authorizationCode: string; codeChallenge: string; codeVerifier: string };

export async function pollDeviceCode(fetcher: OutboundFetch, deviceAuthId: string, userCode: string): Promise<PollResult> {
  const response = await fetcher(new Request(`${AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    redirect: "manual"
  }));
  rejectRedirect(response, "设备码查询");
  if (response.status === 403 || response.status === 404) return { status: "pending" };
  if (!response.ok) throw new GatewayError(502, "device_auth_poll_failed", `设备码查询失败（HTTP ${response.status}）。`, undefined, "authentication_error");
  const body = await jsonObject(response, "设备码查询接口");
  return {
    status: "authorized",
    authorizationCode: stringField(body, "authorization_code", "设备码查询接口"),
    codeChallenge: stringField(body, "code_challenge", "设备码查询接口"),
    codeVerifier: stringField(body, "code_verifier", "设备码查询接口")
  };
}

export interface OAuthTokens {
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
}

export async function exchangeDeviceCode(fetcher: OutboundFetch, authorizationCode: string, codeVerifier: string): Promise<Required<OAuthTokens>> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: `${AUTH_BASE_URL}/deviceauth/callback`,
    client_id: CODEX_CLIENT_ID,
    code_verifier: codeVerifier
  });
  const response = await fetcher(new Request(`${AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual"
  }));
  rejectRedirect(response, "设备码令牌交换");
  if (!response.ok) throw new GatewayError(502, "token_exchange_failed", `设备授权换票失败（HTTP ${response.status}）。`, undefined, "authentication_error");
  const body = await jsonObject(response, "OAuth 换票接口");
  return {
    idToken: stringField(body, "id_token", "OAuth 换票接口"),
    accessToken: stringField(body, "access_token", "OAuth 换票接口"),
    refreshToken: stringField(body, "refresh_token", "OAuth 换票接口")
  };
}

export async function refreshOAuthTokens(fetcher: OutboundFetch, refreshToken: string): Promise<OAuthTokens> {
  const response = await fetcher(new Request(`${AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
    redirect: "manual"
  }));
  rejectRedirect(response, "令牌刷新");
  if (!response.ok) {
    let code = "";
    try {
      const body = await response.clone().json() as Record<string, unknown>;
      code = typeof body.error === "string" ? body.error : body.error && typeof body.error === "object" ? String((body.error as Record<string, unknown>).code ?? "") : "";
    } catch {
      // Deliberately do not include the upstream body: it may contain sensitive detail.
    }
    if (response.status === 401 || (response.status === 400 && code.toLowerCase() === "invalid_grant") || ["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"].includes(code)) {
      throw new GatewayError(503, "account_reauthentication_required", "Codex refresh token 已失效或不能安全重用，请重新连接账户。", undefined, "authentication_error");
    }
    throw new GatewayError(502, "token_refresh_failed", `Codex token 刷新失败（HTTP ${response.status}）。`, undefined, "authentication_error");
  }
  const body = await jsonObject(response, "OAuth 刷新接口");
  return {
    idToken: typeof body.id_token === "string" ? body.id_token : undefined,
    accessToken: typeof body.access_token === "string" ? body.access_token : undefined,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined
  };
}
