import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { Miniflare, Request as NodeRequest, Response as NodeResponse, convertV4MiniflareOptions } from "miniflare";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ReadableStream } from "node:stream/web";
import * as esbuild from "esbuild";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { createLocalOutboundService, createNodeOutbound, createRuntime } from "./dev-local.mjs";

const origin = "http://127.0.0.1";
const configPath = resolve("wrangler.jsonc");
const { workerOptions } = unstable_getMiniflareWorkerOptions(configPath, "test", {
  overrides: { enableContainers: false }
});
const adminKey = workerOptions.bindings?.ADMIN_API_KEY;
assert.equal(typeof adminKey, "string", ".dev.vars.test 缺少 ADMIN_API_KEY。");
assert.ok(adminKey.length > 0, ".dev.vars.test 的 ADMIN_API_KEY 不能为空。");

const forwarded = [];
const fakeOutbound = createNodeOutbound(async (request) => {
  forwarded.push({ method: request.method, redirect: request.redirect, body: await request.text() });
  return new NodeResponse("decoded", {
    status: 200,
    headers: { "Content-Encoding": "gzip", "Content-Length": "99" }
  });
}, false);
const fakeResponse = await fakeOutbound(new NodeRequest("https://chatgpt.com/backend-api/codex/responses", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gpt-mock", input: "fixture" })
}));
assert.equal(await fakeResponse.text(), "decoded");
assert.equal(fakeResponse.headers.has("content-encoding"), false);
assert.equal(fakeResponse.headers.has("content-length"), false);
assert.deepEqual(forwarded, [{
  method: "POST",
  redirect: "manual",
  body: JSON.stringify({ model: "gpt-mock", input: "fixture" })
}]);

const rejectionFetchCalls = [];
const rejectOutbound = createNodeOutbound(async (request) => {
  rejectionFetchCalls.push(request.url);
  return new NodeResponse("unexpected");
}, false);
const rejectedRequests = [
  new NodeRequest("http://chatgpt.com/backend-api/codex/models?client_version=test"),
  new NodeRequest("https://chatgpt.com:444/backend-api/codex/models?client_version=test"),
  new NodeRequest("https://example.com/backend-api/codex/models?client_version=test"),
  new NodeRequest("https://chatgpt.com/backend-api/codex/unknown"),
  new NodeRequest("https://chatgpt.com/backend-api/codex/responses"),
  new NodeRequest("https://auth.openai.com/oauth/token?unexpected=1", { method: "POST" }),
  new NodeRequest("https://chatgpt.com/backend-api/codex/responses?unexpected=1", { method: "POST" }),
  new NodeRequest("https://chatgpt.com/backend-api/codex/models?client_version=a&client_version=b"),
  new NodeRequest("https://chatgpt.com/backend-api/codex/models?client_version=test", {
    headers: { "CF-Worker": "injected" }
  }),
  new NodeRequest("https://chatgpt.com/backend-api/codex/models?client_version=test", {
    headers: { "CF-Connecting-IP": "127.0.0.1" }
  })
];
for (const request of rejectedRequests) {
  await assert.rejects(rejectOutbound(request));
}
assert.equal(rejectionFetchCalls.length, 0);
const bridge = new Miniflare(convertV4MiniflareOptions({
  name: "oneapi-node-outbound-bridge-test",
  script: `export default {
    async fetch() {
      return fetch("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-mock", input: "bridge" })
      });
    }
  };`,
  modules: true,
  compatibilityDate: "2026-09-06",
  host: "127.0.0.1",
  port: 0,
  cf: false,
  telemetry: { enabled: false },
  stripCfConnectingIp: false,
  outboundService: createNodeOutbound(async (request) => {
    assert.equal(request.headers.has("cf-worker"), false);
    assert.equal(await request.text(), JSON.stringify({ model: "gpt-mock", input: "bridge" }));
    return new NodeResponse("bridge-ok");
  }, false)
}));
try {
  await bridge.ready;
  const bridgeResponse = await bridge.dispatchFetch("http://127.0.0.1/bridge");
  assert.equal(await bridgeResponse.text(), "bridge-ok");
} finally {
  await bridge.dispose();
}

