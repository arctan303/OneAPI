import { GatewayError } from "./errors";
import type { LogSettings, RequestLogUsage } from "./types";

export const DEFAULT_LOG_SETTINGS: LogSettings = {
  summaryRetentionDays: 30,
  bodyRetentionDays: 7,
  captureBodies: false,
  maxBodyBytes: 64 * 1024
};
const secretKey = /authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|password|secret/i;
const bearer = /\bBearer\s+[^\s"']+/gi;
const generatedKey = /\boneapi_sk_[A-Za-z0-9_-]*/g;
const openAiKey = /\bsk-[A-Za-z0-9_-]*/g;
const jwt = /\beyJ[A-Za-z0-9_.-]*/g;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function redactString(value: string): string {
  return value.replace(bearer, "Bearer [REDACTED]").replace(generatedKey, "[REDACTED]").replace(openAiKey, "[REDACTED]").replace(jwt, "[REDACTED]");
}

export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, seen));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = secretKey.test(key) ? "[REDACTED]" : redactSecrets(entry, seen);
  }
  return result;
}

export interface CapturedBody {
  body: Record<string, unknown> | null;
  truncated: boolean;
}

function bytePrefix(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

export function captureJson(value: unknown, maxBytes: number): CapturedBody {
  const redacted = redactSecrets(value);
  const serialized = JSON.stringify(redacted);
  if (serialized === undefined) return { body: { unavailable: true }, truncated: false };
  if (encoder.encode(serialized).byteLength <= maxBytes) {
    return {
      body: redacted && typeof redacted === "object" && !Array.isArray(redacted)
        ? redacted as Record<string, unknown>
        : { value: redacted },
      truncated: false
    };
  }
  return { body: { truncated: true, preview: bytePrefix(serialized, maxBytes) }, truncated: true };
}

export class StreamBodyCapture {
  private readonly chunks: Uint8Array[] = [];
  private total = 0;
  truncated = false;

  constructor(private readonly maxBytes: number, private readonly format: "sse") {}

  append(chunk: Uint8Array): void {
    if (this.total >= this.maxBytes) {
      this.truncated = true;
      return;
    }
    const remaining = this.maxBytes - this.total;
    const value = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
    this.chunks.push(value);
    this.total += value.byteLength;
    if (value.byteLength !== chunk.byteLength) this.truncated = true;
  }

  body(): Record<string, unknown> {
    const bytes = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      format: this.format,
      content: redactString(decoder.decode(bytes)),
      ...(this.truncated ? { truncated: true } : {})
    };
  }
}

function nullableToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function usageFromResponse(value: unknown): RequestLogUsage {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const usage = source.usage && typeof source.usage === "object" && !Array.isArray(source.usage)
    ? source.usage as Record<string, unknown>
    : source;
  const input = nullableToken(usage.input_tokens ?? usage.prompt_tokens);
  const output = nullableToken(usage.output_tokens ?? usage.completion_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: nullableToken(usage.total_tokens)
  };
}

export function validateLogSettingsPatch(body: Record<string, unknown>, current: LogSettings): LogSettings {
  const allowed = ["summaryRetentionDays", "bodyRetentionDays", "captureBodies", "maxBodyBytes"];
  if (Object.keys(body).length === 0 || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new GatewayError(400, "invalid_log_settings", "日志设置只接受支持的非空字段。", "body");
  }
  const next = { ...current };
  const boundedInteger = (name: keyof Pick<LogSettings, "summaryRetentionDays" | "bodyRetentionDays" | "maxBodyBytes">, min: number, max: number) => {
    if (!(name in body)) return;
    const value = body[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new GatewayError(400, "invalid_log_settings", `${name} 必须是 ${min} 到 ${max} 的整数。`, name);
    }
    next[name] = value;
  };
  boundedInteger("summaryRetentionDays", 1, 365);
  boundedInteger("bodyRetentionDays", 1, 30);
  boundedInteger("maxBodyBytes", 1024, 262144);
  if ("captureBodies" in body) {
    if (typeof body.captureBodies !== "boolean") throw new GatewayError(400, "invalid_log_settings", "captureBodies 必须是布尔值。", "captureBodies");
    next.captureBodies = body.captureBodies;
  }
  return next;
}
