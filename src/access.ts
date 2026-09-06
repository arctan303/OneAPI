import { GatewayError } from "./errors";
import type { AccessConfig } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ACCESS_SUFFIX = ".cloudflareaccess.com";
const MAX_ASSERTION_BYTES = 16 * 1024;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_JWKS_KEYS = 8;
const JWKS_TTL_MS = 5 * 60 * 1000;
const JWKS_REFRESH_COOLDOWN_MS = 30 * 1000;

export const DEFAULT_ACCESS_CONFIG: AccessConfig = {
  enabled: false,
  teamDomain: null,
  applicationAud: null,
  updatedAt: 0,
  revision: 0
};

interface JwtParts {
  header: { alg: string; kid: string; typ?: string };
  payload: Record<string, unknown>;
  signed: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

interface CachedKeys {
  teamDomain: string;
  fetchedAt: number;
  expiresAt: number;
  keys: Map<string, JsonWebKey>;
}

export interface AccessIdentity {
  expiresAt: number;
}

function accessError(code: string, message: string, status = 401): GatewayError {
  return new GatewayError(status, code, message, undefined, status === 401 ? "authentication_error" : "server_error");
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw accessError("invalid_access_token", "Cloudflare Access 令牌格式无效。");
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw accessError("invalid_access_token", "Cloudflare Access 令牌格式无效。");
  }
}

function jsonPart(value: string): Record<string, unknown> {
  const bytes = base64UrlBytes(value);
  if (bytes.byteLength > 8 * 1024) throw accessError("invalid_access_token", "Cloudflare Access 令牌字段过大。");
  try {
    const parsed = JSON.parse(decoder.decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw accessError("invalid_access_token", "Cloudflare Access 令牌字段无效。");
  }
}

function parseJwt(token: string): JwtParts {
  if (token.length < 32 || token.length > MAX_ASSERTION_BYTES) {
    throw accessError("invalid_access_token", "Cloudflare Access 令牌长度无效。");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw accessError("invalid_access_token", "Cloudflare Access 令牌格式无效。");
  }
  const rawHeader = jsonPart(parts[0]!);
  const payload = jsonPart(parts[1]!);
  if (rawHeader.alg !== "RS256" || typeof rawHeader.kid !== "string" || rawHeader.kid.length < 1 || rawHeader.kid.length > 128) {
    throw accessError("invalid_access_token", "Cloudflare Access 令牌算法或 key id 无效。");
  }
  if (rawHeader.typ !== undefined && rawHeader.typ !== "JWT") {
    throw accessError("invalid_access_token", "Cloudflare Access 令牌类型无效。");
  }
  return {
    header: { alg: rawHeader.alg, kid: rawHeader.kid, ...(rawHeader.typ === "JWT" ? { typ: "JWT" } : {}) },
    payload,
    signed: encoder.encode(parts[0] + "." + parts[1]),
    signature: base64UrlBytes(parts[2]!)
  };
}

function normalizedIssuer(teamDomain: string): string {
  return "https://" + teamDomain;
}

function validateClaims(payload: Record<string, unknown>, config: AccessConfig, nowMs: number): AccessIdentity {
  if (!config.teamDomain || !config.applicationAud) throw accessError("access_not_configured", "Cloudflare Access 尚未完整配置。", 503);
  if (payload.iss !== normalizedIssuer(config.teamDomain)) {
    throw accessError("invalid_access_token", "Cloudflare Access 令牌签发方无效。");
  }
  const audiences = typeof payload.aud === "string"
    ? [payload.aud]
    : Array.isArray(payload.aud) && payload.aud.every((value) => typeof value === "string")
      ? payload.aud
      : [];
  if (!audiences.includes(config.applicationAud)) {
    throw accessError("invalid_access_token", "Cloudflare Access 令牌受众无效。");
  }
  const now = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp) || payload.exp <= now) {
    throw accessError("access_token_expired", "Cloudflare Access 登录已过期。");
  }
  if (typeof payload.nbf !== "number" || !Number.isSafeInteger(payload.nbf) || payload.nbf > now) {
    throw accessError("access_token_not_yet_valid", "Cloudflare Access 登录尚未生效。");
  }
  return { expiresAt: payload.exp * 1000 };
}

