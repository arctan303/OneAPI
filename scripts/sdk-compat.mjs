import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import OpenAI from "openai";

const baseUrl = "http://127.0.0.1:8790";
const adminKey = "mock-admin-key-for-tests-only-00000001";
const gatewayKey = "mock-gateway-key-for-tests-only-0001";
const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
const instanceNonce = randomUUID();

const portInUse = () => new Promise((resolveCheck) => {
  const socket = createConnection({ host: "127.0.0.1", port: 8790 });
  const finish = (used) => { socket.destroy(); resolveCheck(used); };
  socket.setTimeout(500, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

if (await portInUse()) throw new Error("端口 8790 已被占用；为避免误连旧服务，SDK 验证已停止。");

const child = spawn(process.execPath, [wrangler, "dev", "--config", "wrangler.mock.jsonc", "--env-file", "test/mock.env", "--var", `MOCK_INSTANCE_NONCE:${instanceNonce}`, "--persist-to", ".sdk-compat", "--log-level", "error"], {
  cwd: resolve("."),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let serverOutput = "";
let stage = "启动 Wrangler";
let createdApiKeyId = null;
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-4000); });

const headers = (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });
const deadline = (ms) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(`等待 ${ms}ms 超时`)), ms);
  timer.unref();
});

async function waitForHealth() {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Wrangler 提前退出（${child.exitCode}）\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.instanceNonce !== instanceNonce) throw new Error("端口 8790 响应并非本次启动的 Mock 实例。");
        return;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Wrangler 未在 20 秒内就绪。\n${serverOutput}`);
}

async function admin(path, body = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: headers(adminKey), body: JSON.stringify(body) });
  const text = response.status === 204 ? "" : await response.text();
  let value = null;
  if (text) {
    try { value = JSON.parse(text); }
    catch { throw new Error(`${path} 返回非 JSON：HTTP ${response.status} ${text.slice(0, 300)}`); }
  }
  assert.ok(response.ok, `${path} 失败：HTTP ${response.status} ${JSON.stringify(value)}`);
  return value;
}

async function connectMockAccount() {
  await admin("/admin/disconnect");
  const started = await admin("/admin/device/start");
  assert.equal(started.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(started.userCode, "MOCK-CODE");
  const waitMs = Math.max(0, started.nextPollAt - Date.now()) + 25;
  if (waitMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
  const connected = await admin("/admin/device/poll", { login_id: started.id });
  assert.equal(connected.status, "connected");
}

async function startCancelable(client) {
  const controller = new AbortController();
  const stream = await client.responses.create({ model: "gpt-mock", input: "slow", stream: true }, { signal: controller.signal });
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  return { controller, iterator };
}

async function run() {
  await waitForHealth();
  stage = "Mock 设备码登录";
  await connectMockAccount();
  const client = new OpenAI({ apiKey: gatewayKey, baseURL: `${baseUrl}/v1`, maxRetries: 0 });

  stage = "创建命名 API 密钥";
  const created = await admin("/admin/api-keys", { name: `sdk-${instanceNonce}` });
  createdApiKeyId = created.id;
  const managedClient = new OpenAI({ apiKey: created.key, baseURL: `${baseUrl}/v1`, maxRetries: 0 });
  const managedModels = await managedClient.models.list();
  assert.ok(managedModels.data.some((model) => model.id === "gpt-mock"));
  const managedResponse = await managedClient.responses.create({ model: "gpt-mock", input: "managed key" });
  assert.equal(managedResponse.output_text, "你好，mock");
  let managedStreamText = "";
  const managedStream = await managedClient.responses.create({ model: "gpt-mock", input: "managed stream", stream: true });
  for await (const event of managedStream) if (event.type === "response.output_text.delta") managedStreamText += event.delta;
  assert.equal(managedStreamText, "你好，mock");

  stage = "SDK models.list";
  const models = await client.models.list();
  assert.ok(models.data.some((model) => model.id === "gpt-mock"));

  stage = "SDK Responses 普通响应";
  const response = await client.responses.create({ model: "gpt-mock", input: "你好" });
  assert.equal(response.output_text, "你好，mock");

  stage = "SDK Responses 流式响应";
  let responseText = "";
  const responseStream = await client.responses.create({ model: "gpt-mock", input: "流式", stream: true });
  for await (const event of responseStream) if (event.type === "response.output_text.delta") responseText += event.delta;
  assert.equal(responseText, "你好，mock");

  stage = "SDK Responses 多轮";
  const multiTurn = await client.responses.create({
    model: "gpt-mock",
    input: [
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "已收到" },
      { role: "user", content: "第二轮" }
    ]
  });
  assert.equal(multiTurn.output_text, "你好，mock");

  stage = "SDK Responses 工具调用";
  const tool = await client.responses.create({
    model: "gpt-mock",
    input: "call_tool",
    tools: [{ type: "function", name: "get_weather", description: "查询天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false }, strict: true }]
  });
  assert.equal(tool.output[0]?.type, "function_call");

  stage = "SDK Chat 普通响应";
  const chat = await client.chat.completions.create({ model: "gpt-mock", messages: [{ role: "user", content: "你好" }] });
  assert.equal(chat.choices[0]?.message.content, "你好，mock");

  stage = "SDK Chat 流式响应";
  let chatText = "";
  const chatStream = await client.chat.completions.create({ model: "gpt-mock", messages: [{ role: "user", content: "流式" }], stream: true });
  for await (const chunk of chatStream) chatText += chunk.choices[0]?.delta.content ?? "";
  assert.equal(chatText, "你好，mock");

  stage = "SDK 并发与取消";
  const active = await Promise.all([startCancelable(client), startCancelable(client)]);
  const limited = await fetch(`${baseUrl}/v1/responses`, { method: "POST", headers: headers(gatewayKey), body: JSON.stringify({ model: "gpt-mock", input: "third" }) });
  assert.equal(limited.status, 429);
  for (const item of active) {
    item.controller.abort();
    await item.iterator.return?.();
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
  const afterCancel = await Promise.all([
    client.responses.create({ model: "gpt-mock", input: "cancel slot one" }),
    client.responses.create({ model: "gpt-mock", input: "cancel slot two" })
  ]);
  assert.equal(afterCancel[0].output_text, "你好，mock");
  assert.equal(afterCancel[1].output_text, "你好，mock");

  stage = "撤销命名 API 密钥";
  const revoked = await fetch(`${baseUrl}/admin/api-keys/${createdApiKeyId}`, {
    method: "DELETE",
    headers: headers(adminKey),
    body: "{}"
  });
  assert.equal(revoked.status, 204);
  const rejected = await fetch(`${baseUrl}/v1/models`, { headers: headers(created.key) });
  assert.equal(rejected.status, 401);
  createdApiKeyId = null;

  console.log("SDK 兼容验证通过：命名 API 密钥普通/流式调用与撤销、旧调用密钥 models、Responses 普通/流式/多轮/工具、Chat 普通/流式、并发限制与 AbortController 取消。");
}

try {
  await Promise.race([run(), deadline(45_000)]);
} catch (error) {
  console.error(`SDK 验证失败阶段：${stage}`);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  if (serverOutput.trim()) console.error(`Wrangler 末尾输出：\n${serverOutput}`);
  process.exitCode = 1;
} finally {
  if (createdApiKeyId && child.exitCode === null) {
    await fetch(`${baseUrl}/admin/api-keys/${createdApiKeyId}`, {
      method: "DELETE",
      headers: headers(adminKey),
      body: "{}"
    }).catch(() => undefined);
  }
  child.kill("SIGINT");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2000))
  ]);
  if (child.exitCode === null) child.kill("SIGTERM");
}