async function verifyRedirectRejected(location) {
  let calls = 0;
  let redirectBodyCancelled = false;
  const redirectBridge = new Miniflare(convertV4MiniflareOptions({
    name: "oneapi-node-outbound-redirect-test",
    script: `export default {
      async fetch() {
        try {
          const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          });
          return new Response("redirect-result", { status: response.status });
        } catch {
          return new Response("redirect-rejected", { status: 502 });
        }
      }
    };`,
    modules: true,
    compatibilityDate: "2026-09-06",
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    stripCfConnectingIp: false,
    outboundService: createNodeOutbound(async () => {
      calls += 1;
      return new NodeResponse(new ReadableStream({
        cancel() {
          redirectBodyCancelled = true;
        }
      }), { status: 307, headers: { Location: location } });
    }, false)
  }));
  try {
    await redirectBridge.ready;
    const response = await redirectBridge.dispatchFetch("http://127.0.0.1/redirect");
    assert.ok(response.status >= 500, `redirect rejection returned HTTP ${response.status}`);
    assert.match(await response.text(), /^redirect-(rejected|result)$/);
  } finally {
    await redirectBridge.dispose();
  }
  assert.equal(calls, 1);
  assert.equal(redirectBodyCancelled, true);
}

await verifyRedirectRejected("https://chatgpt.com/backend-api/codex/responses");
await verifyRedirectRejected("https://example.com/external");

let sourceStreamCancelled = false;
const streamOutbound = createNodeOutbound(async () => new NodeResponse(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("chunk"));
  },
  cancel() {
    sourceStreamCancelled = true;
  }
})), false);
const streamed = await streamOutbound(new NodeRequest(
  "https://chatgpt.com/backend-api/codex/models?client_version=test"
));
const streamReader = streamed.body.getReader();
const firstChunk = await streamReader.read();
assert.equal(new TextDecoder().decode(firstChunk.value), "chunk");
await streamReader.cancel();
assert.equal(sourceStreamCancelled, true);

const abortController = new AbortController();
let observedAbortSignal;
const abortOutbound = createNodeOutbound((request) => {
  observedAbortSignal = request.signal;
  return new Promise((resolvePromise, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  });
}, false);
const aborted = abortOutbound(new NodeRequest(
  "https://chatgpt.com/backend-api/codex/models?client_version=test",
  { signal: abortController.signal }
));
await new Promise((resolvePromise) => setImmediate(resolvePromise));
abortController.abort(new Error("test abort"));
await assert.rejects(aborted, /test abort/);
assert.equal(observedAbortSignal.aborted, true);

const localRequestHeader = "X-OneAPI-Local-Request-Id";
const localRequestGroupHeader = "X-OneAPI-Local-Request-Group";
const localCancelUrl = (requestId) => `https://oneapi-local-outbound.internal/cancel/${requestId}`;
let managerFetchCalls = 0;
const manager = createLocalOutboundService({
  fetchImpl: async (request) => {
    managerFetchCalls += 1;
    assert.equal(request.headers.has(localRequestHeader), false);
    return new NodeResponse("manager-ok");
  },
  trace: false,
  controlTimeoutMs: 100,
  generationTimeoutMs: 100,
  pendingCancelTtlMs: 20,
  maxPendingCancels: 2
});
const normalRequestId = crypto.randomUUID();
const managerResponse = await manager.handler(new NodeRequest(
  "https://chatgpt.com/backend-api/codex/models?client_version=test",
  { headers: { [localRequestHeader]: normalRequestId } }
));
assert.equal(await managerResponse.text(), "manager-ok");
assert.deepEqual(manager.snapshot(), { active: 0, pending: 0, groups: 0 });

