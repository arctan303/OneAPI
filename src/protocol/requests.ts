import { GatewayError } from "../errors";

export const MAX_REQUEST_BYTES = 1024 * 1024;

export interface NormalizedRequest {
  model: string;
  stream: boolean;
  ignoredParameters: string[];
  upstream: Record<string, unknown>;
  codexNative?: boolean;
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

const MAX_IGNORED_PARAMETERS = 32;
const MAX_IGNORED_PARAMETER_LENGTH = 128;

function addIgnoredParameter(ignored: string[], name: string): void {
  if (ignored.length >= MAX_IGNORED_PARAMETERS) return;
  const safe = name.replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, MAX_IGNORED_PARAMETER_LENGTH) || "?";
  if (!ignored.includes(safe)) ignored.push(safe);
}

function unknownKeys(value: JsonObject, allowed: readonly string[]): string[] {
  const ignored: string[] = [];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) addIgnoredParameter(ignored, key);
  return ignored;
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

function ignoredPositiveInteger(body: JsonObject, name: string, ignored: string[]): void {
  const value = body[name];
  if (value === undefined || value === null) return;
  if (typeof value !== "number") throw new GatewayError(400, "invalid_type", `${name} 必须是正整数。`, name);
  if (!Number.isSafeInteger(value) || value <= 0) throw new GatewayError(400, "invalid_value", `${name} 必须是正整数。`, name);
  addIgnoredParameter(ignored, name);
}

function ignoredNumberInRange(body: JsonObject, name: string, minimum: number, maximum: number, ignored: string[]): void {
  const value = body[name];
  if (value === undefined || value === null) return;
  if (typeof value !== "number") throw new GatewayError(400, "invalid_type", `${name} 必须是数字。`, name);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new GatewayError(400, "invalid_value", `${name} 必须在 ${minimum} 到 ${maximum} 之间。`, name);
  }
  addIgnoredParameter(ignored, name);
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

const reasoningEffortIdentifier = /^[a-z][a-z0-9_-]{0,31}$/;

function normalizeReasoning(value: unknown, effortParam = "reasoning.effort", codexNative = false): JsonObject | undefined {
  if (value === undefined) return undefined;
  const reasoning = object(value, "reasoning");
  if (codexNative) {
    if (reasoning.effort !== undefined) requiredString(reasoning.effort, effortParam);
    return reasoning;
  }
  onlyKeys(reasoning, ["effort"], "reasoning");
  const effort = requiredString(reasoning.effort, effortParam);
  if (!reasoningEffortIdentifier.test(effort)) {
    throw new GatewayError(
      400,
      "invalid_value",
      `${effortParam} 必须是 1 到 32 位小写标识符（字母开头，仅含字母、数字、下划线或连字符）；实际可用档位仍由所选模型的官方目录能力约束。`,
      effortParam
    );
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

function codexNativeInput(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) =>
    Boolean(entry && typeof entry === "object" && !Array.isArray(entry) && (entry as JsonObject).type === "additional_tools")
  );
}

function normalizeResponseInput(value: unknown, codexNative = false): JsonObject[] {
  if (typeof value === "string") return [responseMessage("user", value)];
  if (!Array.isArray(value)) throw new GatewayError(400, "invalid_type", "input 必须是文本或输入项数组。", "input");
  return value.map((entry, index) => {
    const item = object(entry, `input[${index}]`);
    const type = item.type ?? "message";
    if (codexNative) {
      const nativeType = requiredString(type, `input[${index}].type`);
      if (nativeType === "additional_tools") {
        const tools = normalizeNativeTools(item.tools, `input[${index}].tools`, true);
        if (!tools) throw new GatewayError(400, "invalid_type", `input[${index}].tools 必须是数组。`, `input[${index}].tools`);
        return { ...item, tools };
      }
      return item;
    }
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

function normalizeNativeTools(value: unknown, param = "tools", allowNamespace = false): JsonObject[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new GatewayError(400, "invalid_type", `${param} 必须是数组。`, param);
  return value.map((entry, index) => {
    const tool = object(entry, `${param}[${index}]`);
    const type = requiredString(tool.type, `${param}[${index}].type`);
    if (type !== "function" && type !== "custom" && !(allowNamespace && type === "namespace")) {
      const allowed = allowNamespace ? "function、custom 或 namespace" : "function 或 custom";
      throw new GatewayError(400, "unsupported_tool", `${param}[${index}].type 仅支持由客户端执行的 ${allowed} 工具声明。`, `${param}[${index}].type`);
    }
    return tool;
  });
}

function normalizeStringArray(value: unknown, param: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw new GatewayError(400, "invalid_type", `${param} 必须是最多 32 项的字符串数组。`, param);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 128) {
      throw new GatewayError(400, "invalid_type", `${param}[${index}] 必须是 1 到 128 字符的字符串。`, `${param}[${index}]`);
    }
    return entry;
  });
}

function normalizeOptionalString(value: unknown, param: string, maxLength = 256): string | undefined {
  if (value === undefined) return undefined;
  const result = requiredString(value, param);
  if (result.length > maxLength) throw new GatewayError(400, "invalid_value", `${param} 最长为 ${maxLength} 个字符。`, param);
  return result;
}

const CODEX_CLIENT_METADATA_KEYS = new Set([
  "x-codex-installation-id",
  "session_id",
  "thread_id",
  "turn_id",
  "root_turn_id",
  "x-codex-window-id",
  "x-codex-turn-metadata"
]);

