import { GatewayError } from "../errors";

export const MAX_REQUEST_BYTES = 1024 * 1024;

export interface NormalizedRequest {
  model: string;
  stream: boolean;
  upstream: Record<string, unknown>;
  chat?: { includeUsage: boolean };
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, param: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_type", `${param} 必须是对象。`, param);
  }
  return value as JsonObject;
}

function onlyKeys(value: JsonObject, allowed: readonly string[], param = "body"): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const field = param === "body" ? key : `${param}.${key}`;
      throw new GatewayError(400, "unsupported_parameter", `不支持参数 ${field}。`, field);
    }
  }
}

function requiredString(value: unknown, param: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GatewayError(400, "invalid_type", `${param} 必须是非空字符串。`, param);
  }
  return value;
}

function optionalBoolean(value: unknown, param: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new GatewayError(400, "invalid_type", `${param} 必须是布尔值。`, param);
  return value;
}

export async function readJsonBody(request: Request): Promise<JsonObject> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_REQUEST_BYTES) {
    throw new GatewayError(413, "request_too_large", "请求体超过本地 1 MiB 限制。", "body");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new GatewayError(413, "request_too_large", "请求体超过本地 1 MiB 限制。", "body");
  }
  try {
    return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "body");
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(400, "invalid_json", "请求体必须是有效 UTF-8 JSON 对象。", "body");
  }
}

function normalizeFunctionTool(value: unknown, param: string, chat: boolean): JsonObject {
  const tool = object(value, param);
  onlyKeys(tool, chat ? ["type", "function"] : ["type", "name", "description", "parameters", "strict"], param);
  if (tool.type !== "function") {
    throw new GatewayError(400, "unsupported_tool", `${param}.type 仅支持 function。`, `${param}.type`);
  }
  const source = chat ? object(tool.function, `${param}.function`) : tool;
  if (chat) onlyKeys(source, ["name", "description", "parameters", "strict"], `${param}.function`);
  const name = requiredString(source.name, chat ? `${param}.function.name` : `${param}.name`);
  if (source.description !== undefined && typeof source.description !== "string") {
    throw new GatewayError(400, "invalid_type", `${param} 的 description 必须是字符串。`, `${param}.description`);
  }
  if (source.parameters !== undefined) object(source.parameters, `${param}.parameters`);
  if (source.strict !== undefined && typeof source.strict !== "boolean") {
    throw new GatewayError(400, "invalid_type", `${param}.strict 必须是布尔值。`, `${param}.strict`);
  }
  return {
    type: "function",
    name,
    ...(source.description !== undefined ? { description: source.description } : {}),
    parameters: source.parameters ?? { type: "object", properties: {} },
    ...(source.strict !== undefined ? { strict: source.strict } : {})
  };
}

function normalizeTools(value: unknown, chat: boolean): JsonObject[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new GatewayError(400, "invalid_type", "tools 必须是数组。", "tools");
  return value.map((tool, index) => normalizeFunctionTool(tool, `tools[${index}]`, chat));
}

function normalizeToolChoice(value: unknown, chat: boolean): string {
  if (value === undefined) return "auto";
  if (typeof value === "string" && ["auto", "none", "required"].includes(value)) return value;
  const hint = chat ? "Chat tool_choice 对象" : "Responses tool_choice 对象";
  throw new GatewayError(400, "unsupported_parameter", `${hint}无法映射到当前 Codex 后端；仅支持 auto、none、required。`, "tool_choice");
}