const beforeRegisterId = crypto.randomUUID();
await manager.handler(new NodeRequest(localCancelUrl(beforeRegisterId), { method: "POST" }));
await manager.handler(new NodeRequest(localCancelUrl(beforeRegisterId), { method: "POST" }));
assert.deepEqual(manager.snapshot(), { active: 0, pending: 1, groups: 0 });
await assert.rejects(manager.handler(new NodeRequest(
  "https://chatgpt.com/backend-api/codex/models?client_version=test",
  { headers: { [localRequestHeader]: beforeRegisterId } }
)), /已取消/);
assert.equal(managerFetchCalls, 1);
assert.deepEqual(manager.snapshot(), { active: 0, pending: 0, groups: 0 });

const unknownCancelId = crypto.randomUUID();
await manager.handler(new NodeRequest(localCancelUrl(unknownCancelId), { method: "POST" }));
await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
assert.deepEqual(manager.snapshot(), { active: 0, pending: 0, groups: 0 });
await assert.rejects(manager.handler(new NodeRequest(
  "https://oneapi-local-outbound.internal/cancel/not-an-id",
  { method: "POST" }
)), /取消请求无效/);

let activeAbortObserved = false;
const activeManager = createLocalOutboundService({
  fetchImpl: (request) => new Promise((resolvePromise, reject) => {
    request.signal.addEventListener("abort", () => {
      activeAbortObserved = true;
      reject(request.signal.reason);
    }, { once: true });
  }),
  trace: false,
  controlTimeoutMs: 100,
  generationTimeoutMs: 100
});
const activeRequestId = crypto.randomUUID();
const activeRequest = activeManager.handler(new NodeRequest(
  "https://chatgpt.com/backend-api/codex/models?client_version=test",
  { headers: { [localRequestHeader]: activeRequestId } }
));
await new Promise((resolvePromise) => setImmediate(resolvePromise));
assert.deepEqual(activeManager.snapshot(), { active: 1, pending: 0, groups: 0 });
await Promise.all([
  activeManager.handler(new NodeRequest(localCancelUrl(activeRequestId), { method: "POST" })),
  activeManager.handler(new NodeRequest(localCancelUrl(activeRequestId), { method: "POST" }))
]);
await assert.rejects(activeRequest);
assert.equal(activeAbortObserved, true);
assert.deepEqual(activeManager.snapshot(), { active: 0, pending: 0, groups: 0 });

let deadlineAbortObserved = false;
const deadlineManager = createLocalOutboundService({
  fetchImpl: (request) => new Promise((resolvePromise, reject) => {
    const onAbort = () => {
      deadlineAbortObserved = true;
      reject(request.signal.reason);
    };
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
  }),
  trace: false,
  controlTimeoutMs: 20,
  generationTimeoutMs: 20
});
const deadlineRequest = assert.rejects(deadlineManager.handler(new NodeRequest(
  "https://chatgpt.com/backend-api/codex/models?client_version=test",
  { headers: { [localRequestHeader]: crypto.randomUUID() } }
)));
let deadlineGuard;
try {
  await Promise.race([
    deadlineRequest,
    new Promise((resolvePromise, reject) => {
      deadlineGuard = setTimeout(() => reject(new Error("local deadline test timed out")), 200);
    })
  ]);
} finally {
  clearTimeout(deadlineGuard);
}
assert.equal(deadlineAbortObserved, true);
assert.deepEqual(deadlineManager.snapshot(), { active: 0, pending: 0, groups: 0 });

let unconsumedSourceCancelled = false;
const unconsumedManager = createLocalOutboundService({
  fetchImpl: async () => new NodeResponse(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("unconsumed"));
    },
    cancel() {
      unconsumedSourceCancelled = true;
    }
  })),
  trace: false,
  controlTimeoutMs: 20,
  generationTimeoutMs: 20
});
await unconsumedManager.handler(new NodeRequest(
  "https://chatgpt.com/backend-api/codex/models?client_version=test",
  { headers: { [localRequestHeader]: crypto.randomUUID() } }
));
assert.deepEqual(unconsumedManager.snapshot(), { active: 1, pending: 0, groups: 0 });
await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
assert.equal(unconsumedSourceCancelled, true);
assert.deepEqual(unconsumedManager.snapshot(), { active: 0, pending: 0, groups: 0 });