function validateJwk(value: unknown): JsonWebKey & { kid: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw accessError("invalid_access_jwks", "Cloudflare Access 公钥格式无效。", 503);
  const jwk = value as Record<string, unknown>;
  if (
    jwk.kty !== "RSA" || jwk.alg !== "RS256" || jwk.use !== "sig" ||
    typeof jwk.kid !== "string" || jwk.kid.length < 1 || jwk.kid.length > 128 ||
    typeof jwk.n !== "string" || jwk.n.length < 128 || jwk.n.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(jwk.n) ||
    typeof jwk.e !== "string" || jwk.e.length < 1 || jwk.e.length > 16 || !/^[A-Za-z0-9_-]+$/.test(jwk.e)
  ) {
    throw accessError("invalid_access_jwks", "Cloudflare Access 公钥格式无效。", 503);
  }
  return { kty: "RSA", alg: "RS256", use: "sig", kid: jwk.kid, n: jwk.n, e: jwk.e };
}

async function limitedResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel("response too large").catch(() => undefined);
        throw accessError("invalid_access_jwks", "Cloudflare Access 公钥响应过大。", 503);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function normalizeTeamDomain(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) {
    throw new GatewayError(400, "invalid_access_config", "Team Domain 格式无效。", "teamDomain");
  }
  const trimmed = value.trim().toLowerCase();
  const source = trimmed.includes("://") ? trimmed : "https://" + trimmed;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new GatewayError(400, "invalid_access_config", "Team Domain 格式无效。", "teamDomain");
  }
  const hostname = url.hostname;
  const labels = hostname.split(".");
  const teamName = hostname.slice(0, -ACCESS_SUFFIX.length);
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash ||
    !hostname.endsWith(ACCESS_SUFFIX) || hostname === ACCESS_SUFFIX.slice(1) ||
    teamName.includes(".") ||
    hostname.length > 253 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new GatewayError(400, "invalid_access_config", "Team Domain 必须是 *.cloudflareaccess.com 的 HTTPS 域名。", "teamDomain");
  }
  return hostname;
}

export function normalizeApplicationAud(value: unknown): string {
  if (typeof value !== "string") throw new GatewayError(400, "invalid_access_config", "Application AUD 格式无效。", "applicationAud");
  const aud = value.trim();
  if (aud.length < 1 || aud.length > 256 || !/^[A-Za-z0-9_-]+$/.test(aud)) {
    throw new GatewayError(400, "invalid_access_config", "Application AUD 格式无效。", "applicationAud");
  }
  return aud;
}

export function validateAccessConfig(value: Record<string, unknown>, currentRevision: number): AccessConfig {
  if (Object.keys(value).some((key) => !["enabled", "teamDomain", "applicationAud"].includes(key)) || typeof value.enabled !== "boolean") {
    throw new GatewayError(400, "invalid_access_config", "Access 配置只接受 enabled、teamDomain 和 applicationAud。", "body");
  }
  const empty = (entry: unknown): boolean => entry === null || entry === undefined || (typeof entry === "string" && entry.trim() === "");
  const teamDomain = empty(value.teamDomain) ? null : normalizeTeamDomain(value.teamDomain);
  const applicationAud = empty(value.applicationAud) ? null : normalizeApplicationAud(value.applicationAud);
  if (value.enabled && (!teamDomain || !applicationAud)) {
    throw new GatewayError(400, "invalid_access_config", "启用 Access 前必须填写 Team Domain 和 Application AUD。", "body");
  }
  return { enabled: value.enabled, teamDomain, applicationAud, updatedAt: Date.now(), revision: currentRevision + 1 };
}

export class AccessTokenVerifier {
  private cache: CachedKeys | null = null;
  private loading: { teamDomain: string; generation: number; promise: Promise<CachedKeys> } | null = null;
  private generation = 0;

  clear(): void {
    this.generation += 1;
    this.cache = null;
    this.loading = null;
  }