function normalizeReasoning(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  const reasoning = object(value, "reasoning");
  onlyKeys(reasoning, ["effort"], "reasoning");
  const effort = requiredString(reasoning.effort, "reasoning.effort");
  if (!["minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
    throw new GatewayError(400, "unsupported_parameter", "reasoning.effort 仅支持 minimal/low/medium/high/xhigh，且最终仍受所选模型能力约束。", "reasoning.effort");
  }
  return { effort, summary: "auto" };
}

function textContent(value: unknown, param: string): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new GatewayError(400, "unsupported_content", `${param} 仅支持文本。`, param);
  let result = "";
  value.forEach((part, index) => {
    const item = object(part, `${param}[${index}]`);
    onlyKeys(item, ["type", "text"], `${param}[${index}]`);
    if (!["text", "input_text", "output_text"].includes(String(item.type))) {
      throw new GatewayError(400, "unsupported_content", `${param}[${index}] 仅支持文本内容。`, `${param}[${index}].type`);
    }
    if (typeof item.text !== "string") throw new GatewayError(400, "invalid_type", "文本内容缺少 text。", `${param}[${index}].text`);
    result += item.text;
  });
  return result;
}

function responseMessage(role: string, content: string): JsonObject {
  const contentType = role === "assistant" ? "output_text" : "input_text";
  return { type: "message", role, content: [{ type: contentType, text: content }] };
}

function normalizeResponseInput(value: unknown): JsonObject[] {
  if (typeof value === "string") return [responseMessage("user", value)];
  if (!Array.isArray(value)) throw new GatewayError(400, "invalid_type", "input 必须是文本或输入项数组。", "input");
  return value.map((entry, index) => {
    const item = object(entry, `input[${index}]`);
    const type = item.type ?? "message";
    if (type === "message") {
      onlyKeys(item, ["type", "role", "content"], `input[${index}]`);
      const role = requiredString(item.role, `input[${index}].role`);
      if (!["system", "developer", "user", "assistant"].includes(role)) {
        throw new GatewayError(400, "unsupported_role", `input[${index}].role 不受支持。`, `input[${index}].role`);
      }
      return responseMessage(role, textContent(item.content, `input[${index}].content`));
    }
    if (type === "function_call") {
      onlyKeys(item, ["type", "call_id", "name", "arguments"], `input[${index}]`);
      return {
        type,
        call_id: requiredString(item.call_id, `input[${index}].call_id`),
        name: requiredString(item.name, `input[${index}].name`),
        arguments: requiredString(item.arguments, `input[${index}].arguments`)
      };
    }
    if (type === "function_call_output") {
      onlyKeys(item, ["type", "call_id", "output"], `input[${index}]`);
      if (!("output" in item)) throw new GatewayError(400, "invalid_type", `input[${index}].output 不能为空。`, `input[${index}].output`);
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
      if (output === undefined) throw new GatewayError(400, "invalid_type", `input[${index}].output 必须可序列化。`, `input[${index}].output`);
      return {
        type,
        call_id: requiredString(item.call_id, `input[${index}].call_id`),
        output
      };
    }
    throw new GatewayError(400, "unsupported_input_item", `input[${index}].type 不受支持。`, `input[${index}].type`);
  });
}

export function normalizeResponses(body: JsonObject): NormalizedRequest {
  onlyKeys(body, ["model", "input", "instructions", "stream", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "background"]);
  const model = requiredString(body.model, "model");
  if (body.store !== undefined && body.store !== false) throw new GatewayError(400, "unsupported_parameter", "store 只允许 false；Demo 不提供服务端会话存储。", "store");
  if (body.background !== undefined && body.background !== false) throw new GatewayError(400, "unsupported_parameter", "background 只允许 false。", "background");
  if (body.instructions !== undefined && typeof body.instructions !== "string") throw new GatewayError(400, "invalid_type", "instructions 必须是字符串。", "instructions");
  const tools = normalizeTools(body.tools, false);
  return {
    model,
    stream: optionalBoolean(body.stream, "stream", false),
    upstream: {
      model,
      instructions: body.instructions ?? "",
      input: normalizeResponseInput(body.input),
      ...(tools ? { tools } : {}),
      tool_choice: normalizeToolChoice(body.tool_choice, false),
      parallel_tool_calls: optionalBoolean(body.parallel_tool_calls, "parallel_tool_calls", true),
      ...(body.reasoning !== undefined ? { reasoning: normalizeReasoning(body.reasoning) } : {}),
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"]
    }
  };
}

