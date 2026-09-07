import { errorResponse, GatewayError } from "./errors";
import { isLoopbackHost } from "../server/network-config.mjs";
import type {
  AccessConfig,
  ApiKeyPolicy,
  EncryptedValue,
  GatewayIdentity,
  LoginPrivateState,
  LoginPublicState,
  LogSettings,
  ModelCapability,
  RequestLogOutcome,
  RequestLogSummary,
  RequestLogUsage,
  StoredAdminSession,
  StoredApiKey,
  StoredCredentials,
  UsageSnapshot
} from "./types";
import {
  AccessTokenVerifier,
  DEFAULT_ACCESS_CONFIG,
  validateAccessConfig
} from "./access";
import {
  ADMIN_SESSION_COOKIE,
  accountIdFromIdToken,
  accountInfoFromIdToken,
  bearerToken,
  cookieValue,
  decryptJson,
  encryptJson,
  hashSecret,
  jwtExpirationMs,
  randomSecret,
  requireBearer,
  timingSafeEqual
} from "./security";
import { exchangeDeviceCode, pollDeviceCode, refreshOAuthTokens, requestDeviceCode, type OutboundFetch } from "./codex/auth";
import { mockLoginStateDelayMs, mockPersistenceDelayMs, mockUpstreamFetch } from "./codex/mock";
import {
  collectUpstreamDiagnostic,
  createModelsRequest,
  createResponseRequest,
  createUsageRequest,
  fetchModels,
  fetchResponseStream,
  fetchUsage,
  generationAbortError
} from "./codex/upstream";
import { CLIENT_VERSION } from "./codex/constants";
import { probeResponsesWebSocket } from "./codex/websocket-probe";
import { normalizeChat, normalizeResponses, readJsonBody, type NormalizedRequest } from "./protocol/requests";
import { chatEventStream, collectCompletedResponse, responseEventStream, responseToChat } from "./protocol/responses";
import {
  LOCAL_REQUEST_GROUP_HEADER,
  type AccountRequestContext,
  type AccountServiceConfig,
  type AccountServiceOptions,
  type AccountStorage
} from "./runtime/contracts";
import {
  DEFAULT_KEY_POLICY,
  LEGACY_KEY_ID,
  legacyKeyIdentity,
  modelAllowed,
  normalizePolicy,
  publicKey,
  storedKeyIdentity,
  validateKeyName,
  validatePolicyPatch
} from "./controls";
import {
  captureJson,
  DEFAULT_LOG_SETTINGS,
  StreamBodyCapture,
  usageFromResponse,
  validateLogSettingsPatch
} from "./observability";
import { normalizeUsagePayload } from "./usage";
import {
  decodeRelayBody,
  decryptRelayResponse,
  encryptRelayRequest,
  fixedRelayGenerationBody,
  parseRelayKey,
  RELAY_REQUEST_ENVELOPE_MAX_BYTES,
  RELAY_RESPONSE_ENVELOPE_MAX_BYTES,
  relayEnvelopeBytes,
  type RelayOperation,
  type RelayRequest,
  type RelayResponse
} from "./relay-protocol";

const CREDENTIALS_KEY = "credentials";
const CREDENTIAL_VERSION_KEY = "credential-version";
const LOGIN_PUBLIC_KEY = "login-public";
const LOGIN_PRIVATE_KEY = "login-private";
const GENERATION_KEY = "generation";
const MODEL_CACHE_KEY = "model-capabilities";
const LEASES_KEY = "leases";
const REAUTH_KEY = "reauth-required";
const ADMIN_SESSIONS_KEY = "admin-sessions";
const ADMIN_LOGIN_FAILURES_KEY = "admin-login-failures";
const ACCESS_CONFIG_KEY = "access-config";
const API_KEYS_KEY = "api-keys";
const LEGACY_POLICY_KEY = "legacy-key-policy";
const RATE_WINDOWS_KEY = "api-key-rate-windows";
const LOG_SETTINGS_KEY = "log-settings";
const USAGE_CACHE_KEY = "usage-cache";
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
const LEASE_LIMIT = 2;
const MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_LIMIT = 8;
const ADMIN_LOGIN_FAILURE_LIMIT = 5;
const ADMIN_LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const API_KEY_LIMIT = 32;
const USAGE_CACHE_MS = 30_000;
const MODEL_CATALOG_CACHE_MS = 5 * 60 * 1000;
const MODEL_CATALOG_CACHE_VERSION = 2;
const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_LOG_ROWS = 5_000;
const REQUEST_GROUP_LIMIT = 256;
const REQUEST_GROUP_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_GROUP_TTL_MS = GENERATION_TIMEOUT_MS + 5_000;
const ALARM_RETRY_MS = 60_000;
const EMPTY_USAGE: RequestLogUsage = { inputTokens: null, outputTokens: null, totalTokens: null };
const MAX_IMPORT_BYTES = 32 * 1024;
const MAX_IMPORT_TOKEN_LENGTH = 12 * 1024;

interface AdminAuthentication {
  kind: "bearer" | "session" | "access";
  sessionDigest?: string;
  expiresAt: number | null;
}

interface LeaseRecord {
  expiresAt: number;
  keyId: string | null;
}

interface RateWindowRecord {
  windowStart: number;
  count: number;
}

interface RequestGroupState {
  cancelled: boolean;
  leaseId: string | null;
  expiresAt: number;
}

interface ActiveLog {
  id: string;
  settings: LogSettings;
  responseCapture: StreamBodyCapture | null;
  outcome: RequestLogOutcome;
  usage: RequestLogUsage;
  httpStatus: number | null;
}

interface UsageCacheRecord {
  accountId: string;
  snapshot: UsageSnapshot;
}

interface ModelCatalogCacheRecord {
  version: 2;
  accountId: string;
  generation: number;
  fetchedAt: number;
  models: ModelCapability[];
}

interface ModelCatalogLoad {
  accountId: string;
  generation: number;
  promise: Promise<ModelCapability[]>;
}

interface EgressObservation {
  status: number;
  ok: boolean;
  contentType: string;
  bodyBytes: number;
  bodySha256: string;
  diagnostic?: import("./errors").UpstreamDiagnostic;
  modelCount?: number;
  modelIds?: string[];
  usage?: UsageSnapshot["windows"] | RequestLogUsage;
  completed?: boolean;
  responseChars?: number;
}

async function responseFingerprint(response: Response): Promise<{ contentType: string; bodyBytes: number; bodySha256: string }> {
  const raw = new Uint8Array(await response.arrayBuffer());
  const bytes = new Uint8Array(new ArrayBuffer(raw.byteLength));
  bytes.set(raw);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer));
  return {
    contentType: (response.headers.get("content-type") ?? "").replace(/[^\x20-\x7E]/g, "?").slice(0, 100),
    bodyBytes: bytes.byteLength,
    bodySha256: Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("")
  };
}

function gatewayStatus(error: unknown): number {
  return error instanceof GatewayError ? error.status : 500;
}

function gatewayOutcome(error: unknown): RequestLogOutcome {
  return error instanceof GatewayError && (error.code === "request_cancelled" || error.status === 499) ? "cancelled" : "error";
}

function captureStreamBody(stream: ReadableStream<Uint8Array>, capture: StreamBodyCapture): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else {
          capture.append(next.value);
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    }
  });
}