  private async fetchKeys(teamDomain: string, fetcher: (request: Request) => Promise<Response>, nowMs: number): Promise<CachedKeys> {
    const response = await fetcher(new Request(normalizedIssuer(teamDomain) + "/cdn-cgi/access/certs", {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual"
    }));
    if (response.status !== 200) throw accessError("access_jwks_unavailable", "无法读取 Cloudflare Access 公钥。", 503);
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_JWKS_BYTES)) {
      throw accessError("invalid_access_jwks", "Cloudflare Access 公钥响应过大。", 503);
    }
    const bytes = await limitedResponseBytes(response, MAX_JWKS_BYTES);
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(decoder.decode(bytes));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
      body = parsed as Record<string, unknown>;
    } catch {
      throw accessError("invalid_access_jwks", "Cloudflare Access 公钥响应无效。", 503);
    }
    if (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > MAX_JWKS_KEYS) {
      throw accessError("invalid_access_jwks", "Cloudflare Access 公钥数量无效。", 503);
    }
    const keys = new Map<string, JsonWebKey>();
    for (const value of body.keys) {
      const key = validateJwk(value);
      if (keys.has(key.kid)) throw accessError("invalid_access_jwks", "Cloudflare Access 公钥 key id 重复。", 503);
      keys.set(key.kid, key);
    }
    return { teamDomain, fetchedAt: nowMs, expiresAt: nowMs + JWKS_TTL_MS, keys };
  }

  private async keys(teamDomain: string, fetcher: (request: Request) => Promise<Response>, nowMs: number, force: boolean): Promise<CachedKeys> {
    const current = this.cache;
    const sameDomain = current?.teamDomain === teamDomain;
    const fresh = sameDomain && current.expiresAt > nowMs;
    if (!force && fresh) return current;
    if (force && sameDomain && nowMs - current.fetchedAt < JWKS_REFRESH_COOLDOWN_MS) return current;
    const generation = this.generation;
    if (this.loading?.teamDomain === teamDomain && this.loading.generation === generation) {
      return this.loading.promise;
    }
    const promise = this.fetchKeys(teamDomain, fetcher, nowMs);
    this.loading = { teamDomain, generation, promise };
    try {
      const loaded = await promise;
      if (this.generation === generation) this.cache = loaded;
      return loaded;
    } finally {
      if (this.loading?.promise === promise) this.loading = null;
    }
  }

  async verify(token: string, config: AccessConfig, fetcher: (request: Request) => Promise<Response>, nowMs = Date.now()): Promise<AccessIdentity> {
    if (!config.enabled || !config.teamDomain || !config.applicationAud) {
      throw accessError("access_not_enabled", "Cloudflare Access 未启用。");
    }
    let teamDomain: string;
    let applicationAud: string;
    try {
      teamDomain = normalizeTeamDomain(config.teamDomain);
      applicationAud = normalizeApplicationAud(config.applicationAud);
    } catch {
      throw accessError("access_not_configured", "Cloudflare Access 配置无效。", 503);
    }
    if (teamDomain !== config.teamDomain || applicationAud !== config.applicationAud) {
      throw accessError("access_not_configured", "Cloudflare Access 配置无效。", 503);
    }
    const trustedConfig = { ...config, teamDomain, applicationAud };
    const jwt = parseJwt(token);
    const identity = validateClaims(jwt.payload, trustedConfig, nowMs);
    let cache = await this.keys(teamDomain, fetcher, nowMs, false);
    let jwk = cache.keys.get(jwt.header.kid);
    if (!jwk) {
      cache = await this.keys(teamDomain, fetcher, nowMs, true);
      jwk = cache.keys.get(jwt.header.kid);
    }
    if (!jwk) throw accessError("invalid_access_token", "Cloudflare Access 令牌签名密钥无效。");
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    } catch {
      throw accessError("invalid_access_jwks", "Cloudflare Access 公钥无法使用。", 503);
    }
    const verifySignature = async (candidate: CryptoKey): Promise<boolean> => {
      try {
        return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", candidate, jwt.signature, jwt.signed);
      } catch {
        return false;
      }
    };
    let valid = await verifySignature(key);
    if (!valid) {
      const refreshed = await this.keys(teamDomain, fetcher, nowMs, true);
      const next = refreshed.keys.get(jwt.header.kid);
      if (next && next !== jwk) {
        try {
          const nextKey = await crypto.subtle.importKey("jwk", next, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
          valid = await verifySignature(nextKey);
        } catch {
          throw accessError("invalid_access_jwks", "Cloudflare Access 公钥无法使用。", 503);
        }
      }
    }
    if (!valid) throw accessError("invalid_access_token", "Cloudflare Access 令牌签名无效。");
    return identity;
  }
}