function normalizeChatToolCall(value: unknown, param: string): JsonObject {
  const call = object(value, param);
  onlyKeys(call, ["id", "type", "function"], param);
  if (call.type !== "function") throw new GatewayError(400, "unsupported_tool", `${param}.type 仅支持 function。`, `${param}.type`);
  const fn = object(call.function, `${param}.function`);
  onlyKeys(fn, ["name", "arguments"], `${param}.function`);
  return {
    type: "function_call",
    call_id: requiredString(call.id, `${param}.id`),
    name: requiredString(fn.name, `${param}.function.name`),
    arguments: requiredString(fn.arguments, `${param}.function.arguments`)
  };
}

function normalizeChatMessages(value: unknown): { instructions: string; input: JsonObject[] } {
  if (!Array.isArray(value) || value.length === 0) throw new GatewayError(400, "invalid_type", "messages 必须是非空数组。", "messages");
  const instructions: string[] = [];
  const input: JsonObject[] = [];
  value.forEach((entry, index) => {
    const message = object(entry, `messages[${index}]`);
    onlyKeys(message, ["role", "content", "name", "tool_call_id", "tool_calls"], `messages[${index}]`);
    const role = requiredString(message.role, `messages[${index}].role`);
    if (message.name !== undefined) throw new GatewayError(400, "unsupported_parameter", "首版无法无损映射 Chat message.name。", `messages[${index}].name`);
    if (role === "system" || role === "developer") {
      instructions.push(`[${role}]\n${textContent(message.content, `messages[${index}].content`)}`);
      return;
    }
    if (role === "tool") {
      onlyKeys(message, ["role", "content", "tool_call_id"], `messages[${index}]`);
      input.push({
        type: "function_call_output",
        call_id: requiredString(message.tool_call_id, `messages[${index}].tool_call_id`),
        output: textContent(message.content, `messages[${index}].content`)
      });
      return;
    }
    if (role !== "user" && role !== "assistant") throw new GatewayError(400, "unsupported_role", `messages[${index}].role 不受支持。`, `messages[${index}].role`);
    const content = message.content === null && role === "assistant" ? "" : textContent(message.content, `messages[${index}].content`);
    if (content) input.push(responseMessage(role, content));
    if (message.tool_calls !== undefined) {
      if (role !== "assistant" || !Array.isArray(message.tool_calls)) throw new GatewayError(400, "invalid_type", "tool_calls 只允许出现在 assistant 消息且必须为数组。", `messages[${index}].tool_calls`);
      message.tool_calls.forEach((call, callIndex) => input.push(normalizeChatToolCall(call, `messages[${index}].tool_calls[${callIndex}]`)));
    }
  });
  return { instructions: instructions.join("\n\n"), input };
}

export function normalizeChat(body: JsonObject): NormalizedRequest {
  onlyKeys(body, ["model", "messages", "stream", "tools", "tool_choice", "parallel_tool_calls", "stream_options", "reasoning_effort"]);
  const model = requiredString(body.model, "model");
  const messages = normalizeChatMessages(body.messages);
  const tools = normalizeTools(body.tools, true);
  let includeUsage = false;
  if (body.stream_options !== undefined) {
    const options = object(body.stream_options, "stream_options");
    onlyKeys(options, ["include_usage"], "stream_options");
    includeUsage = optionalBoolean(options.include_usage, "stream_options.include_usage", false);
  }
  let reasoning: JsonObject | undefined;
  if (body.reasoning_effort !== undefined) reasoning = normalizeReasoning({ effort: body.reasoning_effort });
  return {
    model,
    stream: optionalBoolean(body.stream, "stream", false),
    chat: { includeUsage },
    upstream: {
      model,
      instructions: messages.instructions,
      input: messages.input,
      ...(tools ? { tools } : {}),
      tool_choice: normalizeToolChoice(body.tool_choice, true),
      parallel_tool_calls: optionalBoolean(body.parallel_tool_calls, "parallel_tool_calls", true),
      ...(reasoning ? { reasoning } : {}),
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"]
    }
  };
}