function normalizeClientMetadata(value: unknown, ignored: string[]): JsonObject | undefined {
  if (value === undefined) return undefined;
  const metadata = object(value, "client_metadata");
  const normalized: JsonObject = {};
  for (const [key, entry] of Object.entries(metadata)) {
    if (!CODEX_CLIENT_METADATA_KEYS.has(key)) {
      addIgnoredParameter(ignored, `client_metadata.${key}`);
      continue;
    }
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) {
      throw new GatewayError(400, "invalid_value", "client_metadata 包含无效字段名。", `client_metadata.${key}`);
    }
    if (typeof entry !== "string" || new TextEncoder().encode(entry).byteLength > 16 * 1024) {
      throw new GatewayError(400, "invalid_type", `client_metadata.${key} 必须是不超过 16 KiB 的字符串。`, `client_metadata.${key}`);
    }
    normalized[key] = entry;
  }
  return normalized;
}

function normalizeOptionalObject(value: unknown, param: string): JsonObject | undefined {
  return value === undefined ? undefined : object(value, param);
}

function normalizeNativeToolChoice(value: unknown): unknown {
  if (value === undefined) return "auto";
  if (typeof value === "string") {
    const choice = requiredString(value, "tool_choice");
    if (!["auto", "none", "required"].includes(choice)) {
      throw new GatewayError(400, "unsupported_tool", "tool_choice 仅支持 auto、none、required。", "tool_choice");
    }
    return choice;
  }
  const choice = object(value, "tool_choice");
  const type = requiredString(choice.type, "tool_choice.type");
  if (type !== "function" && type !== "custom") {
    throw new GatewayError(400, "unsupported_tool", "tool_choice.type 仅支持由客户端执行的 function 或 custom 工具。", "tool_choice.type");
  }
  return choice;
}

export function normalizeResponses(body: JsonObject): NormalizedRequest {
  const allowed = ["model", "input", "instructions", "stream", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "background", "previous_response_id", "conversation", "max_output_tokens", "temperature", "top_p", "include", "prompt_cache_key", "text", "client_metadata"] as const;
  const ignoredParameters = unknownKeys(body, allowed);
  const model = requiredString(body.model, "model");
  if (body.store !== undefined && body.store !== false) throw new GatewayError(400, "unsupported_parameter", "store 只允许 false；Demo 不提供服务端会话存储。", "store");
  if (body.background !== undefined && body.background !== false) throw new GatewayError(400, "unsupported_parameter", "background 只允许 false。", "background");
  if (body.previous_response_id !== undefined) throw new GatewayError(400, "unsupported_parameter", "previous_response_id 需要服务端会话语义，当前不支持。", "previous_response_id");
  if (body.conversation !== undefined) throw new GatewayError(400, "unsupported_parameter", "conversation 需要服务端会话语义，当前不支持。", "conversation");
  if (body.instructions !== undefined && typeof body.instructions !== "string") throw new GatewayError(400, "invalid_type", "instructions 必须是字符串。", "instructions");
  const codexNative = codexNativeInput(body.input) || body.client_metadata !== undefined;
  const tools = codexNative ? normalizeNativeTools(body.tools) : normalizeTools(body.tools, false);
  ignoredPositiveInteger(body, "max_output_tokens", ignoredParameters);
  ignoredNumberInRange(body, "temperature", 0, 2, ignoredParameters);
  ignoredNumberInRange(body, "top_p", 0, 1, ignoredParameters);
  const include = normalizeStringArray(body.include, "include");
  const promptCacheKey = normalizeOptionalString(body.prompt_cache_key, "prompt_cache_key");
  const text = normalizeOptionalObject(body.text, "text");
  const clientMetadata = normalizeClientMetadata(body.client_metadata, ignoredParameters);
  return {
    model,
    stream: optionalBoolean(body.stream, "stream", false),
    ignoredParameters,
    ...(codexNative ? { codexNative: true } : {}),
    upstream: {
      model,
      ...(body.instructions !== undefined ? { instructions: body.instructions } : codexNative ? {} : { instructions: "" }),
      input: normalizeResponseInput(body.input, codexNative),
      ...(tools ? { tools } : {}),
      tool_choice: codexNative ? normalizeNativeToolChoice(body.tool_choice) : normalizeToolChoice(body.tool_choice, false),
      parallel_tool_calls: optionalBoolean(body.parallel_tool_calls, "parallel_tool_calls", true),
      ...(body.reasoning !== undefined ? { reasoning: normalizeReasoning(body.reasoning, "reasoning.effort", codexNative) } : {}),
      store: false,
      stream: true,
      include: include ?? ["reasoning.encrypted_content"],
      ...(promptCacheKey !== undefined ? { prompt_cache_key: promptCacheKey } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(clientMetadata !== undefined ? { client_metadata: clientMetadata } : {})
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
  const allowed = ["model", "messages", "stream", "tools", "tool_choice", "parallel_tool_calls", "stream_options", "reasoning_effort", "max_completion_tokens", "max_tokens", "temperature", "top_p"] as const;
  const unknown = unknownKeys(body, allowed);
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
  if (body.reasoning_effort !== undefined) reasoning = normalizeReasoning({ effort: body.reasoning_effort }, "reasoning_effort");
  const ignoredParameters: string[] = [...unknown];
  ignoredPositiveInteger(body, "max_completion_tokens", ignoredParameters);
  ignoredPositiveInteger(body, "max_tokens", ignoredParameters);
  ignoredNumberInRange(body, "temperature", 0, 2, ignoredParameters);
  ignoredNumberInRange(body, "top_p", 0, 1, ignoredParameters);
  return {
    model,
    stream: optionalBoolean(body.stream, "stream", false),
    ignoredParameters,
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
