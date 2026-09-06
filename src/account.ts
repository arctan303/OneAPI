import { DurableObject } from "cloudflare:workers";
import { errorResponse, GatewayError } from "./errors";
import type { EncryptedValue, Env, LoginPrivateState, LoginPublicState, ModelCapability, StoredAdminSession, StoredApiKey, StoredCredentials } from "./types";
import {
  ADMIN_SESSION_COOKIE,
  accountIdFromIdToken,
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
import { fetchModels, fetchResponseStream, generationAbortError } from "./codex/upstream";
import { normalizeChat, normalizeResponses, readJsonBody, type NormalizedRequest } from "./protocol/requests";
import { chatEventStream, collectCompletedResponse, responseEventStream, responseToChat } from "./protocol/responses";
import { fetchWithLocalOutbound, LOCAL_REQUEST_GROUP_HEADER } from "./local-outbound";

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
const API_KEYS_KEY = "api-keys";
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
const LEASE_LIMIT = 2;
const MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_LIMIT = 8;
const ADMIN_LOGIN_FAILURE_LIMIT = 5;
const ADMIN_LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const API_KEY_LIMIT = 32;

interface AdminAuthentication {
  kind: "bearer" | "session";
  sessionDigest?: string;
  expiresAt: number | null;
}

function sessionCookie(value: string, requestUrl: string, maxAgeSeconds: number): string {
  const url = new URL(requestUrl);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
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

export class AccountDurableObject extends DurableObject<Env> {
  private startPromise: Promise<LoginPublicState> | null = null;
  private pollPromise: Promise<LoginPublicState> | null = null;
  private refreshPromise: Promise<StoredCredentials> | null = null;
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeGenerations = new Map<string, { controller: AbortController; finish: () => Promise<void> }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await ctx.storage.delete(LEASES_KEY);
    });
  }

  private performFetch: OutboundFetch = async (request) => {
    if (this.env.MOCK_UPSTREAM === "true") return mockUpstreamFetch(request);
    return fetchWithLocalOutbound(this.env.ONEAPI_LOCAL_OUTBOUND, request);
  };

  private async timedFetch(request: Request, timeoutMs = 10_000): Promise<Response> {
    if (this.env.MOCK_UPSTREAM === "true") timeoutMs = Math.min(timeoutMs, 100);
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("upstream timeout")), timeoutMs);
    this.activeControllers.add(controller);
    try {
      const response = await this.performFetch(new Request(request, { signal: controller.signal }));
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) > MAX_CONTROL_RESPONSE_BYTES) {
        throw new GatewayError(502, "upstream_response_too_large", "认证或模型响应超过本地 1 MiB 限制。", undefined, "server_error");
      }
      if (!response.body) return response;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_CONTROL_RESPONSE_BYTES) {
          controller.abort(new Error("control response too large"));
          throw new GatewayError(502, "upstream_response_too_large", "认证或模型响应超过本地 1 MiB 限制。", undefined, "server_error");
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

  private currentGeneration = async (): Promise<number> => (await this.ctx.storage.get<number>(GENERATION_KEY)) ?? 0;

  private async nextGeneration(): Promise<number> {
    return this.ctx.storage.transaction(async (transaction) => {
      const value = ((await transaction.get<number>(GENERATION_KEY)) ?? 0) + 1;
      await transaction.put(GENERATION_KEY, value);
      return value;
    });
  }

  private async readCredentials(): Promise<StoredCredentials | null> {
    const encrypted = await this.ctx.storage.get<EncryptedValue>(CREDENTIALS_KEY);
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
    const stored = (await this.ctx.storage.get<StoredAdminSession[]>(ADMIN_SESSIONS_KEY)) ?? [];
    const active = stored.filter((session) => session.expiresAt > now).slice(-ADMIN_SESSION_LIMIT);
    if (active.length !== stored.length) {
      if (active.length === 0) await this.ctx.storage.delete(ADMIN_SESSIONS_KEY);
      else await this.ctx.storage.put(ADMIN_SESSIONS_KEY, active);
    }
    return active;
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
    const session = await this.sessionAuthentication(request);
    if (!session) {
      throw new GatewayError(401, "invalid_admin_session", "管理员登录已失效，请重新登录。", undefined, "authentication_error");
    }
    return session;
  }

  private async adminSessionStatus(request: Request): Promise<Response> {
    if (bearerToken(request) !== null) {
      requireBearer(request, this.env.ADMIN_API_KEY, "admin");
      return Response.json({ authenticated: true, expiresAt: null }, { headers: { "Cache-Control": "no-store" } });
    }
    const session = await this.sessionAuthentication(request);
    return Response.json({
      authenticated: Boolean(session),
      expiresAt: session?.expiresAt ?? null
    }, { headers: { "Cache-Control": "no-store" } });
  }

  private async createAdminSession(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (typeof body.password !== "string" || body.password.length > 1024 || Object.keys(body).some((key) => key !== "password")) {
      throw new GatewayError(400, "invalid_request", "登录只接受管理员口令。", "password");
    }
    const now = Date.now();
    const passwordMatches = Boolean(this.env.ADMIN_API_KEY) && timingSafeEqual(body.password, this.env.ADMIN_API_KEY);
    let rateLimited = false;
    await this.ctx.storage.transaction(async (transaction) => {
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
    await this.ctx.storage.transaction(async (transaction) => {
      const sessions = ((await transaction.get<StoredAdminSession[]>(ADMIN_SESSIONS_KEY)) ?? [])
        .filter((session) => session.expiresAt > now)
        .slice(-(ADMIN_SESSION_LIMIT - 1));
      await transaction.put(ADMIN_SESSIONS_KEY, [...sessions, { digest, createdAt: now, expiresAt }]);
    });
    return Response.json({ authenticated: true, expiresAt }, {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": sessionCookie(secret, request.url, Math.floor(ADMIN_SESSION_TTL_MS / 1000))
      }
    });
  }

  private async deleteAdminSession(request: Request, authentication: AdminAuthentication): Promise<Response> {
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 0) {
      throw new GatewayError(400, "invalid_request", "退出后台不接受参数。", "body");
    }
    if (authentication.kind === "session" && authentication.sessionDigest) {
      await this.ctx.storage.transaction(async (transaction) => {
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
        "Set-Cookie": sessionCookie("", request.url, 0)
      }
    });
  }

  private async storedApiKeys(): Promise<StoredApiKey[]> {
    return ((await this.ctx.storage.get<StoredApiKey[]>(API_KEYS_KEY)) ?? []).slice(0, API_KEY_LIMIT);
  }

  private async authenticateGateway(request: Request): Promise<void> {
    const supplied = bearerToken(request);
    if (!supplied || (this.env.ADMIN_API_KEY && timingSafeEqual(supplied, this.env.ADMIN_API_KEY))) {
      throw new GatewayError(401, "invalid_api_key", "调用密钥无效。", undefined, "authentication_error");
    }
    if (this.env.GATEWAY_API_KEY && timingSafeEqual(supplied, this.env.GATEWAY_API_KEY)) return;
    const digest = await hashSecret(supplied);
    if ((await this.storedApiKeys()).some((key) => key.digest === digest)) return;
    throw new GatewayError(401, "invalid_api_key", "调用密钥无效。", undefined, "authentication_error");
  }

  private async listApiKeys(): Promise<Response> {
    const keys = await this.storedApiKeys();
    return Response.json({
      data: keys
        .map(({ id, name, masked, createdAt }) => ({ id, name, masked, createdAt }))
        .sort((left, right) => right.createdAt - left.createdAt)
    }, { headers: { "Cache-Control": "no-store" } });
  }

  private async createApiKey(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (typeof body.name !== "string" || Object.keys(body).some((key) => key !== "name")) {
      throw new GatewayError(400, "invalid_request", "创建 API 密钥只接受名称。", "name");
    }
    const name = body.name.trim();
    if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new GatewayError(400, "invalid_api_key_name", "API 密钥名称须为 1 到 64 个可见字符。", "name");
    }
    const secret = randomSecret("oneapi_sk_");
    const createdAt = Date.now();
    const key: StoredApiKey = {
      id: crypto.randomUUID(),
      name,
      digest: await hashSecret(secret),
      masked: `oneapi_sk_••••${secret.slice(-4)}`,
      createdAt
    };
    await this.ctx.storage.transaction(async (transaction) => {
      const keys = ((await transaction.get<StoredApiKey[]>(API_KEYS_KEY)) ?? []).slice(0, API_KEY_LIMIT);
      if (keys.length >= API_KEY_LIMIT) {
        throw new GatewayError(409, "api_key_limit_reached", `API 密钥数量上限为 ${API_KEY_LIMIT}。`, undefined, "invalid_request_error");
      }
      if (keys.some((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new GatewayError(409, "api_key_name_conflict", "API 密钥名称已存在。", "name");
      }
      await transaction.put(API_KEYS_KEY, [...keys, key]);
    });
    return Response.json({
      id: key.id,
      name: key.name,
      masked: key.masked,
      createdAt: key.createdAt,
      key: secret
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  }

  private async deleteApiKey(request: Request, id: string): Promise<Response> {
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 0) {
      throw new GatewayError(400, "invalid_request", "撤销 API 密钥不接受参数。", "body");
    }
    await this.ctx.storage.transaction(async (transaction) => {
      const keys = ((await transaction.get<StoredApiKey[]>(API_KEYS_KEY)) ?? []).slice(0, API_KEY_LIMIT);
      const remaining = keys.filter((key) => key.id !== id);
      if (remaining.length === keys.length) {
        throw new GatewayError(404, "api_key_not_found", "没有找到该 API 密钥。", "id");
      }
      if (remaining.length === 0) await transaction.delete(API_KEYS_KEY);
      else await transaction.put(API_KEYS_KEY, remaining);
    });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  private async writeCredentials(value: StoredCredentials): Promise<void> {
    const encrypted = await this.prepareCredentials(value);
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put({ [CREDENTIALS_KEY]: encrypted, [CREDENTIAL_VERSION_KEY]: value.version });
      await transaction.delete(REAUTH_KEY);
    });
  }

  private async status(): Promise<Response> {
    const credentials = await this.readCredentials();
    let login = await this.ctx.storage.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
    if (login?.status === "pending" && login.expiresAt <= Date.now()) {
      const observedId = login.id;
      await this.ctx.storage.transaction(async (transaction) => {
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
    const reauthentication = await this.ctx.storage.get<boolean | { code: string; at: number }>(REAUTH_KEY);
    return Response.json({
      connected: Boolean(credentials),
      account: credentials ? { idHint: `…${credentials.accountId.slice(-6)}` } : null,
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

  private async startLogin(): Promise<LoginPublicState> {
    const existing = await this.ctx.storage.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
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
    await this.ctx.storage.transaction(async (transaction) => {
      const transactionGeneration = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      if (transactionGeneration !== generation) throw new GatewayError(409, "login_superseded", "登录请求已被取消或替代。", undefined, "invalid_request_error");
      await transaction.put({ [LOGIN_PUBLIC_KEY]: publicState, [LOGIN_PRIVATE_KEY]: privateState });
    });
    return publicState;
  }

  private async pollLogin(loginId: string): Promise<LoginPublicState> {
    const current = await this.ctx.storage.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
    if (!current || current.id !== loginId) throw new GatewayError(404, "login_not_found", "没有找到该登录请求。", "login_id");
    if (current.status !== "pending") return current;
    if (current.expiresAt <= Date.now()) {
      return this.ctx.storage.transaction(async (transaction) => {
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
    const encrypted = await this.ctx.storage.get<EncryptedValue>(LOGIN_PRIVATE_KEY);
    if (!encrypted) throw new GatewayError(503, "login_state_corrupt", "登录内部状态缺失，请取消后重试。", undefined, "server_error");
    const privateState = await decryptJson<LoginPrivateState>(encrypted, this.env.TOKEN_ENCRYPTION_KEY, `oneapi:login:${current.generation}`);
    const waiting = { ...current, nextPollAt: Date.now() + current.intervalMs };
    await this.loginStateBarrier();
    await this.ctx.storage.transaction(async (transaction) => {
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
    const latest = await this.ctx.storage.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
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
    await this.ctx.storage.transaction(async (transaction) => {
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
    await this.ctx.storage.transaction(async (transaction) => {
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
    await this.ctx.storage.transaction(async (transaction) => {
      const generation = ((await transaction.get<number>(GENERATION_KEY)) ?? 0) + 1;
      await transaction.put(GENERATION_KEY, generation);
      await transaction.delete([CREDENTIALS_KEY, CREDENTIAL_VERSION_KEY, LOGIN_PUBLIC_KEY, LOGIN_PRIVATE_KEY, MODEL_CACHE_KEY, LEASES_KEY, REAUTH_KEY]);
    });
  }

  private async cancelGeneration(leaseId: string): Promise<void> {
    const generation = this.activeGenerations.get(leaseId);
    if (!generation) return;
    generation.controller.abort(new Error("client cancelled"));
    await generation.finish();
  }

  private async disableRejectedCredentials(expectedGeneration: number, expectedVersion: number): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      const version = await transaction.get<number>(CREDENTIAL_VERSION_KEY);
      if (generation !== expectedGeneration || version !== expectedVersion) return;
      await transaction.delete([CREDENTIALS_KEY, CREDENTIAL_VERSION_KEY]);
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
        await this.ctx.storage.transaction(async (transaction) => {
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
        await this.ctx.storage.transaction(async (transaction) => {
          const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
          const version = await transaction.get<number>(CREDENTIAL_VERSION_KEY);
          if (generation !== expectedGeneration || version !== credentials.version) {
            superseded = true;
            return;
          }
          await transaction.delete([CREDENTIALS_KEY, CREDENTIAL_VERSION_KEY]);
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

  private async listModels(): Promise<Response> {
    let credentials = await this.refreshCredentials();
    let response: Response;
    try {
      response = await fetchModels((request) => this.timedFetch(request, 5000), credentials);
    } catch (error) {
      if (!(error instanceof GatewayError) || error.code !== "account_reauthentication_required") throw error;
      credentials = await this.refreshCredentials(true);
      const retryGeneration = await this.currentGeneration();
      try {
        response = await fetchModels((request) => this.timedFetch(request, 5000), credentials);
      } catch (retryError) {
        if (retryError instanceof GatewayError && retryError.code === "account_reauthentication_required") {
          await this.disableRejectedCredentials(retryGeneration, credentials.version);
        }
        throw retryError;
      }
    }
    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      throw new GatewayError(502, "invalid_models_response", "上游模型目录不是有效 JSON。", undefined, "server_error");
    }
    if (!Array.isArray(body.models)) throw new GatewayError(502, "invalid_models_response", "上游模型目录缺少 models 数组。", undefined, "server_error");
    const capabilities: ModelCapability[] = [];
    for (const raw of body.models) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const model = raw as Record<string, unknown>;
      if (typeof model.slug !== "string" || model.supported_in_api === false || model.visibility === "hide") continue;
      const efforts = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.flatMap((level) => level && typeof level === "object" && typeof (level as Record<string, unknown>).effort === "string" ? [(level as Record<string, unknown>).effort as string] : [])
        : [];
      capabilities.push({ id: model.slug, reasoningEfforts: efforts });
    }
    await this.ctx.storage.put(MODEL_CACHE_KEY, capabilities);
    return Response.json({
      object: "list",
      data: capabilities.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: "openai" }))
    }, { headers: { "Cache-Control": "no-store" } });
  }

  private async validateReasoning(request: NormalizedRequest): Promise<void> {
    const reasoning = request.upstream.reasoning;
    if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return;
    const effort = (reasoning as Record<string, unknown>).effort;
    if (typeof effort !== "string") return;
    const cache = await this.ctx.storage.get<ModelCapability[]>(MODEL_CACHE_KEY);
    const model = cache?.find((entry) => entry.id === request.model);
    if (!model || !model.reasoningEfforts.includes(effort)) {
      throw new GatewayError(400, "reasoning_capability_unverified", `模型 ${request.model} 的 reasoning effort ${effort} 未经当前模型目录确认；先调用 /v1/models 或移除该参数。`, "reasoning.effort");
    }
  }

  private async acquireLease(): Promise<string> {
    const now = Date.now();
    const leases = (await this.ctx.storage.get<Record<string, number>>(LEASES_KEY)) ?? {};
    for (const [id, expiresAt] of Object.entries(leases)) if (expiresAt <= now) delete leases[id];
    if (Object.keys(leases).length >= LEASE_LIMIT) {
      throw new GatewayError(429, "local_concurrency_limit", `本地并发生成上限为 ${LEASE_LIMIT}。`, undefined, "rate_limit_error");
    }
    const id = crypto.randomUUID();
    leases[id] = now + GENERATION_TIMEOUT_MS + 5000;
    await this.ctx.storage.put(LEASES_KEY, leases);
    return id;
  }

  private async releaseLease(id: string): Promise<void> {
    const leases = (await this.ctx.storage.get<Record<string, number>>(LEASES_KEY)) ?? {};
    if (id in leases) {
      delete leases[id];
      if (Object.keys(leases).length === 0) await this.ctx.storage.delete(LEASES_KEY);
      else await this.ctx.storage.put(LEASES_KEY, leases);
    }
  }

  private async handleGeneration(request: Request, chat: boolean): Promise<Response> {
    const normalized = chat ? normalizeChat(await readJsonBody(request)) : normalizeResponses(await readJsonBody(request));
    const requestGroupId = request.headers.get(LOCAL_REQUEST_GROUP_HEADER) ?? undefined;
    const generationFetch: OutboundFetch = (upstreamRequest) => this.env.MOCK_UPSTREAM === "true"
      ? mockUpstreamFetch(upstreamRequest)
      : fetchWithLocalOutbound(this.env.ONEAPI_LOCAL_OUTBOUND, upstreamRequest, requestGroupId);
    await this.validateReasoning(normalized);
    const leaseId = await this.acquireLease();
    const controller = new AbortController();
    const generationTimeoutMs = this.env.MOCK_UPSTREAM === "true" ? 100 : GENERATION_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(new Error("generation timeout")), generationTimeoutMs);
    const clientAbort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", clientAbort, { once: true });
    let released = false;
    const finish = async () => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", clientAbort);
      this.activeControllers.delete(controller);
      this.activeGenerations.delete(leaseId);
      await this.releaseLease(leaseId);
    };
    this.activeControllers.add(controller);
    this.activeGenerations.set(leaseId, { controller, finish });
    try {
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
        try {
          const completed = await collectCompletedResponse(upstream.body);
          const value = chat ? responseToChat(completed, normalized.model) : completed;
          return Response.json(value, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          if (controller.signal.aborted) throw generationAbortError(controller.signal);
          throw error;
        } finally {
          await finish();
        }
      }
      const lifecycle = {
        abort: () => controller.abort(new Error("client cancelled")),
        finish,
        failure: () => controller.signal.aborted ? generationAbortError(controller.signal) : undefined
      };
      const stream = chat
        ? chatEventStream(upstream.body, normalized.model, normalized.chat?.includeUsage ?? false, lifecycle)
        : responseEventStream(upstream.body, lifecycle);
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-OneAPI-Internal-Lease": leaseId
        }
      });
    } catch (error) {
      controller.abort(error);
      await finish();
      if (controller.signal.aborted && controller.signal.reason instanceof Error && controller.signal.reason.message === "generation timeout") {
        throw generationAbortError(controller.signal);
      }
      throw error;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    try {
      if (url.pathname === "/__internal/cancel") {
        requireBearer(request, this.env.TOKEN_ENCRYPTION_KEY, "internal");
        if (request.method !== "POST") throw new GatewayError(405, "method_not_allowed", "内部取消接口只接受 POST。", undefined, "invalid_request_error");
        const leaseId = url.searchParams.get("lease_id");
        if (!leaseId) throw new GatewayError(400, "invalid_request", "缺少内部 lease_id。", "lease_id");
        await this.cancelGeneration(leaseId);
        return new Response(null, { status: 204 });
      }
      let adminAuthentication: AdminAuthentication | null = null;
      if (url.pathname.startsWith("/admin/")) {
        if (request.method === "POST" && url.pathname === "/admin/session") return await this.createAdminSession(request);
        if (request.method === "GET" && url.pathname === "/admin/session") return await this.adminSessionStatus(request);
        adminAuthentication = await this.authenticateAdmin(request);
        if (request.method === "DELETE" && url.pathname === "/admin/session") {
          return await this.deleteAdminSession(request, adminAuthentication);
        }
      } else if (url.pathname.startsWith("/v1/")) {
        await this.authenticateGateway(request);
      } else {
        throw new GatewayError(404, "not_found", "接口不存在。", undefined, "invalid_request_error");
      }

      if (request.method === "GET" && url.pathname === "/admin/status") return this.status();
      if (request.method === "GET" && url.pathname === "/admin/api-keys") return await this.listApiKeys();
      if (request.method === "POST" && url.pathname === "/admin/api-keys") return await this.createApiKey(request);
      const apiKeyMatch = /^\/admin\/api-keys\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url.pathname);
      if (request.method === "DELETE" && apiKeyMatch) return await this.deleteApiKey(request, apiKeyMatch[1]!);
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
      if (request.method === "GET" && url.pathname === "/admin/test/models") return await this.listModels();
      if (request.method === "POST" && url.pathname === "/admin/test/responses") return await this.handleGeneration(request, false);
      if (request.method === "POST" && url.pathname === "/admin/test/chat/completions") return await this.handleGeneration(request, true);
      if (request.method === "GET" && url.pathname === "/v1/models") return await this.listModels();
      if (request.method === "POST" && url.pathname === "/v1/responses") return await this.handleGeneration(request, false);
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") return await this.handleGeneration(request, true);
      throw new GatewayError(405, "method_not_allowed", "请求方法或接口不受支持。", undefined, "invalid_request_error");
    } catch (error) {
      return errorResponse(error, requestId);
    }
  }
}
