import type { EncryptedValue } from "./types";
import { GatewayError } from "./errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const ADMIN_SESSION_COOKIE = "oneapi_admin_session";

export function timingSafeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get("Authorization");
  if (!value) return null;
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
}

export function cookieValue(request: Request, name: string): string | null {
  const matches = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return matches.length === 1 && matches[0] ? matches[0] : null;
}

function toBase64Url(value: Uint8Array): string {
  return toBase64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomSecret(prefix = ""): string {
  return `${prefix}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function hashSecret(value: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export function requireBearer(request: Request, expected: string, role: "admin" | "gateway" | "internal"): void {
  const supplied = bearerToken(request);
  if (!supplied || !expected || !timingSafeEqual(supplied, expected)) {
    const label = role === "admin" ? "管理" : role === "gateway" ? "调用" : "内部";
    throw new GatewayError(401, "invalid_api_key", `${label}密钥无效。`, undefined, "authentication_error");
  }
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new GatewayError(500, "invalid_encryption_key", "TOKEN_ENCRYPTION_KEY 必须是 32 字节 Base64。", undefined, "server_error");
  }
}

function toBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importKey(encoded: string): Promise<CryptoKey> {
  const raw = fromBase64(encoded);
  if (raw.byteLength !== 32) {
    throw new GatewayError(500, "invalid_encryption_key", "TOKEN_ENCRYPTION_KEY 必须解码为 32 字节。", undefined, "server_error");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(value: unknown, encodedKey: string, aad: string): Promise<EncryptedValue> {
  const key = await importKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad), tagLength: 128 },
    key,
    plaintext
  );
  return { version: 1, iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

export async function decryptJson<T>(value: EncryptedValue, encodedKey: string, aad: string): Promise<T> {
  if (!value || value.version !== 1) {
    throw new GatewayError(503, "credential_store_corrupt", "本地凭据格式无法识别，请断开后重新登录。", undefined, "authentication_error");
  }
  try {
    const key = await importKey(encodedKey);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(value.iv),
        additionalData: encoder.encode(aad),
        tagLength: 128
      },
      key,
      fromBase64(value.ciphertext)
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(503, "credential_decryption_failed", "本地凭据无法解密，请检查加密密钥或重新登录。", undefined, "authentication_error");
  }
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = fromBase64(padded);
    return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function jwtExpirationMs(token: string): number | null {
  const payload = decodeJwtPayload(token);
  return typeof payload?.exp === "number" ? payload.exp * 1000 : null;
}

export function accountIdFromIdToken(idToken: string): string | null {
  const payload = decodeJwtPayload(idToken);
  const namespaced = payload?.["https://api.openai.com/auth"];
  if (namespaced && typeof namespaced === "object") {
    const value = (namespaced as Record<string, unknown>).chatgpt_account_id;
    if (typeof value === "string" && value.length > 0) return value;
  }
  const direct = payload?.chatgpt_account_id;
  return typeof direct === "string" && direct.length > 0 ? direct : null;
}

export function accountInfoFromIdToken(idToken: string): { email: string | null; plan: string | null } {
  const payload = decodeJwtPayload(idToken) ?? {};
  const namespaced = payload["https://api.openai.com/auth"];
  const auth = namespaced && typeof namespaced === "object" && !Array.isArray(namespaced)
    ? namespaced as Record<string, unknown>
    : {};
  const email = [payload.email, auth.email, auth.chatgpt_email].find((value) => typeof value === "string" && value.length > 0);
  const plan = [auth.chatgpt_plan_type, payload.chatgpt_plan_type, payload.plan_type].find((value) => typeof value === "string" && value.length > 0);
  return {
    email: typeof email === "string" ? email : null,
    plan: typeof plan === "string" ? plan : null
  };
}