let disposeAbortObserved = false;
const disposableManager = createLocalOutboundService({
  fetchImpl: (request) => new Promise((resolvePromise, reject) => {
    request.signal.addEventListener("abort", () => {
      disposeAbortObserved = true;
      reject(request.signal.reason);
    }, { once: true });
  }),
  trace: false
});
const disposedRequest = disposableManager.handler(new NodeRequest(
  "https://chatgpt.com/backend-api/codex/models?client_version=test",
  { headers: { [localRequestHeader]: crypto.randomUUID() } }
));
await new Promise((resolvePromise) => setImmediate(resolvePromise));
disposableManager.dispose();
await assert.rejects(disposedRequest);
assert.equal(disposeAbortObserved, true);
assert.deepEqual(disposableManager.snapshot(), { active: 0, pending: 0, groups: 0 });

const groupSignals = new Map();
let groupedFetchCalls = 0;
const groupManager = createLocalOutboundService({
  fetchImpl: (request) => {
    groupedFetchCalls += 1;
    assert.equal(request.headers.has(localRequestHeader), false);
    assert.equal(request.headers.has(localRequestGroupHeader), false);
    const marker = request.headers.get("X-Test-Marker");
    groupSignals.set(marker, request.signal);
    return new Promise((resolvePromise, reject) => {
      const onAbort = () => reject(request.signal.reason);
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    });
  },
  trace: false,
  controlTimeoutMs: 60_000,
  generationTimeoutMs: 60_000
});
const groupA = crypto.randomUUID();
const groupB = crypto.randomUUID();
assert.equal(groupManager.openGroup(groupA), true);
assert.equal(groupManager.openGroup(groupB), true);
const groupedA = groupManager.handler(new NodeRequest(
  "https://chatgpt.com/backend-api/codex/models?client_version=test",
  { headers: {
    [localRequestHeader]: crypto.randomUUID(),
    [localRequestGroupHeader]: groupA,
    "X-Test-Marker": "a"
  } }
));
const groupedB = groupManager.handler(new NodeRequest(
  "https://chatgpt.com/backend-api/codex/models?client_version=test",
  { headers: {
    [localRequestHeader]: crypto.randomUUID(),
    [localRequestGroupHeader]: groupB,
    "X-Test-Marker": "b"
  } }
));
await new Promise((resolvePromise) => setImmediate(resolvePromise));
assert.deepEqual(groupManager.snapshot(), { active: 2, pending: 0, groups: 2 });
groupManager.cancelGroup(groupA);
await assert.rejects(groupedA);
assert.equal(groupSignals.get("a").aborted, true);
assert.equal(groupSignals.get("b").aborted, false);
assert.deepEqual(groupManager.snapshot(), { active: 1, pending: 0, groups: 1 });
groupManager.dispose();
await assert.rejects(groupedB);
assert.equal(groupSignals.get("b").aborted, true);

const earlyGroupManager = createLocalOutboundService({
  fetchImpl: async () => {
    groupedFetchCalls += 1;
    return new NodeResponse("unexpected");
  },
  trace: false
});
const earlyGroup = crypto.randomUUID();
earlyGroupManager.cancelGroup(earlyGroup);
await assert.rejects(earlyGroupManager.handler(new NodeRequest(
  "https://chatgpt.com/backend-api/codex/models?client_version=test",
  { headers: {
    [localRequestHeader]: crypto.randomUUID(),
    [localRequestGroupHeader]: earlyGroup
  } }
)), /已取消/);
assert.equal(groupedFetchCalls, 2);
earlyGroupManager.dispose();

