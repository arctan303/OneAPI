import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import OpenAI from "openai";

const configuredBaseUrl = process.env.ONEAPI_BASE_URL ?? "http://127.0.0.1:8787";
let parsedBaseUrl;
try {
  parsedBaseUrl = new URL(configuredBaseUrl);
} catch {
  console.error("ONEAPI_BASE_URL 必须是有效的本地 HTTP URL。");
  process.exit(1);
}
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (
  parsedBaseUrl.protocol !== "http:" ||
  !loopbackHosts.has(parsedBaseUrl.hostname) ||
  parsedBaseUrl.username ||
  parsedBaseUrl.password ||
  parsedBaseUrl.pathname !== "/" ||
  parsedBaseUrl.search ||
  parsedBaseUrl.hash
) {
  console.error("ONEAPI_BASE_URL 只允许无用户信息、路径、query 或 hash 的本地 HTTP loopback 地址。");
  process.exit(1);
}
const baseUrl = parsedBaseUrl.origin;
const vars = Object.fromEntries(readFileSync(".dev.vars", "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
  const at = line.indexOf("=");
  return [line.slice(0, at), line.slice(at + 1)];
}));
const adminKey = vars.ADMIN_API_KEY;
const gatewayKey = vars.GATEWAY_API_KEY;
assert.ok(adminKey && gatewayKey, ".dev.vars 缺少本地密钥。先运行 npm run setup。");

try {
  const statusResponse = await fetch(`${baseUrl}/admin/status`, { headers: { Authorization: `Bearer ${adminKey}` } });
  assert.ok(statusResponse.ok, `管理状态失败：HTTP ${statusResponse.status}`);
  const status = await statusResponse.json();
  assert.equal(status.connected, true, "账户尚未连接；请先在本地页面完成设备码登录。");

  const client = new OpenAI({ apiKey: gatewayKey, baseURL: `${baseUrl}/v1`, maxRetries: 0 });
  const models = await client.models.list();
  assert.ok(models.data.length > 0, "真实模型目录为空。");
  const model = process.env.ONEAPI_MODEL ?? models.data[0].id;
  const ordinary = await client.responses.create({ model, input: "Reply with exactly: LIVE_OK" });
  console.log(JSON.stringify({ models: models.data.length, model, ordinaryStatus: ordinary.status, ordinaryText: ordinary.output_text }));

  let streamed = "";
  const stream = await client.responses.create({ model, input: "Reply with exactly: STREAM_OK", stream: true });
  for await (const event of stream) if (event.type === "response.output_text.delta") streamed += event.delta;
  console.log(JSON.stringify({ streamText: streamed }));

  const chat = await client.chat.completions.create({ model, messages: [{ role: "user", content: "Reply with exactly: CHAT_OK" }] });
  console.log(JSON.stringify({ chatText: chat.choices[0]?.message.content ?? "" }));

  let chatStreamed = "";
  const chatStream = await client.chat.completions.create({ model, messages: [{ role: "user", content: "Reply with exactly: CHAT_STREAM_OK" }], stream: true });
  for await (const chunk of chatStream) chatStreamed += chunk.choices[0]?.delta.content ?? "";
  console.log(JSON.stringify({ chatStreamText: chatStreamed }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
