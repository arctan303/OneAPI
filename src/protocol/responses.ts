import { GatewayError } from "../errors";
import { encodeSse, parseSse, parseSseJson, type SseEvent } from "../sse";

const encoder = new TextEncoder();
export const MAX_NON_STREAM_BYTES = 8 * 1024 * 1024;
const STREAM_BACKPRESSURE_IDLE_MS = 1500;

function eventType(event: SseEvent, payload: Record<string, unknown>): string {
  return event.event !== "message" ? event.event : typeof payload.type === "string" ? payload.type : "message";
}

function terminalError(payload: Record<string, unknown>, type: string): GatewayError {
  const response = payload.response && typeof payload.response === "object" ? payload.response as Record<string, unknown> : undefined;
  const error = response?.error && typeof response.error === "object" ? response.error as Record<string, unknown> : undefined;
  const message = typeof error?.message === "string" ? error.message : `上游以 ${type} 终止。`;
  return new GatewayError(502, "upstream_generation_failed", message, undefined, "server_error");
}

export async function collectCompletedResponse(body: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
  let total = 0;
  const completedItems = new Map<number, Record<string, unknown>>();
  for await (const event of parseSse(body)) {
    total += encoder.encode(event.data).byteLength;
    if (total > MAX_NON_STREAM_BYTES) {
      throw new GatewayError(502, "response_too_large", "非流式响应超过本地 8 MiB 聚合限制。", undefined, "server_error");
    }
    if (event.data === "[DONE]") continue;
    const payload = parseSseJson(event);
    const type = eventType(event, payload);
    if (type === "response.output_item.done") {
      const outputIndex = payload.output_index;
      const item = payload.item;
      if (
        typeof outputIndex === "number"
        && Number.isInteger(outputIndex)
        && outputIndex >= 0
        && item
        && typeof item === "object"
        && !Array.isArray(item)
      ) {
        completedItems.set(outputIndex, item as Record<string, unknown>);
      }
    }
    if (type === "response.completed") {
      const response = payload.response;
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        throw new GatewayError(502, "invalid_upstream_terminal", "上游完成事件缺少 response 对象。", undefined, "server_error");
      }
      const completed = response as Record<string, unknown>;
      if ((!Array.isArray(completed.output) || completed.output.length === 0) && completedItems.size > 0) {
        const output = [...completedItems.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, item]) => item);
        let outputText = "";
        for (const item of output) {
          if (item.type !== "message" || !Array.isArray(item.content)) continue;
          for (const rawPart of item.content) {
            if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) continue;
            const part = rawPart as Record<string, unknown>;
            if (part.type === "output_text" && typeof part.text === "string") outputText += part.text;
          }
        }
        return {
          ...completed,
          output,
          ...((typeof completed.output_text !== "string" || completed.output_text.length === 0) ? { output_text: outputText } : {})
        };
      }
      return completed;
    }
    if (type === "response.failed" || type === "response.incomplete" || type === "error") {
      throw terminalError(payload, type);
    }
  }
  throw new GatewayError(502, "upstream_stream_truncated", "上游流在完成事件前断开。", undefined, "server_error");
}

interface StreamLifecycle {
  abort: () => void;
  finish: () => Promise<void>;
  failure?: () => GatewayError | undefined;
}

function streamErrorEvent(error: unknown): Uint8Array {
  const known = error instanceof GatewayError
    ? error
    : new GatewayError(502, "invalid_upstream_stream", "上游响应流处理失败。", undefined, "server_error");
  return encodeSse("error", { error: { message: known.message, type: known.type, code: known.code } });
}

export function responseEventStream(body: ReadableStream<Uint8Array>, lifecycle: StreamLifecycle): ReadableStream<Uint8Array> {
  const iterator = parseSse(body)[Symbol.asyncIterator]();
  let terminal = false;
  let closed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const finishOnce = async () => {
    if (closed) return;
    closed = true;
    clearIdle();
    await lifecycle.finish();
  };
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      lifecycle.abort();
      void finishOnce();
    }, STREAM_BACKPRESSURE_IDLE_MS);
  };
  const enqueue = (controller: ReadableStreamDefaultController<Uint8Array>, value: Uint8Array) => {
    controller.enqueue(value);
    armIdle();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      clearIdle();
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            if (!terminal) enqueue(controller, streamErrorEvent(new GatewayError(502, "upstream_stream_truncated", "上游流在终态事件前断开。", undefined, "server_error")));
            controller.close();
            await finishOnce();
            return;
          }
          if (next.value.data === "[DONE]") continue;
          const payload = parseSseJson(next.value);
          const type = eventType(next.value, payload);
          if (type === "response.completed" || type === "response.failed" || type === "response.incomplete" || type === "error") terminal = true;
          if (type !== "message" && (type.startsWith("response.") || type === "error")) {
            enqueue(controller, encodeSse(type, payload));
            return;
          }
        }
      } catch (error) {
        enqueue(controller, streamErrorEvent(lifecycle.failure?.() ?? error));
        controller.close();
        lifecycle.abort();
        await finishOnce();
      }
    },
    async cancel() {
      clearIdle();
      lifecycle.abort();
      await iterator.return?.(undefined);
      await finishOnce();
    }
  });
}

