import { GatewayError } from "./errors";
import type { UsageSnapshot, UsageWindow } from "./types";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseWindow(value: unknown, metadata: JsonObject, fallbackLabel: string | null): UsageWindow | null {
  const source = object(value);
  if (!source) return null;
  const seconds = finite(source.limit_window_seconds ?? source.window_seconds);
  const explicitMinutes = finite(source.window_duration_mins ?? source.window_minutes ?? source.windowDurationMins);
  const duration = explicitMinutes ?? (seconds === null ? null : seconds / 60);
  const used = finite(source.used_percent ?? source.usedPercent);
  const reset = finite(source.reset_at ?? source.resets_at ?? source.resetsAt);
  if (duration === null && used === null && reset === null) return null;
  const usedPercent = used === null ? null : Math.max(0, Math.min(100, used));
  return {
    limitId: text(metadata.metered_feature ?? metadata.limit_id ?? metadata.limitId ?? metadata.id),
    label: text(metadata.limit_name ?? metadata.label ?? metadata.name ?? fallbackLabel),
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt: reset === null ? null : reset < 1_000_000_000_000 ? reset * 1000 : reset,
    windowDurationMins: duration
  };
}

function windowsFromContainer(value: unknown, metadata: JsonObject, fallbackLabel: string | null): UsageWindow[] {
  const container = object(value);
  if (!container) return [];
  const windows: UsageWindow[] = [];
  const primary = parseWindow(container.primary_window, metadata, fallbackLabel ?? "Primary");
  const secondary = parseWindow(container.secondary_window, metadata, fallbackLabel ?? "Secondary");
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  return windows;
}

export function normalizeUsagePayload(value: unknown, fetchedAt = Date.now()): UsageSnapshot {
  const payload = object(value);
  if (!payload) throw new GatewayError(502, "invalid_usage_response", "官方额度响应不是 JSON 对象。", undefined, "server_error");

  const nested = object(payload.rate_limits);
  const mainContainer = object(payload.rate_limit) ?? object(nested?.rate_limit);
  const main = windowsFromContainer(mainContainer, mainContainer ?? {}, "Codex");
  let fiveHour: UsageWindow | null = null;
  let sevenDay: UsageWindow | null = null;
  const unknownMain: UsageWindow[] = [];
  for (const window of main) {
    const rounded = window.windowDurationMins === null ? null : Math.round(window.windowDurationMins);
    if (rounded === 300 && fiveHour === null) fiveHour = window;
    else if (rounded === 10080 && sevenDay === null) sevenDay = window;
    else unknownMain.push(window);
  }

  const additional: UsageWindow[] = [...unknownMain];
  if (Array.isArray(payload.additional_rate_limits)) {
    for (const raw of payload.additional_rate_limits) {
      const item = object(raw);
      if (!item) continue;
      const rateLimit = object(item.rate_limit) ?? item;
      additional.push(...windowsFromContainer(rateLimit, item, text(item.normal_model_slug)));
    }
  }

  if (main.length === 0 && additional.length === 0) {
    throw new GatewayError(502, "usage_windows_missing", "官方额度响应未包含可识别的窗口。", undefined, "server_error");
  }
  return {
    available: true,
    fetchedAt,
    lastSuccessAt: fetchedAt,
    error: null,
    windows: { fiveHour, sevenDay },
    additional
  };
}
