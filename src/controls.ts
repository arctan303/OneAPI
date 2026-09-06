import { GatewayError } from "./errors";
import type { ApiKeyPolicy, GatewayIdentity, ModelAccess, StoredApiKey } from "./types";

export const LEGACY_KEY_ID = "legacy";
export const MAX_RATE_LIMIT_PER_MINUTE = 6000;
export const MAX_KEY_CONCURRENCY = 2;
const MAX_EXPIRY_MS = 10 * 366 * 24 * 60 * 60 * 1000;
const MODEL_LIMIT = 64;
const MODEL_ID_LIMIT = 128;

export const DEFAULT_KEY_POLICY: ApiKeyPolicy = {
  enabled: true,
  expiresAt: null,
  modelAccess: { mode: "all", models: [] },
  rateLimitPerMinute: null,
  concurrencyLimit: null
};

export function normalizePolicy(value?: Partial<ApiKeyPolicy> | null): ApiKeyPolicy {
  const access = value?.modelAccess;
  const storedModels = Array.isArray(access?.models)
    ? access.models.filter((model): model is string => typeof model === "string")
    : [];
  return {
    enabled: value?.enabled !== false,
    expiresAt: typeof value?.expiresAt === "number" ? value.expiresAt : null,
    modelAccess: access?.mode === "allowlist"
      ? { mode: "allowlist", models: [...new Set(storedModels)] }
      : { mode: "all", models: [] },
    rateLimitPerMinute: typeof value?.rateLimitPerMinute === "number" ? value.rateLimitPerMinute : null,
    concurrencyLimit: typeof value?.concurrencyLimit === "number" ? value.concurrencyLimit : null
  };
}

export function storedKeyIdentity(key: StoredApiKey): GatewayIdentity {
  return { id: key.id, name: key.name, masked: key.masked, createdAt: key.createdAt, legacy: false, ...normalizePolicy(key) };
}

export function legacyKeyIdentity(policy?: Partial<ApiKeyPolicy> | null): GatewayIdentity {
  return {
    id: LEGACY_KEY_ID,
    name: "Legacy gateway key",
    masked: "configured legacy key",
    createdAt: 0,
    legacy: true,
    ...normalizePolicy(policy)
  };
}

export function publicKey(identity: GatewayIdentity): Omit<GatewayIdentity, "legacy"> {
  const { legacy: _legacy, ...value } = identity;
  return value;
}

function integerOrNull(value: unknown, param: string, max: number): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new GatewayError(400, "invalid_api_key_policy", `${param} 必须是 1 到 ${max} 的整数或 null。`, param);
  }
  return value;
}

function modelAccess(value: unknown): ModelAccess {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_api_key_policy", "modelAccess 必须是对象。", "modelAccess");
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !["mode", "models"].includes(key))) {
    throw new GatewayError(400, "invalid_api_key_policy", "modelAccess 包含不支持的字段。", "modelAccess");
  }
  if (source.mode === "all") {
    if (source.models !== undefined && (!Array.isArray(source.models) || source.models.length !== 0)) {
      throw new GatewayError(400, "invalid_api_key_policy", "all 模式的 models 必须为空数组。", "modelAccess.models");
    }
    return { mode: "all", models: [] };
  }
  if (source.mode !== "allowlist" || !Array.isArray(source.models) || source.models.length < 1 || source.models.length > MODEL_LIMIT) {
    throw new GatewayError(400, "invalid_api_key_policy", `allowlist 必须包含 1 到 ${MODEL_LIMIT} 个模型。`, "modelAccess.models");
  }
  const models = source.models.map((value, index) => {
    if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > MODEL_ID_LIMIT || /[\u0000-\u0020\u007f]/.test(value)) {
      throw new GatewayError(400, "invalid_api_key_policy", "模型 ID 格式无效。", `modelAccess.models[${index}]`);
    }
    return value;
  });
  return { mode: "allowlist", models: [...new Set(models)] };
}

export function validatePolicyPatch(body: Record<string, unknown>, current = DEFAULT_KEY_POLICY): ApiKeyPolicy {
  const policy = normalizePolicy(current);
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") throw new GatewayError(400, "invalid_api_key_policy", "enabled 必须是布尔值。", "enabled");
    policy.enabled = body.enabled;
  }
  if ("expiresAt" in body) {
    if (body.expiresAt === null) policy.expiresAt = null;
    else if (typeof body.expiresAt !== "number" || !Number.isInteger(body.expiresAt) || body.expiresAt <= Date.now() || body.expiresAt > Date.now() + MAX_EXPIRY_MS) {
      throw new GatewayError(400, "invalid_api_key_policy", "expiresAt 必须是未来十年内的毫秒时间戳或 null。", "expiresAt");
    } else policy.expiresAt = body.expiresAt;
  }
  if ("modelAccess" in body) policy.modelAccess = modelAccess(body.modelAccess);
  if ("rateLimitPerMinute" in body) policy.rateLimitPerMinute = integerOrNull(body.rateLimitPerMinute, "rateLimitPerMinute", MAX_RATE_LIMIT_PER_MINUTE);
  if ("concurrencyLimit" in body) policy.concurrencyLimit = integerOrNull(body.concurrencyLimit, "concurrencyLimit", MAX_KEY_CONCURRENCY);
  return policy;
}

export function validateKeyName(value: unknown): string {
  if (typeof value !== "string") throw new GatewayError(400, "invalid_api_key_name", "API 密钥名称必须是字符串。", "name");
  const name = value.trim();
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new GatewayError(400, "invalid_api_key_name", "API 密钥名称须为 1 到 64 个可见字符。", "name");
  }
  return name;
}

export function modelAllowed(identity: GatewayIdentity, model: string): boolean {
  return identity.modelAccess.mode === "all" || identity.modelAccess.models.includes(model);
}