function chatData(value: unknown): Uint8Array {
  return encoder.encode(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
}

function usageForChat(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return undefined;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : usage.input_tokens + usage.output_tokens
  };
}

function chatChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, number>): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {})
  };
}

export function chatEventStream(
  body: ReadableStream<Uint8Array>,
  model: string,
  includeUsage: boolean,
  lifecycle: StreamLifecycle
): ReadableStream<Uint8Array> {
  const iterator = parseSse(body)[Symbol.asyncIterator]();
  const id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  const toolIndexes = new Map<number, number>();
  let started = false;
  let sawTool = false;
  let terminal = false;
  let sentDone = false;
  let closed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Uint8Array[] = [];
  const clearIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const finishOnce = async () => {
    if (closed) return;
    closed = true;
    clearIdle();
    await lifecycle.finish();
  };
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      lifecycle.abort();
      void finishOnce();
    }, STREAM_BACKPRESSURE_IDLE_MS);
  };
  const enqueue = (controller: ReadableStreamDefaultController<Uint8Array>, value: Uint8Array) => {
    controller.enqueue(value);
    armIdle();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      clearIdle();
      try {
        if (!started) {
          started = true;
          enqueue(controller, chatData(chatChunk(id, model, { role: "assistant", content: "" }, null)));
          return;
        }
        if (queue.length > 0) {
          enqueue(controller, queue.shift()!);
          return;
        }
        if (terminal) {
          if (!sentDone) {
            sentDone = true;
            enqueue(controller, chatData("[DONE]"));
            return;
          }
          controller.close();
          await finishOnce();
          return;
        }
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            enqueue(controller, chatData({ error: { message: "上游流在终态事件前断开。", type: "server_error", code: "upstream_stream_truncated" } }));
            controller.close();
            lifecycle.abort();
            await finishOnce();
            return;
          }
          if (next.value.data === "[DONE]") continue;
          const payload = parseSseJson(next.value);
          const type = eventType(next.value, payload);
          if (type === "response.output_text.delta" && typeof payload.delta === "string") {
            enqueue(controller, chatData(chatChunk(id, model, { content: payload.delta }, null)));
            return;
          }
          if (type === "response.output_item.added") {
            const item = payload.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
              sawTool = true;
              const outputIndex = typeof payload.output_index === "number" ? payload.output_index : toolIndexes.size;
              const index = toolIndexes.size;
              toolIndexes.set(outputIndex, index);
              enqueue(controller, chatData(chatChunk(id, model, {
                tool_calls: [{
                  index,
                  id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `call_${index}`,
                  type: "function",
                  function: { name: typeof item.name === "string" ? item.name : "unknown", arguments: "" }
                }]
              }, null)));
              return;
            }
          }
          if (type === "response.function_call_arguments.delta" && typeof payload.delta === "string") {
            sawTool = true;
            const outputIndex = typeof payload.output_index === "number" ? payload.output_index : 0;
            const index = toolIndexes.get(outputIndex) ?? 0;
            enqueue(controller, chatData(chatChunk(id, model, { tool_calls: [{ index, function: { arguments: payload.delta } }] }, null)));
            return;
          }
          if (type === "response.completed") {
            const response = payload.response as Record<string, unknown> | undefined;
            const usage = includeUsage ? usageForChat(response?.usage) : undefined;
            enqueue(controller, chatData(chatChunk(id, model, {}, sawTool ? "tool_calls" : "stop", usage)));
            terminal = true;
            return;
          }
          if (type === "response.failed" || type === "response.incomplete" || type === "error") {
            const error = terminalError(payload, type);
            enqueue(controller, chatData({ error: { message: error.message, type: error.type, code: error.code } }));
            controller.close();
            lifecycle.abort();
            await finishOnce();
            return;
          }
        }
      } catch (error) {
        const failure = lifecycle.failure?.() ?? error;
        const known = failure instanceof GatewayError ? failure : new GatewayError(502, "invalid_upstream_stream", "上游响应流处理失败。", undefined, "server_error");
        enqueue(controller, chatData({ error: { message: known.message, type: known.type, code: known.code } }));
        controller.close();
        lifecycle.abort();
        await finishOnce();
      }
    },
    async cancel() {
      clearIdle();
      lifecycle.abort();
      await iterator.return?.(undefined);
      await finishOnce();
    }
  });
}

export function responseToChat(response: Record<string, unknown>, requestedModel: string): Record<string, unknown> {
  const output = Array.isArray(response.output) ? response.output : [];
  let content = "";
  const toolCalls: Record<string, unknown>[] = [];
  for (const raw of output) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        if (rawPart && typeof rawPart === "object" && !Array.isArray(rawPart)) {
          const part = rawPart as Record<string, unknown>;
          if (part.type === "output_text" && typeof part.text === "string") content += part.text;
        }
      }
    }
    if (item.type === "function_call") {
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "unknown",
          arguments: typeof item.arguments === "string" ? item.arguments : "{}"
        }
      });
    }
  }
  const usage = usageForChat(response.usage);
  return {
    id: typeof response.id === "string" ? response.id.replace(/^resp_/, "chatcmpl_") : `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: typeof response.created_at === "number" ? response.created_at : Math.floor(Date.now() / 1000),
    model: typeof response.model === "string" ? response.model : requestedModel,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      },
      finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
    }],
    ...(usage ? { usage } : {})
  };
}