let beforeHeadersCalls = 0;
let beforeHeadersAbortObserved = false;
const beforeHeadersService = createLocalOutboundService({
  fetchImpl: (request) => {
    beforeHeadersCalls += 1;
    assert.equal(request.headers.has(localRequestHeader), false);
    return new Promise((resolvePromise, reject) => {
      const onAbort = () => {
        beforeHeadersAbortObserved = true;
        reject(request.signal.reason);
      };
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    });
  },
  trace: false,
  controlTimeoutMs: 60_000,
  generationTimeoutMs: 60_000
});
const beforeHeadersBundle = await esbuild.build({
  absWorkingDir: resolve("."),
  stdin: {
    contents: `
      import { fetchWithLocalOutbound } from "./src/local-outbound.ts";
      export default {
        async fetch(request, env) {
          const controller = new AbortController();
          const pending = fetchWithLocalOutbound(
            env.ONEAPI_LOCAL_OUTBOUND,
            new Request("https://chatgpt.com/backend-api/codex/models?client_version=test", {
              signal: controller.signal
            })
          );
          setTimeout(() => controller.abort(new Error("test client abort")), 10);
          const response = await pending;
          return new Response("upstream-result", { status: response.status });
        }
      };
    `,
    resolveDir: resolve("."),
    sourcefile: "before-headers-worker.ts",
    loader: "ts"
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  logLevel: "silent"
});
const beforeHeadersBridge = new Miniflare(convertV4MiniflareOptions({
  name: "oneapi-before-headers-cancel-test",
  script: beforeHeadersBundle.outputFiles[0].text,
  modules: true,
  compatibilityDate: "2026-09-06",
  host: "127.0.0.1",
  port: 0,
  cf: false,
  telemetry: { enabled: false },
  serviceBindings: { ONEAPI_LOCAL_OUTBOUND: beforeHeadersService.handler },
  outboundService: async () => {
    throw new Error("test Worker bypassed local outbound binding");
  }
}));
try {
  await beforeHeadersBridge.ready;
  const response = await beforeHeadersBridge.dispatchFetch("http://127.0.0.1/before-headers");
  assert.ok(response.status >= 500, `before-headers cancellation returned HTTP ${response.status}`);
  const beforeHeadersDeadline = Date.now() + 2_000;
  while (!beforeHeadersAbortObserved && Date.now() < beforeHeadersDeadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(beforeHeadersCalls, 1);
  assert.equal(beforeHeadersAbortObserved, true);
  assert.deepEqual(beforeHeadersService.snapshot(), { active: 0, pending: 0, groups: 0 });
} finally {
  beforeHeadersService.dispose();
  await beforeHeadersBridge.dispose();
}

async function send(runtime, path, init = {}) {
  return typeof runtime === "string"
    ? fetch(`${runtime}${path}`, init)
    : runtime.dispatchFetch(`${origin}${path}`, init);
}

async function openStreamingRequest(baseUrl, path, headers, body) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const request = httpRequest(new URL(path, baseUrl), { method: "POST", headers }, (response) => {
      response.once("data", (chunk) => {
        response.pause();
        settled = true;
        resolvePromise({
          chunk,
          destroy() {
            response.destroy();
          }
        });
      });
      response.once("error", (error) => {
        if (!settled) reject(error);
      });
    });
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    request.end(body);
  });
}

async function json(runtime, path, init = {}) {
  const response = await send(runtime, path, init);
  const value = await response.json();
  assert.ok(response.ok, `${path} 返回 HTTP ${response.status}`);
  return { response, value };
}

function mutationHeaders(cookie, requestOrigin = origin) {
  return { Cookie: cookie, Origin: requestOrigin, "Content-Type": "application/json" };
}

async function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close(() => resolvePromise(address.port));
    });
  });
}