function sessionCookie(value: string, requestUrl: string, maxAgeSeconds: number, trustedLanHttp = false): string {
  const url = new URL(requestUrl);
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || trustedLanHttp))) {
    throw new GatewayError(403, "secure_session_required", "管理会话只允许 HTTPS，或本机 loopback HTTP。", undefined, "permission_error");
  }
  return [
    `${ADMIN_SESSION_COOKIE}=${value}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(url.protocol === "https:" ? ["Secure"] : [])
  ].join("; ");
}

export class AccountService {
  private startPromise: Promise<LoginPublicState> | null = null;
  private pollPromise: Promise<LoginPublicState> | null = null;
  private refreshPromise: Promise<StoredCredentials> | null = null;
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeGenerations = new Map<string, { controller: AbortController; cancel: () => void; finish: () => Promise<void>; groupId?: string }>();
  private readonly requestGroups = new Map<string, RequestGroupState>();
  private modelCatalogLoad: ModelCatalogLoad | null = null;
  private readonly accessVerifier = new AccessTokenVerifier();

  readonly ready: Promise<void>;

  constructor(
    private readonly storage: AccountStorage,
    private readonly env: AccountServiceConfig,
    private readonly options: AccountServiceOptions = {}
  ) {
    this.ready = (async () => {
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        key_id TEXT NOT NULL,
        key_name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration_ms INTEGER,
        http_status INTEGER,
        outcome TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        body_captured INTEGER NOT NULL,
        request_truncated INTEGER NOT NULL,
        response_truncated INTEGER NOT NULL,
        request_body TEXT,
        response_body TEXT,
        body_expires_at INTEGER,
        ignored_parameters TEXT NOT NULL DEFAULT '[]'
      )`);
      const requestLogColumns = storage.sql.exec<{ name: string }>("PRAGMA table_info(request_logs)").toArray();
      if (!requestLogColumns.some((column) => column.name === "ignored_parameters")) {
        storage.sql.exec("ALTER TABLE request_logs ADD COLUMN ignored_parameters TEXT NOT NULL DEFAULT '[]'");
      }
      storage.sql.exec("CREATE INDEX IF NOT EXISTS request_logs_started_idx ON request_logs(started_at DESC)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS request_logs_key_idx ON request_logs(key_id, started_at DESC)");
      await storage.delete(LEASES_KEY);
      await this.scheduleLogAlarmSafely();
    })();
  }

  private performFetch: OutboundFetch = async (request) => {
    if (this.env.MOCK_UPSTREAM === "true") return mockUpstreamFetch(request);
    return this.options.outboundFetch ? this.options.outboundFetch(request) : fetch(request);
  };

  private async timedFetch(request: Request, timeoutMs = 10_000, maxResponseBytes = MAX_CONTROL_RESPONSE_BYTES): Promise<Response> {
    if (this.env.MOCK_UPSTREAM === "true") timeoutMs = Math.min(timeoutMs, 100);
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("upstream timeout")), timeoutMs);
    this.activeControllers.add(controller);
    try {
      const response = await this.performFetch(new Request(request, { signal: controller.signal }));
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) > maxResponseBytes) {
        throw new GatewayError(502, "upstream_response_too_large", "认证或模型响应超过服务端限制。", undefined, "server_error");
      }
      if (!response.body) return response;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxResponseBytes) {
          controller.abort(new Error("control response too large"));
          throw new GatewayError(502, "upstream_response_too_large", "认证或模型响应超过服务端限制。", undefined, "server_error");
        }
        chunks.push(next.value);
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (controller.signal.aborted) throw new GatewayError(504, "upstream_timeout", "上游请求超时或已取消。", undefined, "timeout_error");
      throw new GatewayError(502, "upstream_network_error", "无法连接上游服务。", undefined, "server_error");
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      this.activeControllers.delete(controller);
    }
  }

  private currentGeneration = async (): Promise<number> => (await this.storage.get<number>(GENERATION_KEY)) ?? 0;

  private async nextGeneration(): Promise<number> {
    return this.storage.transaction(async (transaction) => {
      const value = ((await transaction.get<number>(GENERATION_KEY)) ?? 0) + 1;
      await transaction.put(GENERATION_KEY, value);
      return value;
    });
  }

  private async readCredentials(): Promise<StoredCredentials | null> {
    const encrypted = await this.storage.get<EncryptedValue>(CREDENTIALS_KEY);
    if (!encrypted) return null;
    return decryptJson<StoredCredentials>(encrypted, this.env.TOKEN_ENCRYPTION_KEY, "oneapi:credentials:v1");
  }

  private async prepareCredentials(value: StoredCredentials): Promise<EncryptedValue> {
    const encrypted = await encryptJson(value, this.env.TOKEN_ENCRYPTION_KEY, "oneapi:credentials:v1");
    const delayMs = this.env.MOCK_UPSTREAM === "true" ? mockPersistenceDelayMs() : 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return encrypted;
  }

  private async loginStateBarrier(): Promise<void> {
    const delayMs = this.env.MOCK_UPSTREAM === "true" ? mockLoginStateDelayMs() : 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private async activeAdminSessions(now = Date.now()): Promise<StoredAdminSession[]> {
    const stored = (await this.storage.get<StoredAdminSession[]>(ADMIN_SESSIONS_KEY)) ?? [];
    const active = stored.filter((session) => session.expiresAt > now).slice(-ADMIN_SESSION_LIMIT);
    if (active.length !== stored.length) {
      if (active.length === 0) await this.storage.delete(ADMIN_SESSIONS_KEY);
      else await this.storage.put(ADMIN_SESSIONS_KEY, active);
    }
    return active;
  }

  private async accessConfig(): Promise<AccessConfig> {
    const stored = await this.storage.get<AccessConfig>(ACCESS_CONFIG_KEY);
    if (!stored || typeof stored !== "object") return { ...DEFAULT_ACCESS_CONFIG };
    return {
      enabled: stored.enabled === true,
      teamDomain: typeof stored.teamDomain === "string" ? stored.teamDomain : null,
      applicationAud: typeof stored.applicationAud === "string" ? stored.applicationAud : null,
      updatedAt: typeof stored.updatedAt === "number" ? stored.updatedAt : 0,
      revision: typeof stored.revision === "number" ? stored.revision : 0
    };
  }

  private async accessAuthentication(request: Request): Promise<AdminAuthentication> {
    const config = await this.accessConfig();
    const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!assertion) throw new GatewayError(401, "invalid_access_token", "缺少 Cloudflare Access 登录令牌。", undefined, "authentication_error");
    const identity = await this.accessVerifier.verify(assertion, config, (outbound) => this.timedFetch(outbound, 5000, 64 * 1024));
    const latest = await this.accessConfig();
    if (
      latest.revision !== config.revision || latest.enabled !== config.enabled ||
      latest.teamDomain !== config.teamDomain || latest.applicationAud !== config.applicationAud
    ) {
      throw new GatewayError(401, "access_config_changed", "Cloudflare Access 配置已变更，请重新验证登录。", undefined, "authentication_error");
    }
    return { kind: "access", expiresAt: identity.expiresAt };
  }

  private async sessionAuthentication(request: Request): Promise<AdminAuthentication | null> {
    const secret = cookieValue(request, ADMIN_SESSION_COOKIE);
    if (!secret) return null;
    const digest = await hashSecret(secret);
    const session = (await this.activeAdminSessions()).find((candidate) => candidate.digest === digest);
    return session ? { kind: "session", sessionDigest: digest, expiresAt: session.expiresAt } : null;
  }

  private async authenticateAdmin(request: Request): Promise<AdminAuthentication> {
    if (bearerToken(request) !== null) {
      requireBearer(request, this.env.ADMIN_API_KEY, "admin");
      return { kind: "bearer", expiresAt: null };
    }
    let accessFailure: unknown = null;
    if (request.headers.has("Cf-Access-Jwt-Assertion")) {
      try {
        return await this.accessAuthentication(request);
      } catch (error) {
        accessFailure = error;
      }
    }
    const session = await this.sessionAuthentication(request);
    if (!session) {
      if (accessFailure) throw accessFailure;
      throw new GatewayError(401, "invalid_admin_session", "管理员登录已失效，请重新登录。", undefined, "authentication_error");
    }
    return session;
  }

  private async adminSessionStatus(request: Request): Promise<Response> {
    if (bearerToken(request) !== null) {
      requireBearer(request, this.env.ADMIN_API_KEY, "admin");
      return Response.json({ authenticated: true, expiresAt: null, provider: "bearer", logoutUrl: null }, { headers: { "Cache-Control": "no-store" } });
    }
    let authentication: AdminAuthentication | null = null;
    try {
      authentication = await this.authenticateAdmin(request);
    } catch (error) {
      if (!(error instanceof GatewayError) || error.status !== 401) throw error;
    }
    return Response.json({
      authenticated: Boolean(authentication),
      expiresAt: authentication?.expiresAt ?? null,
      provider: authentication?.kind ?? null,
      logoutUrl: authentication?.kind === "access" ? "/cdn-cgi/access/logout" : null
    }, { headers: { "Cache-Control": "no-store" } });
  }

  private async getAccessConfig(): Promise<Response> {
    const { enabled, teamDomain, applicationAud, updatedAt } = await this.accessConfig();
    return Response.json({ enabled, teamDomain, applicationAud, updatedAt }, { headers: { "Cache-Control": "no-store" } });
  }

  private async publicAccessStatus(): Promise<Response> {
    const config = await this.accessConfig();
    let enabled = false;
    if (config.enabled && config.teamDomain && config.applicationAud) {
      try {
        const checked = validateAccessConfig({
          enabled: true,
          teamDomain: config.teamDomain,
          applicationAud: config.applicationAud
        }, config.revision);
        enabled = checked.teamDomain === config.teamDomain && checked.applicationAud === config.applicationAud;
      } catch {
        enabled = false;
      }
    }
    return Response.json({ enabled }, { headers: { "Cache-Control": "no-store" } });
  }

  private async patchAccessConfig(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const current = await this.accessConfig();
    const next = validateAccessConfig(body, current.revision);
    await this.storage.put(ACCESS_CONFIG_KEY, next);
    this.accessVerifier.clear();
    const { enabled, teamDomain, applicationAud, updatedAt } = next;
    return Response.json({ enabled, teamDomain, applicationAud, updatedAt }, { headers: { "Cache-Control": "no-store" } });
  }

  private async createAdminSession(request: Request, context: AccountRequestContext): Promise<Response> {
    const body = await readJsonBody(request);
    if (typeof body.password !== "string" || body.password.length > 1024 || Object.keys(body).some((key) => key !== "password")) {
      throw new GatewayError(400, "invalid_request", "登录只接受管理员口令。", "password");
    }
    const now = Date.now();
    const passwordMatches = Boolean(this.env.ADMIN_API_KEY) && timingSafeEqual(body.password, this.env.ADMIN_API_KEY);
    let rateLimited = false;
    await this.storage.transaction(async (transaction) => {
      const failures = ((await transaction.get<number[]>(ADMIN_LOGIN_FAILURES_KEY)) ?? [])
        .filter((timestamp) => timestamp > now - ADMIN_LOGIN_FAILURE_WINDOW_MS)
        .slice(-ADMIN_LOGIN_FAILURE_LIMIT);
      if (failures.length >= ADMIN_LOGIN_FAILURE_LIMIT) {
        rateLimited = true;
        return;
      }
      if (passwordMatches) await transaction.delete(ADMIN_LOGIN_FAILURES_KEY);
      else await transaction.put(ADMIN_LOGIN_FAILURES_KEY, [...failures, now]);
    });
    if (rateLimited) {
      throw new GatewayError(429, "admin_login_rate_limited", "管理员登录失败次数过多，请稍后重试。", undefined, "rate_limit_error");
    }
    if (!passwordMatches) {
      throw new GatewayError(401, "invalid_admin_password", "管理员口令无效。", undefined, "authentication_error");
    }
    const secret = randomSecret();
    const digest = await hashSecret(secret);
    const expiresAt = now + ADMIN_SESSION_TTL_MS;
    await this.storage.transaction(async (transaction) => {
      const sessions = ((await transaction.get<StoredAdminSession[]>(ADMIN_SESSIONS_KEY)) ?? [])
        .filter((session) => session.expiresAt > now)
        .slice(-(ADMIN_SESSION_LIMIT - 1));
      await transaction.put(ADMIN_SESSIONS_KEY, [...sessions, { digest, createdAt: now, expiresAt }]);
    });
    return Response.json({ authenticated: true, expiresAt }, {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": sessionCookie(secret, request.url, Math.floor(ADMIN_SESSION_TTL_MS / 1000), context.trustedLanHttp === true)
      }
    });
  }

  private async deleteAdminSession(request: Request, authentication: AdminAuthentication, context: AccountRequestContext): Promise<Response> {
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 0) {
      throw new GatewayError(400, "invalid_request", "退出后台不接受参数。", "body");
    }
    if (authentication.kind === "session" && authentication.sessionDigest) {
      await this.storage.transaction(async (transaction) => {
        const sessions = (await transaction.get<StoredAdminSession[]>(ADMIN_SESSIONS_KEY)) ?? [];
        const remaining = sessions.filter((session) => session.digest !== authentication.sessionDigest);
        if (remaining.length === 0) await transaction.delete(ADMIN_SESSIONS_KEY);
        else await transaction.put(ADMIN_SESSIONS_KEY, remaining);
      });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": sessionCookie("", request.url, 0, context.trustedLanHttp === true),
        ...(authentication.kind === "access" ? { "X-OneAPI-Access-Logout": "/cdn-cgi/access/logout" } : {})
      }
    });
  }

  private async importCredentials(request: Request): Promise<Response> {
    if (new URL(request.url).protocol !== "https:") {
      throw new GatewayError(403, "tls_required", "账户导入只允许通过 HTTPS。", undefined, "permission_error");
    }
    requireBearer(request, this.env.ADMIN_API_KEY, "admin");
    const configuredSecret = this.env.ACCOUNT_IMPORT_SECRET ?? "";
    const suppliedSecret = request.headers.get("X-OneAPI-Import-Secret") ?? "";
    if (configuredSecret.length < 32 || configuredSecret.length > 1024) {
      throw new GatewayError(404, "account_import_disabled", "账户导入未启用。", undefined, "permission_error");
    }
    if (suppliedSecret.length > 1024 || !timingSafeEqual(suppliedSecret, configuredSecret)) {
      throw new GatewayError(401, "invalid_import_secret", "账户导入功能密钥无效。", undefined, "authentication_error");
    }
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_IMPORT_BYTES)) {
      throw new GatewayError(413, "request_too_large", "账户导入请求超过 32 KiB 限制。", "body");
    }
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > MAX_IMPORT_BYTES) {
            await reader.cancel("request too large").catch(() => undefined);
            throw new GatewayError(413, "request_too_large", "账户导入请求超过 32 KiB 限制。", "body");
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let body: Record<string, unknown>;
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
      body = value as Record<string, unknown>;
    } catch {
      throw new GatewayError(400, "invalid_json", "账户导入请求必须是有效 UTF-8 JSON 对象。", "body");
    }
    if (
      Object.keys(body).some((key) => !["idToken", "accessToken", "refreshToken"].includes(key)) ||
      !["idToken", "accessToken", "refreshToken"].every((key) => {
        const value = body[key];
        return typeof value === "string" && value.length >= 16 && value.length <= MAX_IMPORT_TOKEN_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(value);
      })
    ) {
      throw new GatewayError(400, "invalid_oauth_import", "账户导入只接受有效的 idToken、accessToken 和 refreshToken。", "body");
    }
    const existing = await this.readCredentials();
    if (existing) throw new GatewayError(409, "account_already_connected", "当前 Worker 已连接账户，不能导入覆盖。", undefined, "invalid_request_error");
    const idToken = body.idToken as string;
    const accessToken = body.accessToken as string;
    const refreshToken = body.refreshToken as string;
    const accountId = accountIdFromIdToken(idToken);
    if (!accountId) throw new GatewayError(400, "invalid_oauth_import", "导入的 idToken 不含有效账户标识。", "idToken");
    const credentials: StoredCredentials = {
      idToken,
      accessToken,
      refreshToken,
      accountId,
      expiresAt: jwtExpirationMs(accessToken),
      lastRefreshAt: Date.now(),
      version: 1
    };
    await fetchModels((outbound) => this.timedFetch(outbound, 5000), credentials);
    const encrypted = await this.prepareCredentials(credentials);
    await this.storage.transaction(async (transaction) => {
      if (await transaction.get(CREDENTIALS_KEY)) {
        throw new GatewayError(409, "account_already_connected", "当前 Worker 已连接账户，不能导入覆盖。", undefined, "invalid_request_error");
      }
      const generation = ((await transaction.get<number>(GENERATION_KEY)) ?? 0) + 1;
      await transaction.put({
        [GENERATION_KEY]: generation,
        [CREDENTIALS_KEY]: encrypted,
        [CREDENTIAL_VERSION_KEY]: credentials.version
      });
      await transaction.delete([LOGIN_PUBLIC_KEY, LOGIN_PRIVATE_KEY, MODEL_CACHE_KEY, LEASES_KEY, REAUTH_KEY, USAGE_CACHE_KEY]);
    });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  private async storedApiKeys(): Promise<StoredApiKey[]> {
    return ((await this.storage.get<StoredApiKey[]>(API_KEYS_KEY)) ?? []).slice(0, API_KEY_LIMIT);
  }

  private async legacyPolicy(): Promise<ApiKeyPolicy> {
    return normalizePolicy(await this.storage.get<Partial<ApiKeyPolicy>>(LEGACY_POLICY_KEY));
  }

  private assertKeyUsable(identity: GatewayIdentity): void {
    if (!identity.enabled) {
      throw new GatewayError(401, "api_key_disabled", "调用密钥已停用。", undefined, "authentication_error");
    }
    if (identity.expiresAt !== null && identity.expiresAt <= Date.now()) {
      throw new GatewayError(401, "api_key_expired", "调用密钥已过期。", undefined, "authentication_error");
    }
  }

  private async authenticateGateway(request: Request): Promise<GatewayIdentity> {
    const supplied = bearerToken(request);
    if (!supplied || (this.env.ADMIN_API_KEY && timingSafeEqual(supplied, this.env.ADMIN_API_KEY))) {
      throw new GatewayError(401, "invalid_api_key", "调用密钥无效。", undefined, "authentication_error");
    }
    if (this.env.GATEWAY_API_KEY && timingSafeEqual(supplied, this.env.GATEWAY_API_KEY)) {
      const identity = legacyKeyIdentity(await this.legacyPolicy());
      this.assertKeyUsable(identity);
      return identity;
    }
    const digest = await hashSecret(supplied);
    const found = (await this.storedApiKeys()).find((key) => key.digest === digest);
    if (!found) throw new GatewayError(401, "invalid_api_key", "调用密钥无效。", undefined, "authentication_error");
    const identity = storedKeyIdentity(found);
    this.assertKeyUsable(identity);
    return identity;
  }

  private async listApiKeys(): Promise<Response> {
    const keys = (await this.storedApiKeys())
      .map(storedKeyIdentity)
      .sort((left, right) => right.createdAt - left.createdAt);
    const data = this.env.GATEWAY_API_KEY
      ? [legacyKeyIdentity(await this.legacyPolicy()), ...keys]
      : keys;
    return Response.json({ data: data.map(publicKey) }, { headers: { "Cache-Control": "no-store" } });
  }

  private async createApiKey(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const allowed = ["name", "enabled", "expiresAt", "modelAccess", "rateLimitPerMinute", "concurrencyLimit"];
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      throw new GatewayError(400, "invalid_request", "创建 API 密钥包含不支持的字段。", "body");
    }
    const name = validateKeyName(body.name);
    const policy = validatePolicyPatch(body, DEFAULT_KEY_POLICY);
    const secret = randomSecret("oneapi_sk_");
    const createdAt = Date.now();
    const key: StoredApiKey = {
      id: crypto.randomUUID(),
      name,
      digest: await hashSecret(secret),
      masked: `oneapi_sk_••••${secret.slice(-4)}`,
      createdAt,
      ...policy
    };
    await this.storage.transaction(async (transaction) => {
      const keys = ((await transaction.get<StoredApiKey[]>(API_KEYS_KEY)) ?? []).slice(0, API_KEY_LIMIT);
      if (keys.length >= API_KEY_LIMIT) {
        throw new GatewayError(409, "api_key_limit_reached", `API 密钥数量上限为 ${API_KEY_LIMIT}。`, undefined, "invalid_request_error");
      }
      if (keys.some((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new GatewayError(409, "api_key_name_conflict", "API 密钥名称已存在。", "name");
      }
      await transaction.put(API_KEYS_KEY, [...keys, key]);
    });
    return Response.json({ ...publicKey(storedKeyIdentity(key)), key: secret }, {
      status: 201,
      headers: { "Cache-Control": "no-store" }
    });
  }

  private async patchApiKey(request: Request, id: string): Promise<Response> {
    const body = await readJsonBody(request);
    const allowed = ["name", "enabled", "expiresAt", "modelAccess", "rateLimitPerMinute", "concurrencyLimit"];
    if (Object.keys(body).length === 0 || Object.keys(body).some((key) => !allowed.includes(key))) {
      throw new GatewayError(400, "invalid_request", "更新 API 密钥只接受支持的非空字段。", "body");
    }
    if (id === LEGACY_KEY_ID) {
      if ("name" in body) throw new GatewayError(400, "invalid_request", "旧环境调用密钥名称不可修改。", "name");
      const next = validatePolicyPatch(body, await this.legacyPolicy());
      await this.storage.put(LEGACY_POLICY_KEY, next);
      return Response.json(publicKey(legacyKeyIdentity(next)), { headers: { "Cache-Control": "no-store" } });
    }

    let updated: StoredApiKey | null = null;
    await this.storage.transaction(async (transaction) => {
      const keys = ((await transaction.get<StoredApiKey[]>(API_KEYS_KEY)) ?? []).slice(0, API_KEY_LIMIT);
      const index = keys.findIndex((key) => key.id === id);
      if (index < 0) throw new GatewayError(404, "api_key_not_found", "没有找到该 API 密钥。", "id");
      const current = keys[index]!;
      const name = "name" in body ? validateKeyName(body.name) : current.name;
      if (keys.some((candidate, candidateIndex) => candidateIndex !== index && candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new GatewayError(409, "api_key_name_conflict", "API 密钥名称已存在。", "name");
      }
      updated = { ...current, name, ...validatePolicyPatch(body, normalizePolicy(current)) };
      keys[index] = updated;
      await transaction.put(API_KEYS_KEY, keys);
    });
    return Response.json(publicKey(storedKeyIdentity(updated!)), { headers: { "Cache-Control": "no-store" } });
  }

  private async deleteApiKey(request: Request, id: string): Promise<Response> {
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 0) {
      throw new GatewayError(400, "invalid_request", "撤销 API 密钥不接受参数。", "body");
    }
    await this.storage.transaction(async (transaction) => {
      const keys = ((await transaction.get<StoredApiKey[]>(API_KEYS_KEY)) ?? []).slice(0, API_KEY_LIMIT);
      const remaining = keys.filter((key) => key.id !== id);
      if (remaining.length === keys.length) {
        throw new GatewayError(404, "api_key_not_found", "没有找到该 API 密钥。", "id");
      }
      if (remaining.length === 0) await transaction.delete(API_KEYS_KEY);
      else await transaction.put(API_KEYS_KEY, remaining);
      const rawRateWindows = (await transaction.get<Record<string, RateWindowRecord | number[]>>(RATE_WINDOWS_KEY)) ?? {};
      if (id in rawRateWindows) {
        delete rawRateWindows[id];
        if (Object.keys(rawRateWindows).length === 0) await transaction.delete(RATE_WINDOWS_KEY);
        else await transaction.put(RATE_WINDOWS_KEY, rawRateWindows);
      }
    });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  private async writeCredentials(value: StoredCredentials): Promise<void> {
    const encrypted = await this.prepareCredentials(value);
    await this.storage.transaction(async (transaction) => {
      await transaction.put({ [CREDENTIALS_KEY]: encrypted, [CREDENTIAL_VERSION_KEY]: value.version });
      await transaction.delete(REAUTH_KEY);
    });
  }

  private async status(): Promise<Response> {
    const credentials = await this.readCredentials();
    let login = await this.storage.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
    if (login?.status === "pending" && login.expiresAt <= Date.now()) {
      const observedId = login.id;
      await this.storage.transaction(async (transaction) => {
        const current = await transaction.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
        if (current?.id === observedId && current.status === "pending" && current.expiresAt <= Date.now()) {
          login = { ...current, status: "expired", userCode: "", error: { code: "device_auth_expired", message: "设备码已过期，请重新发起。" } };
          await transaction.put(LOGIN_PUBLIC_KEY, login);
          await transaction.delete(LOGIN_PRIVATE_KEY);
        } else {
          login = current;
        }
      });
    }
    const reauthentication = await this.storage.get<boolean | { code: string; at: number }>(REAUTH_KEY);
    return Response.json({
      connected: Boolean(credentials),
      account: credentials ? {
        id: credentials.accountId,
        idHint: `…${credentials.accountId.slice(-6)}`,
        ...accountInfoFromIdToken(credentials.idToken),
        tokenExpiresAt: credentials.expiresAt,
        lastRefreshAt: credentials.lastRefreshAt
      } : null,
      login: login ? {
        id: login.id,
        status: login.status,
        verificationUrl: login.verificationUrl,
        userCode: login.userCode,
        expiresAt: login.expiresAt,
        nextPollAt: login.nextPollAt,
        intervalMs: login.intervalMs,
        ...(login.error ? { error: login.error } : {})
      } : null,
      reauthenticationRequired: Boolean(reauthentication),
      ...(reauthentication && typeof reauthentication === "object" ? { reauthenticationReason: reauthentication.code } : {})
    }, { headers: { "Cache-Control": "no-store" } });
  }

  private async usage(force: boolean, includeDiagnostic = false): Promise<Response> {
    const connected = await this.readCredentials();
    const fetchedAt = Date.now();
    if (!connected) {
      await this.storage.delete(USAGE_CACHE_KEY);
      return Response.json({
        available: false,
        fetchedAt,
        lastSuccessAt: null,
        error: { code: "account_not_connected", message: "尚未连接 Codex 账户。" },
        windows: { fiveHour: null, sevenDay: null },
        additional: []
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const cached = await this.storage.get<UsageCacheRecord>(USAGE_CACHE_KEY);
    const sameAccountCache = cached?.accountId === connected.accountId ? cached : null;
    if (!force && sameAccountCache && sameAccountCache.snapshot.fetchedAt > fetchedAt - USAGE_CACHE_MS) {
      return Response.json(sameAccountCache.snapshot, { headers: { "Cache-Control": "no-store" } });
    }
    try {
      let credentials = await this.refreshCredentials();
      let expectedGeneration = await this.currentGeneration();
      let response: Response;
      try {
        response = await fetchUsage((request) => this.timedFetch(request, 5000), credentials);
      } catch (error) {
        if (!(error instanceof GatewayError) || error.code !== "account_reauthentication_required") throw error;
        credentials = await this.refreshCredentials(true);
        expectedGeneration = await this.currentGeneration();
        const retryVersion = credentials.version;
        try {
          response = await fetchUsage((request) => this.timedFetch(request, 5000), credentials);
        } catch (retryError) {
          if (retryError instanceof GatewayError && retryError.code === "account_reauthentication_required") {
            await this.disableRejectedCredentials(expectedGeneration, retryVersion);
          }
          throw retryError;
        }
      }
      const raw = await response.json() as unknown;
      const snapshot = normalizeUsagePayload(raw, fetchedAt);
      const current = await this.readCredentials();
      if (!current || current.accountId !== credentials.accountId || await this.currentGeneration() !== expectedGeneration) {
        throw new GatewayError(409, "usage_superseded", "额度响应到达时账户已变更，旧结果未保存。", undefined, "invalid_request_error");
      }
      await this.storage.put(USAGE_CACHE_KEY, { accountId: credentials.accountId, snapshot } satisfies UsageCacheRecord);
      return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const known = error instanceof GatewayError
        ? error
        : new GatewayError(502, "usage_unavailable", "无法读取官方额度。", undefined, "server_error");
      return Response.json({
        available: false,
        fetchedAt,
        lastSuccessAt: sameAccountCache?.snapshot.lastSuccessAt ?? null,
        error: {
          code: known.code,
          message: known.message,
          ...(includeDiagnostic && known.diagnostic ? { diagnostic: known.diagnostic } : {})
        },
        windows: { fiveHour: null, sevenDay: null },
        additional: []
      }, { headers: { "Cache-Control": "no-store" } });
    }
  }

  private relayConfiguration(): { origin: string; key: string } {
    const origin = this.env.ONEAPI_RELAY_ORIGIN ?? "";
    const key = this.env.ONEAPI_RELAY_KEY ?? "";
    if (!origin || !key) {
      throw new GatewayError(503, "egress_diagnostic_disabled", "出站对照诊断未启用。", undefined, "server_error");
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
      parseRelayKey(key);
    } catch {
      throw new GatewayError(500, "invalid_egress_diagnostic_config", "出站对照诊断配置无效。", undefined, "server_error");
    }
    if (
      origin.length > 512 || origin !== parsed.origin || parsed.protocol !== "https:" ||
      parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash
    ) {
      throw new GatewayError(500, "invalid_egress_diagnostic_config", "出站对照诊断配置无效。", undefined, "server_error");
    }
    return { origin, key };
  }

  private relayRequest(request: Request, operation: RelayOperation, requestId: string): Promise<RelayRequest> {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return (async () => ({
      requestId,
      issuedAt: Date.now(),
      operation,
      headers,
      ...(operation === "models" ? { clientVersion: CLIENT_VERSION } : {}),
      ...(operation === "generate" ? { bodyText: await request.clone().text() } : {})
    }))();
  }

  private async fetchThroughRelay(
    upstreamRequest: Request,
    operation: RelayOperation,
    requestId: string,
    timeoutMs: number
  ): Promise<{ response: Response; protocol: RelayResponse }> {
    const { origin, key } = this.relayConfiguration();
    const envelope = await encryptRelayRequest(key, await this.relayRequest(upstreamRequest, operation, requestId));
    if (relayEnvelopeBytes(envelope) > RELAY_REQUEST_ENVELOPE_MAX_BYTES) {
      throw new GatewayError(500, "relay_request_too_large", "加密 relay 请求超过限制。", undefined, "server_error");
    }
    const relayResponse = await this.timedFetch(new Request(`${origin}/relay`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
      redirect: "manual"
    }), timeoutMs, RELAY_RESPONSE_ENVELOPE_MAX_BYTES);
    if (!relayResponse.ok) {
      throw new GatewayError(502, "relay_http_error", "诊断 relay 拒绝了加密请求。", undefined, "server_error");
    }
    let encrypted: unknown;
    try {
      encrypted = await relayResponse.json();
    } catch {
      throw new GatewayError(502, "invalid_relay_response", "诊断 relay 返回了无效加密响应。", undefined, "server_error");
    }
    let protocol: RelayResponse;
    try {
      protocol = await decryptRelayResponse(key, encrypted);
    } catch {
      throw new GatewayError(502, "invalid_relay_response", "诊断 relay 返回了无效加密响应。", undefined, "server_error");
    }
    if (protocol.requestId !== requestId) {
      throw new GatewayError(502, "relay_response_mismatch", "诊断 relay 响应与当前请求不匹配。", undefined, "server_error");
    }
    const responseBody = decodeRelayBody(protocol);
    const response = new Response(responseBody.byteLength === 0 ? null : responseBody, {
      status: protocol.status,
      headers: protocol.headers
    });
    return { response, protocol };
  }

  private async egressObservation(
    response: Response,
    targetUrl: string,
    operation: Exclude<RelayOperation, "ping">
  ): Promise<EgressObservation> {
    const fingerprint = await responseFingerprint(response.clone());
    const observation: EgressObservation = {
      status: response.status,
      ok: response.ok,
      ...fingerprint
    };
    if (!response.ok) {
      observation.diagnostic = await collectUpstreamDiagnostic(response.clone(), targetUrl);
      return observation;
    }
    if (operation === "models") {
      let raw: unknown;
      try {
        raw = await response.clone().json();
      } catch {
        throw new GatewayError(502, "invalid_models_response", "relay 模型目录不是有效 JSON。", undefined, "server_error");
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new GatewayError(502, "invalid_models_response", "relay 模型目录不是 JSON 对象。", undefined, "server_error");
      }
      const models = this.parseModelCatalog(raw as Record<string, unknown>);
      observation.modelCount = models.length;
      observation.modelIds = models.map((model) => model.id);
    } else if (operation === "usage") {
      let raw: unknown;
      try {
        raw = await response.clone().json();
      } catch {
        throw new GatewayError(502, "invalid_usage_response", "relay 额度响应不是有效 JSON。", undefined, "server_error");
      }
      observation.usage = normalizeUsagePayload(raw).windows;
    } else {
      if (!response.body) throw new GatewayError(502, "upstream_stream_missing", "relay 生成响应没有响应流。", undefined, "server_error");
      const completed = await collectCompletedResponse(response.body);
      observation.completed = completed.status === "completed";
      observation.responseChars = typeof completed.output_text === "string" ? completed.output_text.length : 0;
      observation.usage = usageFromResponse(completed);
    }
    return observation;
  }

  private async diagnoseEgress(request: Request, outerRequestId: string): Promise<Response> {
    const body = await readJsonBody(request);
    if (
      typeof body.operation !== "string" ||
      !["ping", "models", "usage", "generate"].includes(body.operation) ||
      Object.keys(body).some((key) => key !== "operation")
    ) {
      throw new GatewayError(400, "invalid_request", "egress 诊断只接受 operation=ping|models|usage|generate。", "operation");
    }
    const operation = body.operation as RelayOperation;
    this.relayConfiguration();
    if (operation === "ping") {
      const pingRequest = new Request("https://oneapi.invalid/ping", { headers: {} });
      const relay = await this.fetchThroughRelay(pingRequest, operation, outerRequestId, 30_000);
      if (relay.protocol.service !== "oneapi-egress-relay") {
        throw new GatewayError(502, "invalid_relay_identity", "诊断 relay 身份无效。", undefined, "server_error");
      }
      return Response.json({
        operation,
        relay: {
          status: relay.protocol.status,
          ok: relay.protocol.status >= 200 && relay.protocol.status < 300,
          service: relay.protocol.service,
          requestIdBound: true
        }
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const credentials = await this.readCredentials();
    if (!credentials) {
      throw new GatewayError(503, "account_not_connected", "尚未连接 Codex 账户。", undefined, "authentication_error");
    }
    if (operation === "generate") {
      const normalized = normalizeResponses({
        model: "gpt-5.5",
        input: "Reply only EGRESS_OK"
      });
      if (JSON.stringify(normalized.upstream) !== JSON.stringify(fixedRelayGenerationBody())) {
        throw new GatewayError(500, "relay_generation_contract_mismatch", "固定生成诊断契约与当前规范化逻辑不一致。", undefined, "server_error");
      }
      const upstreamRequest = createResponseRequest(credentials, normalized.upstream);
      const relayed = await this.fetchThroughRelay(upstreamRequest, operation, outerRequestId, 60_000);
      return Response.json({
        operation,
        relay: await this.egressObservation(relayed.response, upstreamRequest.url, operation),
        sameCredential: true
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const upstreamRequest = operation === "models" ? createModelsRequest(credentials) : createUsageRequest(credentials);
    const direct = await this.timedFetch(new Request(upstreamRequest), 30_000, 2 * 1024 * 1024);
    const relayed = await this.fetchThroughRelay(upstreamRequest, operation, outerRequestId, 30_000);
    return Response.json({
      operation,
      direct: await this.egressObservation(direct, upstreamRequest.url, operation),
      relay: await this.egressObservation(relayed.response, upstreamRequest.url, operation),
      sameCredential: true
    }, { headers: { "Cache-Control": "no-store" } });
  }

  private async diagnoseWebSocket(request: Request): Promise<Response> {
    if (this.env.ONEAPI_WS_DIAGNOSTIC !== "true") {
      throw new GatewayError(503, "websocket_diagnostic_disabled", "WebSocket 诊断未启用。", undefined, "server_error");
    }
    const url = new URL(request.url);
    if (url.search) throw new GatewayError(400, "invalid_request", "WebSocket 诊断不接受 query。", "query");
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 0) {
      throw new GatewayError(400, "invalid_request", "WebSocket 诊断只接受空 JSON 对象。", "body");
    }
    const credentials = await this.readCredentials();
    if (!credentials) {
      throw new GatewayError(503, "account_not_connected", "尚未连接 Codex 账户。", undefined, "authentication_error");
    }
    const result = await probeResponsesWebSocket(credentials, (outbound) => this.performFetch(outbound));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  }

  private async startLogin(): Promise<LoginPublicState> {
    const existing = await this.storage.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
    if (existing?.status === "pending" && existing.expiresAt > Date.now()) return existing;
    const generation = await this.nextGeneration();
    const result = await requestDeviceCode((request) => this.timedFetch(request));
    if (await this.currentGeneration() !== generation) throw new GatewayError(409, "login_superseded", "登录请求已被取消或替代。", undefined, "invalid_request_error");
    const intervalMs = this.env.MOCK_UPSTREAM === "true" ? 25 : result.intervalMs;
    const publicState: LoginPublicState = {
      id: crypto.randomUUID(),
      status: "pending",
      verificationUrl: result.verificationUrl,
      userCode: result.userCode,
      expiresAt: result.expiresAt,
      nextPollAt: Date.now() + intervalMs,
      intervalMs,
      generation
    };
    const privateState = await encryptJson({ deviceAuthId: result.deviceAuthId } satisfies LoginPrivateState, this.env.TOKEN_ENCRYPTION_KEY, `oneapi:login:${generation}`);
    await this.loginStateBarrier();
    await this.storage.transaction(async (transaction) => {
      const transactionGeneration = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      if (transactionGeneration !== generation) throw new GatewayError(409, "login_superseded", "登录请求已被取消或替代。", undefined, "invalid_request_error");
      await transaction.put({ [LOGIN_PUBLIC_KEY]: publicState, [LOGIN_PRIVATE_KEY]: privateState });
    });
    return publicState;
  }

  private async pollLogin(loginId: string): Promise<LoginPublicState> {
    const current = await this.storage.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
    if (!current || current.id !== loginId) throw new GatewayError(404, "login_not_found", "没有找到该登录请求。", "login_id");
    if (current.status !== "pending") return current;
    if (current.expiresAt <= Date.now()) {
      return this.storage.transaction(async (transaction) => {
        const latest = await transaction.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
        if (!latest || latest.id !== current.id || latest.status !== "pending") {
          throw new GatewayError(409, "login_superseded", "登录查询已被取消或替代。", undefined, "invalid_request_error");
        }
        const expired = { ...latest, status: "expired" as const, userCode: "", error: { code: "device_auth_expired", message: "设备码已过期，请重新发起。" } };
        await transaction.put(LOGIN_PUBLIC_KEY, expired);
        await transaction.delete(LOGIN_PRIVATE_KEY);
        return expired;
      });
    }
    if (current.nextPollAt > Date.now()) {
      throw new GatewayError(429, "poll_too_soon", "设备码查询过于频繁，请等待 nextPollAt。", undefined, "rate_limit_error");
    }
    const encrypted = await this.storage.get<EncryptedValue>(LOGIN_PRIVATE_KEY);
    if (!encrypted) throw new GatewayError(503, "login_state_corrupt", "登录内部状态缺失，请取消后重试。", undefined, "server_error");
    const privateState = await decryptJson<LoginPrivateState>(encrypted, this.env.TOKEN_ENCRYPTION_KEY, `oneapi:login:${current.generation}`);
    const waiting = { ...current, nextPollAt: Date.now() + current.intervalMs };
    await this.loginStateBarrier();
    await this.storage.transaction(async (transaction) => {
      const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      const login = await transaction.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
      if (generation !== current.generation || !login || login.id !== current.id || login.status !== "pending") {
        throw new GatewayError(409, "login_superseded", "登录查询已被取消或替代。", undefined, "invalid_request_error");
      }
      await transaction.put(LOGIN_PUBLIC_KEY, waiting);
    });
    const poll = await pollDeviceCode((request) => this.timedFetch(request), privateState.deviceAuthId, current.userCode);
    if (poll.status === "pending") return waiting;
    const tokens = await exchangeDeviceCode((request) => this.timedFetch(request), poll.authorizationCode, poll.codeVerifier);
    const latest = await this.storage.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
    if (!latest || latest.generation !== current.generation || latest.status !== "pending" || await this.currentGeneration() !== current.generation) {
      throw new GatewayError(409, "login_superseded", "登录响应到达时请求已被取消或替代，未保存凭据。", undefined, "invalid_request_error");
    }
    const accountId = accountIdFromIdToken(tokens.idToken);
    if (!accountId) throw new GatewayError(502, "account_id_missing", "可信 OAuth 响应未包含 ChatGPT account id，未保存凭据。", undefined, "authentication_error");
    const credentials: StoredCredentials = {
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountId,
      expiresAt: jwtExpirationMs(tokens.accessToken),
      lastRefreshAt: Date.now(),
      version: 1
    };
    const encryptedCredentials = await this.prepareCredentials(credentials);
    let connected: LoginPublicState | undefined;
    await this.storage.transaction(async (transaction) => {
      const transactionGeneration = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      const transactionLogin = await transaction.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
      if (transactionGeneration !== current.generation || !transactionLogin || transactionLogin.generation !== current.generation || transactionLogin.status !== "pending") {
        throw new GatewayError(409, "login_superseded", "登录响应到达时请求已被取消或替代，未保存凭据。", undefined, "invalid_request_error");
      }
      connected = { ...transactionLogin, status: "connected", userCode: "", nextPollAt: 0 };
      await transaction.put({
        [CREDENTIALS_KEY]: encryptedCredentials,
        [CREDENTIAL_VERSION_KEY]: credentials.version,
        [LOGIN_PUBLIC_KEY]: connected
      });
      await transaction.delete([LOGIN_PRIVATE_KEY, REAUTH_KEY]);
    });
    if (!connected) throw new GatewayError(500, "credential_commit_failed", "凭据事务未完成。", undefined, "server_error");
    return connected;
  }

  private async cancelLogin(loginId: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
      if (!current || current.id !== loginId) throw new GatewayError(404, "login_not_found", "没有找到该登录请求。", "login_id");
      const generation = ((await transaction.get<number>(GENERATION_KEY)) ?? 0) + 1;
      await transaction.put({
        [GENERATION_KEY]: generation,
        [LOGIN_PUBLIC_KEY]: { ...current, status: "cancelled", userCode: "", nextPollAt: 0 }
      });
      await transaction.delete(LOGIN_PRIVATE_KEY);
    });
  }

  private async disconnect(): Promise<void> {
    for (const controller of this.activeControllers) controller.abort(new Error("account disconnected"));
    await this.storage.transaction(async (transaction) => {
      const generation = ((await transaction.get<number>(GENERATION_KEY)) ?? 0) + 1;
      await transaction.put(GENERATION_KEY, generation);
      await transaction.delete([CREDENTIALS_KEY, CREDENTIAL_VERSION_KEY, LOGIN_PUBLIC_KEY, LOGIN_PRIVATE_KEY, MODEL_CACHE_KEY, LEASES_KEY, REAUTH_KEY, USAGE_CACHE_KEY]);
    });
  }

  private async cancelGeneration(leaseId: string): Promise<void> {
    const generation = this.activeGenerations.get(leaseId);
    if (!generation) return;
    generation.cancel();
    await generation.finish();
  }

  private pruneRequestGroups(now = Date.now()): void {
    for (const [groupId, state] of this.requestGroups) {
      if (state.expiresAt <= now && state.leaseId === null) this.requestGroups.delete(groupId);
    }
  }

  private openRequestGroup(groupId: string): void {
    const now = Date.now();
    this.pruneRequestGroups(now);
    const current = this.requestGroups.get(groupId);
    if (current) {
      current.expiresAt = now + REQUEST_GROUP_TTL_MS;
      return;
    }
    if (this.requestGroups.size >= REQUEST_GROUP_LIMIT) {
      throw new GatewayError(503, "request_group_capacity", "本地请求组容量已满。", undefined, "server_error");
    }
    this.requestGroups.set(groupId, { cancelled: false, leaseId: null, expiresAt: now + REQUEST_GROUP_TTL_MS });
  }

  private bindRequestGroup(groupId: string | undefined, leaseId: string): boolean {
    if (!groupId) return false;
    const state = this.requestGroups.get(groupId);
    if (!state) return false;
    state.leaseId = leaseId;
    state.expiresAt = Date.now() + REQUEST_GROUP_TTL_MS;
    return state.cancelled;
  }

  private unbindRequestGroup(groupId: string | undefined, leaseId: string): void {
    if (!groupId) return;
    const state = this.requestGroups.get(groupId);
    if (state?.leaseId === leaseId) state.leaseId = null;
  }

  private async cancelRequestGroup(groupId: string): Promise<void> {
    const now = Date.now();
    this.pruneRequestGroups(now);
    const state = this.requestGroups.get(groupId);
    if (!state) return;
    state.cancelled = true;
    state.expiresAt = now + REQUEST_GROUP_TTL_MS;
    if (state.leaseId) await this.cancelGeneration(state.leaseId);
  }

  private closeRequestGroup(groupId: string): void {
    this.requestGroups.delete(groupId);
  }

  private async disableRejectedCredentials(expectedGeneration: number, expectedVersion: number): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      const version = await transaction.get<number>(CREDENTIAL_VERSION_KEY);
      if (generation !== expectedGeneration || version !== expectedVersion) return;
      await transaction.delete([CREDENTIALS_KEY, CREDENTIAL_VERSION_KEY, USAGE_CACHE_KEY]);
      await transaction.put(REAUTH_KEY, { code: "refreshed_token_rejected", at: Date.now() });
    });
  }

  private async refreshCredentials(force = false): Promise<StoredCredentials> {
    const credentials = await this.readCredentials();
    if (!credentials) throw new GatewayError(503, "account_not_connected", "尚未连接 Codex 账户。", undefined, "authentication_error");
    const due = credentials.expiresAt !== null
      ? credentials.expiresAt <= Date.now() + 5 * 60 * 1000
      : credentials.lastRefreshAt <= Date.now() - 8 * 24 * 60 * 60 * 1000;
    if (!force && !due) return credentials;
    if (this.refreshPromise) return this.refreshPromise;
    const expectedGeneration = await this.currentGeneration();
    this.refreshPromise = (async () => {
      try {
        const updated = await refreshOAuthTokens((request) => this.timedFetch(request), credentials.refreshToken);
        const current = await this.readCredentials();
        if (!current || current.version !== credentials.version || await this.currentGeneration() !== expectedGeneration) {
          throw new GatewayError(409, "refresh_superseded", "账户在刷新期间已变更，旧刷新结果未写回。", undefined, "invalid_request_error");
        }
        const next: StoredCredentials = {
          ...current,
          idToken: updated.idToken ?? current.idToken,
          accessToken: updated.accessToken ?? current.accessToken,
          refreshToken: updated.refreshToken ?? current.refreshToken,
          accountId: updated.idToken ? accountIdFromIdToken(updated.idToken) ?? current.accountId : current.accountId,
          expiresAt: updated.accessToken ? jwtExpirationMs(updated.accessToken) : current.expiresAt,
          lastRefreshAt: Date.now(),
          version: current.version + 1
        };
        const encrypted = await this.prepareCredentials(next);
        await this.storage.transaction(async (transaction) => {
          const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
          const version = await transaction.get<number>(CREDENTIAL_VERSION_KEY);
          if (generation !== expectedGeneration || version !== credentials.version) {
            throw new GatewayError(409, "refresh_superseded", "账户在刷新期间已变更，旧刷新结果未写回。", undefined, "invalid_request_error");
          }
          await transaction.put({ [CREDENTIALS_KEY]: encrypted, [CREDENTIAL_VERSION_KEY]: next.version });
          await transaction.delete(REAUTH_KEY);
        });
        return next;
      } catch (error) {
        if (error instanceof GatewayError && error.code === "refresh_superseded") throw error;
        if (await this.currentGeneration() !== expectedGeneration) {
          throw new GatewayError(409, "refresh_superseded", "账户在刷新期间已断开或变更，旧刷新结果未写回。", undefined, "invalid_request_error");
        }
        const explicit = error instanceof GatewayError && error.code === "account_reauthentication_required";
        const reason = explicit ? "account_reauthentication_required" : "refresh_result_uncertain";
        let superseded = false;
        await this.storage.transaction(async (transaction) => {
          const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
          const version = await transaction.get<number>(CREDENTIAL_VERSION_KEY);
          if (generation !== expectedGeneration || version !== credentials.version) {
            superseded = true;
            return;
          }
          await transaction.delete([CREDENTIALS_KEY, CREDENTIAL_VERSION_KEY, USAGE_CACHE_KEY]);
          await transaction.put(REAUTH_KEY, { code: reason, at: Date.now() });
        });
        if (superseded) throw new GatewayError(409, "refresh_superseded", "账户在刷新期间已断开或变更，旧刷新结果未写回。", undefined, "invalid_request_error");
        if (explicit) throw error;
        throw new GatewayError(
          503,
          "refresh_result_uncertain",
          "Codex token 刷新结果不确定；为避免重复使用 refresh token，凭据已停用，请重新连接账户。",
          undefined,
          "authentication_error"
        );
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  private async logSettings(): Promise<LogSettings> {
    const stored = await this.storage.get<Partial<LogSettings>>(LOG_SETTINGS_KEY);
    return {
      summaryRetentionDays: typeof stored?.summaryRetentionDays === "number" ? stored.summaryRetentionDays : DEFAULT_LOG_SETTINGS.summaryRetentionDays,
      bodyRetentionDays: typeof stored?.bodyRetentionDays === "number" ? stored.bodyRetentionDays : DEFAULT_LOG_SETTINGS.bodyRetentionDays,
      captureBodies: stored?.captureBodies === true,
      maxBodyBytes: typeof stored?.maxBodyBytes === "number" ? stored.maxBodyBytes : DEFAULT_LOG_SETTINGS.maxBodyBytes
    };
  }

  private async getLogSettings(): Promise<Response> {
    return Response.json(await this.logSettings(), { headers: { "Cache-Control": "no-store" } });
  }

  private async patchLogSettings(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const next = validateLogSettingsPatch(body, await this.logSettings());
    await this.storage.put(LOG_SETTINGS_KEY, next);
    this.pruneLogs(next);
    await this.scheduleLogAlarmSafely(next);
    return Response.json(next, { headers: { "Cache-Control": "no-store" } });
  }

  private pruneLogs(settings: LogSettings): void {
    const now = Date.now();
    const summaryCutoff = now - settings.summaryRetentionDays * 24 * 60 * 60 * 1000;
    const bodyTtlMs = settings.bodyRetentionDays * 24 * 60 * 60 * 1000;
    const orphanCutoff = now - GENERATION_TIMEOUT_MS - 5_000;
    this.storage.sql.exec(
      "UPDATE request_logs SET completed_at = ?, duration_ms = ? - started_at, outcome = 'incomplete' WHERE completed_at IS NULL AND started_at < ?",
      now,
      now,
      orphanCutoff
    );
    this.storage.sql.exec("DELETE FROM request_logs WHERE completed_at IS NOT NULL AND started_at < ?", summaryCutoff);
    this.storage.sql.exec(
      "DELETE FROM request_logs WHERE completed_at IS NOT NULL AND id IN (SELECT id FROM request_logs WHERE completed_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?)",
      MAX_LOG_ROWS
    );
    this.storage.sql.exec(
      "UPDATE request_logs SET body_expires_at = CASE " +
      "WHEN body_expires_at IS NULL OR body_expires_at > started_at + ? THEN started_at + ? " +
      "ELSE body_expires_at END " +
      "WHERE body_captured = 1 AND (request_body IS NOT NULL OR response_body IS NOT NULL)",
      bodyTtlMs,
      bodyTtlMs
    );
    this.storage.sql.exec(
      "UPDATE request_logs SET request_body = NULL, response_body = NULL " +
      "WHERE body_captured = 1 AND (request_body IS NOT NULL OR response_body IS NOT NULL) AND body_expires_at <= ?",
      now
    );
  }

  private async scheduleLogAlarm(settings?: LogSettings): Promise<void> {
    settings ??= await this.logSettings();
    const summaryTtlMs = settings.summaryRetentionDays * 24 * 60 * 60 * 1000;
    const bodyTtlMs = settings.bodyRetentionDays * 24 * 60 * 60 * 1000;
    const deadlines: number[] = [];
    const addDeadline = (value: number | null | undefined) => {
      if (typeof value === "number" && Number.isFinite(value)) deadlines.push(value);
    };
    addDeadline(this.storage.sql.exec<{ deadline: number | null }>(
      "SELECT MIN(CASE WHEN body_expires_at IS NULL OR body_expires_at > started_at + ? " +
      "THEN started_at + ? ELSE body_expires_at END) AS deadline " +
      "FROM request_logs WHERE body_captured = 1 AND (request_body IS NOT NULL OR response_body IS NOT NULL)",
      bodyTtlMs,
      bodyTtlMs
    ).toArray()[0]?.deadline);
    const summaryStart = this.storage.sql.exec<{ startedAt: number | null }>(
      "SELECT MIN(started_at) AS startedAt FROM request_logs WHERE completed_at IS NOT NULL"
    ).toArray()[0]?.startedAt;
    if (typeof summaryStart === "number") addDeadline(summaryStart + summaryTtlMs);
    const activeStart = this.storage.sql.exec<{ startedAt: number | null }>(
      "SELECT MIN(started_at) AS startedAt FROM request_logs WHERE completed_at IS NULL"
    ).toArray()[0]?.startedAt;
    if (typeof activeStart === "number") addDeadline(activeStart + REQUEST_GROUP_TTL_MS);
    if (deadlines.length === 0) {
      await this.storage.deleteAlarm();
      return;
    }
    await this.storage.setAlarm(Math.max(Date.now() + 1_000, Math.min(...deadlines)));
  }

  private async scheduleLogAlarmSafely(settings?: LogSettings): Promise<void> {
    try {
      await this.scheduleLogAlarm(settings);
    } catch {
      console.warn(JSON.stringify({ event: "request_log_alarm_failed", stage: "schedule" }));
      try {
        await this.storage.setAlarm(Date.now() + ALARM_RETRY_MS);
      } catch {
        console.warn(JSON.stringify({ event: "request_log_alarm_failed", stage: "retry" }));
      }
    }
  }

  async alarm(): Promise<void> {
    await this.ready;
    try {
      const settings = await this.logSettings();
      this.pruneLogs(settings);
      await this.scheduleLogAlarm(settings);
    } catch {
      console.warn(JSON.stringify({ event: "request_log_alarm_failed", stage: "run" }));
      try {
        await this.storage.setAlarm(Date.now() + ALARM_RETRY_MS);
      } catch {
        console.warn(JSON.stringify({ event: "request_log_alarm_failed", stage: "retry" }));
      }
    }
  }

  private async startRequestLog(
    identity: GatewayIdentity,
    protocol: "responses" | "chat",
    model: string,
    requestId: string,
    requestBody: Record<string, unknown>,
    ignoredParameters: string[]
  ): Promise<ActiveLog | null> {
    try {
      const settings = await this.logSettings();
      this.pruneLogs(settings);
      const startedAt = Date.now();
      const captured = settings.captureBodies ? captureJson(requestBody, settings.maxBodyBytes) : { body: null, truncated: false };
      const id = crypto.randomUUID();
      this.storage.sql.exec(
        `INSERT INTO request_logs (
          id, request_id, key_id, key_name, protocol, model, started_at, completed_at, duration_ms,
          http_status, outcome, input_tokens, output_tokens, total_tokens, body_captured,
          request_truncated, response_truncated, request_body, response_body, body_expires_at, ignored_parameters
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'incomplete', NULL, NULL, NULL, ?, ?, 0, ?, NULL, ?, ?)`,
        id,
        requestId,
        identity.id,
        identity.name,
        protocol,
        model,
        startedAt,
        settings.captureBodies ? 1 : 0,
        captured.truncated ? 1 : 0,
        captured.body === null ? null : JSON.stringify(captured.body),
        settings.captureBodies ? startedAt + settings.bodyRetentionDays * 24 * 60 * 60 * 1000 : null,
        JSON.stringify(ignoredParameters)
      );
      await this.scheduleLogAlarmSafely(settings);
      return {
        id,
        settings,
        responseCapture: null,
        outcome: "incomplete",
        usage: { ...EMPTY_USAGE },
        httpStatus: null
      };
    } catch (error) {
      console.warn(JSON.stringify({ event: "request_log_write_failed", stage: "start" }));
      return null;
    }
  }

  private async finishRequestLog(active: ActiveLog | null, responseBody?: unknown): Promise<void> {
    if (!active) return;
    try {
      const rows = this.storage.sql.exec<Record<string, string | number | null>>(
        "SELECT started_at AS startedAt, completed_at AS completedAt, body_expires_at AS bodyExpiresAt FROM request_logs WHERE id = ?",
        active.id
      ).toArray();
      const stored = rows[0];
      if (!stored || stored.completedAt !== null) return;
      const completedAt = Date.now();
      const currentSettings = await this.logSettings();
      const storedBodyExpiry = stored.bodyExpiresAt === null ? null : Number(stored.bodyExpiresAt);
      const currentBodyExpiry = Number(stored.startedAt) + currentSettings.bodyRetentionDays * 24 * 60 * 60 * 1000;
      const effectiveBodyExpiry = storedBodyExpiry === null ? null : Math.min(storedBodyExpiry, currentBodyExpiry);
      const bodyRetained = active.settings.captureBodies
        && effectiveBodyExpiry !== null
        && effectiveBodyExpiry > completedAt;
      let captured = { body: null as Record<string, unknown> | null, truncated: false };
      if (bodyRetained) {
        captured = active.responseCapture
          ? { body: active.responseCapture.body(), truncated: active.responseCapture.truncated }
          : captureJson(responseBody, active.settings.maxBodyBytes);
      }
      this.storage.sql.exec(
        `UPDATE request_logs SET completed_at = ?, duration_ms = ?, http_status = ?, outcome = ?,
          input_tokens = ?, output_tokens = ?, total_tokens = ?, response_truncated = ?, response_body = ?, body_expires_at = ?
          WHERE id = ?`,
        completedAt,
        Math.max(0, completedAt - Number(stored.startedAt)),
        active.httpStatus,
        active.outcome,
        active.usage.inputTokens,
        active.usage.outputTokens,
        active.usage.totalTokens,
        captured.truncated ? 1 : 0,
        captured.body === null ? null : JSON.stringify(captured.body),
        effectiveBodyExpiry,
        active.id
      );
      await this.scheduleLogAlarmSafely(currentSettings);
    } catch (error) {
      console.warn(JSON.stringify({ event: "request_log_write_failed", stage: "finish" }));
    }
  }

  private logSummary(row: Record<string, string | number | null>): RequestLogSummary {
    let ignoredParameters: string[] = [];
    if (typeof row.ignoredParameters === "string") {
      try {
        const parsed = JSON.parse(row.ignoredParameters) as unknown;
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) ignoredParameters = [...new Set(parsed)];
      } catch {}
    }
    return {
      id: String(row.id),
      requestId: String(row.requestId),
      keyId: String(row.keyId),
      keyName: String(row.keyName),
      protocol: row.protocol === "chat" ? "chat" : "responses",
      model: String(row.model),
      startedAt: Number(row.startedAt),
      completedAt: row.completedAt === null ? null : Number(row.completedAt),
      durationMs: row.durationMs === null ? null : Number(row.durationMs),
      httpStatus: row.httpStatus === null ? null : Number(row.httpStatus),
      outcome: String(row.outcome) as RequestLogOutcome,
      usage: {
        inputTokens: row.inputTokens === null ? null : Number(row.inputTokens),
        outputTokens: row.outputTokens === null ? null : Number(row.outputTokens),
        totalTokens: row.totalTokens === null ? null : Number(row.totalTokens)
      },
      bodyCaptured: row.bodyCaptured === 1,
      bodyExpired: row.bodyCaptured === 1 && row.bodyExpiresAt !== null && Number(row.bodyExpiresAt) <= Date.now(),
      requestTruncated: row.requestTruncated === 1,
      responseTruncated: row.responseTruncated === 1,
      ignoredParameters
    };
  }

  private logSelect(): string {
    return `SELECT id, request_id AS requestId, key_id AS keyId, key_name AS keyName, protocol, model,
      started_at AS startedAt, completed_at AS completedAt, duration_ms AS durationMs, http_status AS httpStatus,
      outcome, input_tokens AS inputTokens, output_tokens AS outputTokens, total_tokens AS totalTokens,
      body_captured AS bodyCaptured, body_expires_at AS bodyExpiresAt,
      request_truncated AS requestTruncated, response_truncated AS responseTruncated,
      ignored_parameters AS ignoredParameters
      FROM request_logs`;
  }

  private async listLogs(url: URL): Promise<Response> {
    const settings = await this.logSettings();
    this.pruneLogs(settings);
    await this.scheduleLogAlarmSafely(settings);
    const keyId = url.searchParams.get("keyId");
    const model = url.searchParams.get("model");
    const outcome = url.searchParams.get("outcome");
    if (outcome && !["completed", "error", "cancelled", "incomplete"].includes(outcome)) {
      throw new GatewayError(400, "invalid_log_filter", "outcome 筛选值无效。", "outcome");
    }
    const integerQuery = (name: string): number | null => {
      const raw = url.searchParams.get(name);
      if (raw === null) return null;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) throw new GatewayError(400, "invalid_log_filter", `${name} 必须是非负整数毫秒时间戳。`, name);
      return value;
    };
    const from = integerQuery("from");
    const to = integerQuery("to");
    if (from !== null && to !== null && from > to) throw new GatewayError(400, "invalid_log_filter", "from 不得晚于 to。", "from");
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new GatewayError(400, "invalid_log_filter", "limit 必须是 1 到 100 的整数。", "limit");
    const rawCursor = url.searchParams.get("cursor");
    const offset = rawCursor === null ? 0 : Number(rawCursor);
    if (!Number.isInteger(offset) || offset < 0) throw new GatewayError(400, "invalid_log_filter", "cursor 无效。", "cursor");

    const where: string[] = [];
    const params: Array<string | number> = [];
    if (keyId) { where.push("key_id = ?"); params.push(keyId); }
    if (model) { where.push("model = ?"); params.push(model); }
    if (outcome) { where.push("outcome = ?"); params.push(outcome); }
    if (from !== null) { where.push("started_at >= ?"); params.push(from); }
    if (to !== null) { where.push("started_at <= ?"); params.push(to); }
    const query = `${this.logSelect()} ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`;
    const rows = this.storage.sql.exec<Record<string, string | number | null>>(query, ...params, limit + 1, offset).toArray();
    const hasNext = rows.length > limit;
    const data = rows.slice(0, limit).map((row) => this.logSummary(row));
    return Response.json({ data, nextCursor: hasNext ? String(offset + limit) : null }, {
      headers: { "Cache-Control": "no-store" }
    });
  }

  private async getLog(id: string): Promise<Response> {
    const settings = await this.logSettings();
    this.pruneLogs(settings);
    await this.scheduleLogAlarmSafely(settings);
    const rows = this.storage.sql.exec<Record<string, string | number | null>>(
      this.logSelect().replace(
        " FROM request_logs",
        ", request_body AS requestBody, response_body AS responseBody FROM request_logs"
      ) + " WHERE id = ?",
      id
    ).toArray();
    const row = rows[0];
    if (!row) throw new GatewayError(404, "request_log_not_found", "没有找到该调用日志。", "id");
    const parseBody = (value: string | number | null): Record<string, unknown> | null => {
      if (typeof value !== "string") return null;
      try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
      } catch {
        return { unavailable: true };
      }
    };
    return Response.json({
      ...this.logSummary(row),
      requestBody: parseBody(row.requestBody),
      responseBody: parseBody(row.responseBody),
      bodyExpiresAt: row.bodyExpiresAt === null ? null : Number(row.bodyExpiresAt)
    }, { headers: { "Cache-Control": "no-store" } });
  }

  private parseModelCatalog(body: Record<string, unknown>): ModelCapability[] {
    if (!Array.isArray(body.models)) {
      throw new GatewayError(502, "invalid_models_response", "上游模型目录缺少 models 数组。", undefined, "server_error");
    }
    const capabilities: ModelCapability[] = [];
    for (const raw of body.models) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const model = raw as Record<string, unknown>;
      if (typeof model.slug !== "string" || model.visibility === "hide") continue;
      let supportedEfforts: string[] | null = null;
      if (Array.isArray(model.supported_reasoning_levels)) {
        const parsed: string[] = [];
        let valid = true;
        for (const rawLevel of model.supported_reasoning_levels) {
          if (!rawLevel || typeof rawLevel !== "object" || Array.isArray(rawLevel)) {
            valid = false;
            break;
          }
          const effort = (rawLevel as Record<string, unknown>).effort;
          if (typeof effort !== "string" || !REASONING_EFFORT_PATTERN.test(effort)) {
            valid = false;
            break;
          }
          if (!parsed.includes(effort)) parsed.push(effort);
        }
        if (valid) supportedEfforts = parsed;
      }
      const rawDefault = model.default_reasoning_level;
      const defaultEffort = typeof rawDefault === "string"
        && supportedEfforts !== null
        && supportedEfforts.includes(rawDefault)
        ? rawDefault
        : null;
      capabilities.push({ id: model.slug, reasoning: { supportedEfforts, defaultEffort } });
    }
    return capabilities;
  }

  private async fetchModelCatalog(): Promise<ModelCapability[]> {
    let credentials = await this.refreshCredentials();
    let expectedGeneration = await this.currentGeneration();
    let response: Response;
    try {
      response = await fetchModels((request) => this.timedFetch(request, 5000), credentials);
    } catch (error) {
      if (!(error instanceof GatewayError) || error.code !== "account_reauthentication_required") throw error;
      credentials = await this.refreshCredentials(true);
      expectedGeneration = await this.currentGeneration();
      try {
        response = await fetchModels((request) => this.timedFetch(request, 5000), credentials);
      } catch (retryError) {
        if (retryError instanceof GatewayError && retryError.code === "account_reauthentication_required") {
          await this.disableRejectedCredentials(expectedGeneration, credentials.version);
        }
        throw retryError;
      }
    }
    let body: Record<string, unknown>;
    try {
      const parsed = await response.json() as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new GatewayError(502, "invalid_models_response", "上游模型目录不是 JSON 对象。", undefined, "server_error");
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(502, "invalid_models_response", "上游模型目录不是有效 JSON。", undefined, "server_error");
    }
    const models = this.parseModelCatalog(body);
    const cache: ModelCatalogCacheRecord = {
      version: MODEL_CATALOG_CACHE_VERSION,
      accountId: credentials.accountId,
      generation: expectedGeneration,
      fetchedAt: Date.now(),
      models
    };
    await this.storage.transaction(async (transaction) => {
      const currentGeneration = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      const currentVersion = await transaction.get<number>(CREDENTIAL_VERSION_KEY);
      if (currentGeneration !== expectedGeneration || currentVersion !== credentials.version) {
        throw new GatewayError(409, "models_superseded", "模型目录响应到达时账户已变更，旧结果未保存。", undefined, "invalid_request_error");
      }
      await transaction.put(MODEL_CACHE_KEY, cache);
    });
    return models;
  }

  private validModelCatalogCache(
    value: unknown,
    accountId: string,
    generation: number
  ): value is ModelCatalogCacheRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const cache = value as Partial<ModelCatalogCacheRecord>;
    return cache.version === MODEL_CATALOG_CACHE_VERSION
      && cache.accountId === accountId
      && cache.generation === generation
      && typeof cache.fetchedAt === "number"
      && Number.isFinite(cache.fetchedAt)
      && cache.fetchedAt <= Date.now()
      && cache.fetchedAt > Date.now() - MODEL_CATALOG_CACHE_MS
      && Array.isArray(cache.models)
      && cache.models.every((model) => {
        if (!model || typeof model.id !== "string" || !model.reasoning) return false;
        const supported = model.reasoning.supportedEfforts;
        if (supported !== null && (!Array.isArray(supported) || !supported.every((effort) => typeof effort === "string" && REASONING_EFFORT_PATTERN.test(effort)))) return false;
        return model.reasoning.defaultEffort === null
          || (typeof model.reasoning.defaultEffort === "string" && supported !== null && supported.includes(model.reasoning.defaultEffort));
      });
  }

  private async loadModelCatalog(): Promise<ModelCapability[]> {
    const credentials = await this.readCredentials();
    if (!credentials) {
      throw new GatewayError(503, "account_not_connected", "尚未连接 Codex 账户。", undefined, "authentication_error");
    }
    const generation = await this.currentGeneration();
    const cached = await this.storage.get<unknown>(MODEL_CACHE_KEY);
    if (this.validModelCatalogCache(cached, credentials.accountId, generation)) return cached.models;
    if (this.modelCatalogLoad?.accountId === credentials.accountId && this.modelCatalogLoad.generation === generation) {
      return this.modelCatalogLoad.promise;
    }
    const load: ModelCatalogLoad = {
      accountId: credentials.accountId,
      generation,
      promise: this.fetchModelCatalog()
    };
    this.modelCatalogLoad = load;
    try {
      return await load.promise;
    } finally {
      if (this.modelCatalogLoad === load) this.modelCatalogLoad = null;
    }
  }

  private modelListResponse(capabilities: ModelCapability[], identity?: GatewayIdentity): Response {
    const visible = identity ? capabilities.filter((model) => modelAllowed(identity, model.id)) : capabilities;
    return Response.json({
      object: "list",
      data: visible.map((model) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: "openai",
        capabilities: {
          reasoning: {
            supported_efforts: model.reasoning.supportedEfforts,
            default_effort: model.reasoning.defaultEffort
          }
        }
      }))
    }, { headers: { "Cache-Control": "no-store" } });
  }

  private async listModels(identity?: GatewayIdentity): Promise<Response> {
    return this.modelListResponse(await this.fetchModelCatalog(), identity);
  }

  private async validateReasoning(request: NormalizedRequest, chat: boolean): Promise<void> {
    const reasoning = request.upstream.reasoning;
    if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return;
    const effort = (reasoning as Record<string, unknown>).effort;
    if (typeof effort !== "string") return;
    const param = chat ? "reasoning_effort" : "reasoning.effort";
    const model = (await this.loadModelCatalog()).find((entry) => entry.id === request.model);
    if (!model || model.reasoning.supportedEfforts === null) {
      throw new GatewayError(
        400,
        "reasoning_capability_unavailable",
        "当前官方模型目录未提供模型 " + request.model + " 的 reasoning effort 能力，无法确认显式档位 " + effort + "。",
        param
      );
    }
    if (!model.reasoning.supportedEfforts.includes(effort)) {
      throw new GatewayError(
        400,
        "unsupported_reasoning_effort",
        "模型 " + request.model + " 不支持 reasoning effort " + effort + "；当前目录支持：" + (model.reasoning.supportedEfforts.join(", ") || "无") + "。",
        param
      );
    }
  }

  private async acquireLease(identity?: GatewayIdentity): Promise<string> {
    const now = Date.now();
    const id = crypto.randomUUID();
    await this.storage.transaction(async (transaction) => {
      const rawLeases = (await transaction.get<Record<string, number | LeaseRecord>>(LEASES_KEY)) ?? {};
      const leases: Record<string, LeaseRecord> = {};
      for (const [leaseId, raw] of Object.entries(rawLeases)) {
        const record = typeof raw === "number" ? { expiresAt: raw, keyId: null } : raw;
        if (record.expiresAt > now) leases[leaseId] = record;
      }
      if (Object.keys(leases).length >= LEASE_LIMIT) {
        throw new GatewayError(429, "local_concurrency_limit", `本地并发生成上限为 ${LEASE_LIMIT}。`, undefined, "rate_limit_error");
      }
      if (identity && identity.concurrencyLimit !== null) {
        const activeForKey = Object.values(leases).filter((lease) => lease.keyId === identity.id).length;
        if (activeForKey >= identity.concurrencyLimit) {
          throw new GatewayError(429, "api_key_concurrency_limit", "该调用密钥已达到并发上限。", undefined, "rate_limit_error");
        }
      }
      const activeSince = now - 60_000;
      const rawRateWindows = (await transaction.get<Record<string, RateWindowRecord | number[]>>(RATE_WINDOWS_KEY)) ?? {};
      const rateWindows: Record<string, RateWindowRecord> = {};
      for (const [keyId, raw] of Object.entries(rawRateWindows)) {
        if (Array.isArray(raw)) {
          const active = raw.filter((timestamp) => timestamp > activeSince && timestamp <= now);
          if (active.length > 0) rateWindows[keyId] = { windowStart: Math.min(...active), count: active.length };
        } else if (raw.windowStart > activeSince && raw.windowStart <= now && Number.isSafeInteger(raw.count) && raw.count > 0) {
          rateWindows[keyId] = { windowStart: raw.windowStart, count: raw.count };
        }
      }
      if (identity && identity.rateLimitPerMinute !== null) {
        const current = rateWindows[identity.id] ?? { windowStart: now, count: 0 };
        if (current.count >= identity.rateLimitPerMinute) {
          throw new GatewayError(429, "api_key_rate_limit", "该调用密钥已达到每分钟请求上限。", undefined, "rate_limit_error");
        }
        rateWindows[identity.id] = { windowStart: current.windowStart, count: current.count + 1 };
      }
      leases[id] = { expiresAt: now + GENERATION_TIMEOUT_MS + 5000, keyId: identity?.id ?? null };
      await transaction.put(LEASES_KEY, leases);
      if (Object.keys(rateWindows).length === 0) await transaction.delete(RATE_WINDOWS_KEY);
      else await transaction.put(RATE_WINDOWS_KEY, rateWindows);
    });
    return id;
  }

  private async releaseLease(id: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const leases = (await transaction.get<Record<string, number | LeaseRecord>>(LEASES_KEY)) ?? {};
      if (!(id in leases)) return;
      delete leases[id];
      if (Object.keys(leases).length === 0) await transaction.delete(LEASES_KEY);
      else await transaction.put(LEASES_KEY, leases);
    });
  }

  private async handleGeneration(request: Request, chat: boolean, identity: GatewayIdentity | undefined, requestId: string): Promise<Response> {
    const body = await readJsonBody(request);
    const normalized = chat ? normalizeChat(body) : normalizeResponses(body);
    const ignoredHeader: Record<string, string> = normalized.ignoredParameters.length > 0
      ? { "X-OneAPI-Ignored-Parameters": normalized.ignoredParameters.join(", ") }
      : {};
    const requestGroupId = request.headers.get(LOCAL_REQUEST_GROUP_HEADER) ?? undefined;
    const generationFetch: OutboundFetch = (upstreamRequest) => this.env.MOCK_UPSTREAM === "true"
      ? mockUpstreamFetch(upstreamRequest)
      : this.options.outboundFetch ? this.options.outboundFetch(upstreamRequest, requestGroupId) : fetch(upstreamRequest);
    const activeLog = identity
      ? await this.startRequestLog(identity, chat ? "chat" : "responses", normalized.model, requestId, body, normalized.ignoredParameters)
      : null;
    let leaseId: string | null = null;
    let controller: AbortController | null = null;
    let finished = false;

    const errorBody = (error: unknown): Record<string, unknown> => {
      const known = error instanceof GatewayError
        ? error
        : new GatewayError(500, "internal_error", "网关发生内部错误。", undefined, "server_error");
      return { error: { message: known.message, type: known.type, code: known.code, ...(known.param ? { param: known.param } : {}) } };
    };
    const finish = async (responseBody?: unknown) => {
      if (finished) return;
      finished = true;
      if (controller) {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", clientAbort);
        this.activeControllers.delete(controller);
      }
      if (leaseId) {
        this.activeGenerations.delete(leaseId);
        this.unbindRequestGroup(requestGroupId, leaseId);
        await this.releaseLease(leaseId);
      }
      await this.finishRequestLog(activeLog, responseBody);
    };
    let timeout: ReturnType<typeof setTimeout>;
    const clientAbort = () => controller?.abort(request.signal.reason);

    try {
      if (identity && !modelAllowed(identity, normalized.model)) {
        throw new GatewayError(403, "model_not_allowed", `模型 ${normalized.model} 不在该调用密钥允许范围内。`, "model", "permission_error");
      }
      await this.validateReasoning(normalized, chat);
      leaseId = await this.acquireLease(identity);
      controller = new AbortController();
      const generationTimeoutMs = this.env.MOCK_UPSTREAM === "true" ? 100 : GENERATION_TIMEOUT_MS;
      timeout = setTimeout(() => controller?.abort(new Error("generation timeout")), generationTimeoutMs);
      request.signal.addEventListener("abort", clientAbort, { once: true });
      this.activeControllers.add(controller);
      const generation = {
        controller,
        cancel: () => {
          if (activeLog) {
            if (activeLog.outcome === "incomplete") activeLog.outcome = "cancelled";
            activeLog.httpStatus ??= 499;
          }
          controller?.abort(new Error("client cancelled"));
        },
        finish,
        ...(requestGroupId ? { groupId: requestGroupId } : {})
      };
      this.activeGenerations.set(leaseId, generation);
      if (this.bindRequestGroup(requestGroupId, leaseId)) {
        generation.cancel();
        throw generationAbortError(controller.signal);
      }

      let credentials = await this.refreshCredentials();
      let upstream: Response;
      try {
        upstream = await fetchResponseStream(generationFetch, credentials, normalized.upstream, controller.signal);
      } catch (error) {
        if (!(error instanceof GatewayError) || error.code !== "account_reauthentication_required") throw error;
        credentials = await this.refreshCredentials(true);
        const retryGeneration = await this.currentGeneration();
        try {
          upstream = await fetchResponseStream(generationFetch, credentials, normalized.upstream, controller.signal);
        } catch (retryError) {
          if (retryError instanceof GatewayError && retryError.code === "account_reauthentication_required") {
            await this.disableRejectedCredentials(retryGeneration, credentials.version);
          }
          throw retryError;
        }
      }
      if (!upstream.body) throw new GatewayError(502, "upstream_stream_missing", "上游未返回响应流。", undefined, "server_error");

      if (!normalized.stream) {
        const completed = await collectCompletedResponse(upstream.body);
        const value = chat ? responseToChat(completed, normalized.model) : completed;
        if (activeLog) {
          activeLog.httpStatus = 200;
          activeLog.outcome = "completed";
          activeLog.usage = usageFromResponse(value);
        }
        await finish(value);
        return Response.json(value, { headers: { "Cache-Control": "no-store", ...ignoredHeader } });
      }

      if (activeLog) {
        activeLog.httpStatus = 200;
        activeLog.responseCapture = activeLog.settings.captureBodies
          ? new StreamBodyCapture(activeLog.settings.maxBodyBytes, "sse")
          : null;
      }
      const lifecycle = {
        abort: () => {
          if (activeLog?.outcome === "incomplete") activeLog.outcome = "cancelled";
          controller?.abort(new Error("client cancelled"));
        },
        finish,
        failure: () => controller?.signal.aborted ? generationAbortError(controller.signal) : undefined,
        failed: (error: unknown) => {
          if (activeLog) activeLog.outcome = gatewayOutcome(error);
        },
        terminal: (type: string, payload: Record<string, unknown>) => {
          if (!activeLog) return;
          const response = payload.response;
          if (type === "response.completed") {
            activeLog.outcome = "completed";
            activeLog.usage = usageFromResponse(response);
          } else if (type === "response.incomplete") {
            activeLog.outcome = "incomplete";
            activeLog.usage = usageFromResponse(response);
          } else {
            activeLog.outcome = "error";
            activeLog.usage = usageFromResponse(response);
          }
        }
      };
      const adapted = chat
        ? chatEventStream(upstream.body, normalized.model, normalized.chat?.includeUsage ?? false, lifecycle)
        : responseEventStream(upstream.body, lifecycle);
      const stream = activeLog?.responseCapture ? captureStreamBody(adapted, activeLog.responseCapture) : adapted;
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-OneAPI-Internal-Lease": leaseId,
          ...ignoredHeader
        }
      });
    } catch (error) {
      let failure = error;
      if (controller?.signal.aborted) failure = generationAbortError(controller.signal);
      if (activeLog) {
        activeLog.httpStatus ??= gatewayStatus(failure);
        activeLog.outcome = gatewayOutcome(failure);
      }
      controller?.abort(failure);
      await finish(errorBody(failure));
      throw failure;
    }
  }

  async dispose(): Promise<void> {
    for (const controller of this.activeControllers) controller.abort(new Error("runtime disposed"));
    const generations = [...this.activeGenerations.values()];
    for (const generation of generations) generation.cancel();
    await Promise.allSettled(generations.map((generation) => generation.finish()));
    this.requestGroups.clear();
    this.accessVerifier.clear();
  }
  async fetch(request: Request, context: AccountRequestContext = {}): Promise<Response> {
    await this.ready;
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    let adminAuthentication: AdminAuthentication | null = null;
    try {
      if (url.pathname === "/__internal/cancel") {
        requireBearer(request, this.env.TOKEN_ENCRYPTION_KEY, "internal");
        if (request.method !== "POST") throw new GatewayError(405, "method_not_allowed", "内部取消接口只接受 POST。", undefined, "invalid_request_error");
        const leaseId = url.searchParams.get("lease_id");
        if (!leaseId) throw new GatewayError(400, "invalid_request", "缺少内部 lease_id。", "lease_id");
        await this.cancelGeneration(leaseId);
        return new Response(null, { status: 204 });
      }
      const groupControl = /^\/__internal\/request-groups\/(open|cancel|close)$/.exec(url.pathname);
      if (groupControl) {
        requireBearer(request, this.env.TOKEN_ENCRYPTION_KEY, "internal");
        if (request.method !== "POST") throw new GatewayError(405, "method_not_allowed", "内部请求组接口只接受 POST。", undefined, "invalid_request_error");
        if ([...url.searchParams.keys()].some((key) => key !== "group_id")) {
          throw new GatewayError(400, "invalid_request", "内部请求组接口只接受 group_id。", "group_id");
        }
        const groupId = url.searchParams.get("group_id")?.toLowerCase() ?? "";
        if (!REQUEST_GROUP_PATTERN.test(groupId)) throw new GatewayError(400, "invalid_request", "内部请求组标识无效。", "group_id");
        if (groupControl[1] === "open") this.openRequestGroup(groupId);
        else if (groupControl[1] === "cancel") await this.cancelRequestGroup(groupId);
        else this.closeRequestGroup(groupId);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && url.pathname === "/access/status") {
        return await this.publicAccessStatus();
      }
      if (request.method === "POST" && url.pathname === "/admin/account/import") {
        return await this.importCredentials(request);
      }
      let gatewayIdentity: GatewayIdentity | null = null;
      if (url.pathname.startsWith("/admin/")) {
        if (request.method === "POST" && url.pathname === "/admin/session") return await this.createAdminSession(request, context);
        if (request.method === "GET" && url.pathname === "/admin/session") return await this.adminSessionStatus(request);
        adminAuthentication = await this.authenticateAdmin(request);
        if (request.method === "DELETE" && url.pathname === "/admin/session") {
          return await this.deleteAdminSession(request, adminAuthentication, context);
        }
      } else if (url.pathname.startsWith("/v1/")) {
        gatewayIdentity = await this.authenticateGateway(request);
      } else {
        throw new GatewayError(404, "not_found", "接口不存在。", undefined, "invalid_request_error");
      }

      if (request.method === "GET" && url.pathname === "/admin/status") return this.status();
      if (request.method === "GET" && url.pathname === "/admin/access") return await this.getAccessConfig();
      if (request.method === "PATCH" && url.pathname === "/admin/access") return await this.patchAccessConfig(request);
      if (request.method === "GET" && url.pathname === "/admin/access/login") {
        const access = await this.accessAuthentication(request);
        if (access.kind !== "access") throw new GatewayError(401, "invalid_access_token", "Cloudflare Access 登录无效。", undefined, "authentication_error");
        return Response.redirect(new URL("/", request.url).href, 303);
      }
      if (request.method === "GET" && url.pathname === "/admin/usage") {
        if ([...url.searchParams.keys()].some((key) => key !== "refresh") || !["", "true", "false"].includes(url.searchParams.get("refresh") ?? "")) {
          throw new GatewayError(400, "invalid_request", "usage 只接受 refresh=true|false。", "refresh");
        }
        return await this.usage(url.searchParams.get("refresh") === "true", adminAuthentication !== null);
      }
      if (request.method === "GET" && url.pathname === "/admin/api-keys") return await this.listApiKeys();
      if (request.method === "POST" && url.pathname === "/admin/api-keys") return await this.createApiKey(request);
      const apiKeyMatch = /^\/admin\/api-keys\/(legacy|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url.pathname);
      if (request.method === "PATCH" && apiKeyMatch) return await this.patchApiKey(request, apiKeyMatch[1]!);
      if (request.method === "DELETE" && apiKeyMatch && apiKeyMatch[1] !== LEGACY_KEY_ID) return await this.deleteApiKey(request, apiKeyMatch[1]!);
      if (request.method === "GET" && url.pathname === "/admin/log-settings") return await this.getLogSettings();
      if (request.method === "PATCH" && url.pathname === "/admin/log-settings") return await this.patchLogSettings(request);
      if (request.method === "GET" && url.pathname === "/admin/logs") return await this.listLogs(url);
      const logMatch = /^\/admin\/logs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url.pathname);
      if (request.method === "GET" && logMatch) return await this.getLog(logMatch[1]!);
      if (request.method === "POST" && url.pathname === "/admin/device/start") {
        const body = await readJsonBody(request);
        if (Object.keys(body).length !== 0) throw new GatewayError(400, "invalid_request", "device/start 不接受参数。", "body");
        if (!this.startPromise) this.startPromise = this.startLogin().finally(() => { this.startPromise = null; });
        return Response.json(await this.startPromise, { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/admin/device/poll") {
        const body = await readJsonBody(request);
        if (typeof body.login_id !== "string" || Object.keys(body).some((key) => key !== "login_id")) throw new GatewayError(400, "invalid_request", "poll 只接受 login_id。", "login_id");
        if (!this.pollPromise) this.pollPromise = this.pollLogin(body.login_id).finally(() => { this.pollPromise = null; });
        return Response.json(await this.pollPromise, { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/admin/device/cancel") {
        const body = await readJsonBody(request);
        if (typeof body.login_id !== "string" || Object.keys(body).some((key) => key !== "login_id")) throw new GatewayError(400, "invalid_request", "cancel 只接受 login_id。", "login_id");
        await this.cancelLogin(body.login_id);
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/admin/disconnect") {
        const body = await readJsonBody(request);
        if (Object.keys(body).length !== 0) throw new GatewayError(400, "invalid_request", "disconnect 不接受参数。", "body");
        await this.disconnect();
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/admin/diagnostics/egress") {
        return await this.diagnoseEgress(request, requestId);
      }
      if (request.method === "POST" && url.pathname === "/admin/diagnostics/websocket") {
        return await this.diagnoseWebSocket(request);
      }
      if (request.method === "GET" && url.pathname === "/admin/test/models") return await this.listModels();
      if (request.method === "POST" && url.pathname === "/admin/test/responses") return await this.handleGeneration(request, false, undefined, requestId);
      if (request.method === "POST" && url.pathname === "/admin/test/chat/completions") return await this.handleGeneration(request, true, undefined, requestId);
      if (request.method === "GET" && url.pathname === "/v1/models") return await this.listModels(gatewayIdentity!);
      if (request.method === "POST" && url.pathname === "/v1/responses") return await this.handleGeneration(request, false, gatewayIdentity!, requestId);
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") return await this.handleGeneration(request, true, gatewayIdentity!, requestId);
      throw new GatewayError(405, "method_not_allowed", "请求方法或接口不受支持。", undefined, "invalid_request_error");
    } catch (error) {
      return errorResponse(error, requestId, adminAuthentication !== null);
    }
  }
}
