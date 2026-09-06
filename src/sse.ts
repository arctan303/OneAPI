import { GatewayError } from "./errors";

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let eventName = "message";
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventName = "message";
      eventId = undefined;
      return null;
    }
    const event = { event: eventName, data: dataLines.join("\n"), ...(eventId ? { id: eventId } : {}) };
    eventName = "message";
    eventId = undefined;
    dataLines = [];
    return event;
  };

  const consumeLine = (line: string): SseEvent | null => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value || "message";
    else if (field === "data") dataLines.push(value);
    else if (field === "id" && !value.includes("\u0000")) eventId = value;
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const match = /[\r\n]/.exec(buffer);
        if (!match || match.index === undefined) break;
        if (buffer[match.index] === "\r" && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        const endingLength = buffer[match.index] === "\r" && buffer[match.index + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(match.index + endingLength);
        const event = consumeLine(line);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const event = consumeLine(buffer);
      if (event) yield event;
    }
    const final = dispatch();
    if (final) yield final;
  } catch {
    throw new GatewayError(502, "invalid_upstream_stream", "上游 SSE 不是有效 UTF-8 或事件格式。", undefined, "server_error");
  } finally {
    reader.releaseLock();
  }
}

export function encodeSse(event: string, data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const lines = payload.split("\n").map((line) => `data: ${line}`).join("\n");
  return new TextEncoder().encode(`event: ${event}\n${lines}\n\n`);
}

export function parseSseJson(event: SseEvent): Record<string, unknown> {
  try {
    const value = JSON.parse(event.data);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value as Record<string, unknown>;
  } catch {
    throw new GatewayError(502, "invalid_upstream_event", `上游 SSE 事件 ${event.event} 包含无效 JSON。`, undefined, "server_error");
  }
}