async function startWrangler(persistRoot) {
  const port = await freePort();
  const child = spawn(process.execPath, [
    resolve("node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--config", configPath,
    "--local",
    "--ip", "127.0.0.1",
    "--port", String(port),
    "--persist-to", persistRoot,
    "--name", "oneapi-codex-gateway-demo",
    "--env-file", resolve("test/mock.env"),
    "--var", "MOCK_UPSTREAM:true",
    "--show-interactive-dev-session=false",
    "--log-level", "none"
  ], {
    cwd: resolve("."),
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true
  });
  let exited = false;
  child.once("exit", () => { exited = true; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return {
          baseUrl,
          async close() {
            if (exited) return;
            child.kill("SIGINT");
            await new Promise((resolvePromise) => child.once("exit", resolvePromise));
          }
        };
      }
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  child.kill();
  throw new Error("隔离 Wrangler 实例未能启动。");
}

async function startNodeLockHolder(persistRoot) {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve("scripts/dev-local.mjs"), "--mock"], {
    cwd: resolve("."),
    env: {
      ...process.env,
      ONEAPI_NODE_PERSIST_ROOT: persistRoot,
      ONEAPI_NODE_PORT: String(port)
    },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true
  });
  let exited = false;
  child.once("exit", () => { exited = true; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !exited) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) {
        return {
          async crash() {
            if (exited) return;
            child.kill("SIGKILL");
            await new Promise((resolvePromise) => child.once("exit", resolvePromise));
          }
        };
      }
    } catch {
      // The child runtime is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  child.kill("SIGKILL");
  throw new Error("跨进程锁测试实例未能启动。");
}

const persistence = await mkdtemp(resolve(tmpdir(), "oneapi-dev-node-"));
let wrangler;
let lockHolder;
let second;
let cancellationRuntime;
let third;
try {
  wrangler = await startWrangler(persistence);
  const login = await json(wrangler.baseUrl, "/admin/session", {
    method: "POST",
    headers: { Origin: wrangler.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ password: adminKey })
  });
  const cookie = login.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie?.startsWith("oneapi_admin_session="), "管理员会话未创建。");
  const started = await json(wrangler.baseUrl, "/admin/device/start", {
    method: "POST",
    headers: mutationHeaders(cookie, wrangler.baseUrl),
    body: "{}"
  });
  await new Promise((resolvePromise) => {
    setTimeout(resolvePromise, Math.max(30, Number(started.value.nextPollAt) - Date.now() + 2));
  });
  const connected = await json(wrangler.baseUrl, "/admin/device/poll", {
    method: "POST",
    headers: mutationHeaders(cookie, wrangler.baseUrl),
    body: JSON.stringify({ login_id: started.value.id })
  });
  assert.equal(connected.value.status, "connected");
  const created = await json(wrangler.baseUrl, "/admin/api-keys", {
    method: "POST",
    headers: mutationHeaders(cookie, wrangler.baseUrl),
    body: JSON.stringify({ name: "node-runtime-restart-proof" })
  });
  assert.equal(typeof created.value.key, "string");
  const createdKey = created.value.key;
  await wrangler.close();
  wrangler = undefined;

  const nodePersistRoot = resolve(persistence, "v3");
  lockHolder = await startNodeLockHolder(nodePersistRoot);
  await assert.rejects(
    createRuntime({ useMock: true, persistRoot: nodePersistRoot, requestedPort: 0 }),
    /另一个 OneAPI Node 进程占用/
  );
  const crossProcessParallelRoot = resolve(persistence, "cross-process-parallel", "v3");
  const crossProcessParallel = await createRuntime({
    useMock: true, persistRoot: crossProcessParallelRoot, requestedPort: 0
  });
  await crossProcessParallel.dispose();
  await lockHolder.crash();
  lockHolder = undefined;

  second = await createRuntime({ useMock: true, persistRoot: nodePersistRoot, requestedPort: 0 });
  await second.ready;
  await assert.rejects(
    createRuntime({ useMock: true, persistRoot: nodePersistRoot, requestedPort: 0 }),
    /另一个 OneAPI Node 进程占用/
  );
  const parallelRoot = resolve(persistence, "parallel", "v3");
  const parallel = await createRuntime({ useMock: true, persistRoot: parallelRoot, requestedPort: 0 });
  await parallel.dispose();
  const restoredSession = await json(second, "/admin/session", { headers: { Cookie: cookie } });
  assert.equal(restoredSession.value.authenticated, true);
  const status = await json(second, "/admin/status", { headers: { Cookie: cookie } });
  assert.equal(status.value.connected, true);
  const keys = await json(second, "/admin/api-keys", { headers: { Cookie: cookie } });
  assert.equal(keys.value.data.some((entry) => entry.name === "node-runtime-restart-proof"), true);
  const models = await json(second, "/admin/test/models", { headers: { Cookie: cookie } });
  assert.equal(models.value.data.some((entry) => entry.id === "gpt-mock"), true);
  const generated = await json(second, "/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${createdKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-mock", input: "restart proof", stream: false })
  });
  assert.equal(generated.value.status, "completed");
  assert.equal(generated.value.output_text, "你好，mock");
  await second.dispose();
  second = undefined;

  let workerDoOutboundCalls = 0;
  const workerDoAborted = new Set();
  const workerDoSourceCancelled = new Set();
  cancellationRuntime = await createRuntime({
    useMock: true,
    persistRoot: nodePersistRoot,
    requestedPort: 0,
    localOutboundFetch: async (request) => {
      workerDoOutboundCalls += 1;
      assert.equal(request.headers.has(localRequestHeader), false);
      assert.equal(request.headers.has(localRequestGroupHeader), false);
      assert.equal(new URL(request.url).pathname, "/backend-api/codex/responses");
      const payload = await request.json();
      const encodedInput = JSON.stringify(payload.input);
      const marker = ["front-a", "front-b", "after-cancel"].find((value) => encodedInput.includes(value)) ?? encodedInput;
      if (marker === "after-cancel") {
        const item = { id: "msg_after", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "after cancel", annotations: [] }] };
        const completed = { id: "resp_after", object: "response", status: "completed", model: "gpt-mock", output: [item], output_text: "after cancel" };
        const body = [
          `event: response.output_item.done\r\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\r\n\r\n`,
          `event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\r\n\r\n`
        ].join("");
        return new NodeResponse(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      return new NodeResponse(new ReadableStream({
        start(controller) {
          request.signal.addEventListener("abort", () => {
            workerDoAborted.add(marker);
          }, { once: true });
          controller.enqueue(new TextEncoder().encode(
            `event: response.created\r\ndata: ${JSON.stringify({ type: "response.created", response: { id: `resp_${marker}`, status: "in_progress", output: [] } })}\r\n\r\n`
          ));
        },
        cancel() {
          workerDoSourceCancelled.add(marker);
        }
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
    localOutboundOptions: { controlTimeoutMs: 100, generationTimeoutMs: 60_000 }
  });
  const cancellationOrigin = (await cancellationRuntime.ready).origin;
  const spoofedGroup = crypto.randomUUID();
  const streamHeaders = {
    Authorization: `Bearer ${createdKey}`,
    "Content-Type": "application/json",
    [localRequestGroupHeader]: spoofedGroup
  };
  const [frontA, frontB] = await Promise.all([
    openStreamingRequest(cancellationOrigin, "/v1/responses", streamHeaders, JSON.stringify({
      model: "gpt-mock", input: "front-a", stream: true
    })),
    openStreamingRequest(cancellationOrigin, "/v1/responses", streamHeaders, JSON.stringify({
      model: "gpt-mock", input: "front-b", stream: true
    }))
  ]);
  assert.match(frontA.chunk.toString("utf8"), /response\.created/);
  assert.match(frontB.chunk.toString("utf8"), /response\.created/);
  assert.deepEqual(cancellationRuntime.getLocalOutboundSnapshot(), { active: 2, pending: 0, groups: 2 });
  frontA.destroy();
  const frontADeadline = Date.now() + 2_000;
  while ((!workerDoAborted.has("front-a") || !workerDoSourceCancelled.has("front-a")) && Date.now() < frontADeadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.deepEqual(cancellationRuntime.getLocalOutboundSnapshot(), { active: 1, pending: 0, groups: 1 });
  assert.equal(workerDoAborted.has("front-a"), true);
  assert.equal(workerDoSourceCancelled.has("front-a"), true);
  assert.equal(workerDoAborted.has("front-b"), false);
  assert.equal(workerDoSourceCancelled.has("front-b"), false);
  assert.equal(workerDoOutboundCalls, 2);
  frontB.destroy();
  const frontBDeadline = Date.now() + 2_000;
  while ((!workerDoAborted.has("front-b") || !workerDoSourceCancelled.has("front-b")) && Date.now() < frontBDeadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(workerDoAborted.has("front-b"), true);
  assert.equal(workerDoSourceCancelled.has("front-b"), true);
  const oversizedResponse = await fetch(`${cancellationOrigin}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${createdKey}`, "Content-Type": "application/json" },
    body: "x".repeat(1024 * 1024 + 1)
  });
  assert.equal(oversizedResponse.status, 413);
  assert.equal(oversizedResponse.headers.get("content-type"), "application/json");
  assert.equal(oversizedResponse.headers.get("x-content-type-options"), "nosniff");
  const oversizedError = await oversizedResponse.json();
  assert.equal(oversizedError.error.code, "request_too_large");
  assert.equal(oversizedError.error.param, "body");
  assert.equal(workerDoOutboundCalls, 2);
  const afterCancel = await json(cancellationOrigin, "/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${createdKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-mock", input: "after-cancel", stream: false })
  });
  assert.equal(afterCancel.value.status, "completed");
  assert.equal(afterCancel.value.output_text, "after cancel");
  assert.equal(workerDoOutboundCalls, 3);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(cancellationRuntime.getLocalOutboundSnapshot(), { active: 0, pending: 0, groups: 0 });
  await cancellationRuntime.dispose();
  cancellationRuntime = undefined;

  third = await createRuntime({ useMock: true, persistRoot: nodePersistRoot, requestedPort: 0 });
  await third.ready;
  const finalStatus = await json(third, "/admin/status", {
    headers: { Authorization: `Bearer ${adminKey}` }
  });
  assert.equal(finalStatus.value.connected, true);
  const finalKeys = await json(third, "/admin/api-keys", {
    headers: { Authorization: `Bearer ${adminKey}` }
  });
  assert.equal(finalKeys.value.data.some((entry) => entry.name === "node-runtime-restart-proof"), true);
  console.log(JSON.stringify({
    ok: true,
    adminSessionRestored: true,
    accountRestored: true,
    apiKeyRestored: true,
    generationAfterRestart: true,
    secondRestartRestored: true,
    sameStoreRejected: true,
    differentStoreAllowed: true,
    releasedStoreRestarted: true,
    nodeOutboundBridge: true,
    outboundRejectionMatrix: true,
    redirectsRejectedBeforeWorkerd: true,
    streamCancelPropagation: true,
    abortPropagation: true,
    socketCloseCancellationPropagation: true,
    concurrentGroupIsolation: true,
    clientGroupHeaderOverwritten: true,
    frontBodyLimitContract: true,
    beforeHeadersCancellationPropagation: true,
    localOutboundHeaderStripped: true,
    localOutboundDeadlineCleanup: true,
    localOutboundDisposeCleanup: true,
    cancelBeforeRegisterHandled: true,
    crossProcessStoreLock: true,
    crashReleasedStoreLock: true
  }));
} finally {
  await wrangler?.close();
  await lockHolder?.crash();
  await second?.dispose();
  await cancellationRuntime?.dispose();
  await third?.dispose();
  await rm(persistence, { recursive: true, force: true });
}
