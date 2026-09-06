import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import {
  Headers as NodeHeaders,
  Miniflare,
  Request as NodeRequest,
  Response as NodeResponse,
  convertV4MiniflareOptions,
  fetch as nodeFetch
} from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { startLocalHttpServer } from "./local-http-server.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(projectRoot, "wrangler.jsonc");
const workerName = "oneapi-codex-gateway-demo";
const defaultPersistRoot = resolve(projectRoot, ".wrangler", "state", "v3");
const mock = process.argv.includes("--mock");
const localRequestIdHeader = "X-OneAPI-Local-Request-Id";
const localRequestGroupHeader = "X-OneAPI-Local-Request-Group";
const localControlOrigin = "https://oneapi-local-outbound.internal";
const localRequestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const allowedUpstream = new Map([
  ["auth.openai.com", new Map([
    ["/api/accounts/deviceauth/usercode", "POST"],
    ["/api/accounts/deviceauth/token", "POST"],
    ["/oauth/token", "POST"]
  ])],
  ["chatgpt.com", new Map([
    ["/backend-api/codex/models", "GET"],
    ["/backend-api/codex/responses", "POST"],
    ["/backend-api/wham/usage", "GET"]
  ])]
]);

export function createNodeOutbound(fetchImpl = nodeFetch, trace = process.env.ONEAPI_NODE_TRACE === "1") {
  let sequence = 0;
  return async (request) => {
    const url = new URL(request.url);
    const accessCerts = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(url.hostname) && url.pathname === "/cdn-cgi/access/certs";
    const expectedMethod = accessCerts ? "GET" : allowedUpstream.get(url.hostname)?.get(url.pathname);
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      request.method !== expectedMethod
    ) {
      throw new Error("本地 Node 出站拒绝未授权目标。");
    }
    if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/models") {
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 1 || keys[0] !== "client_version" || !url.searchParams.get("client_version")) {
        throw new Error("本地 Node 出站拒绝无效模型目录 query。");
      }
    } else if (url.search !== "") {
      throw new Error("本地 Node 出站拒绝未授权 query。");
    }
    const currentSequence = ++sequence;
    if (trace) {
      console.log(JSON.stringify({
        event: "node_outbound_start",
        sequence: currentSequence,
        method: request.method,
        pathname: url.pathname
      }));
    }
    if (request.headers.has("cf-worker") || request.headers.has("cf-connecting-ip")) {
      throw new Error("本地 Node 出站收到运行时注入的 Cloudflare 来源头，已拒绝发送。");
    }
    const startedAt = Date.now();
    let status = null;
    try {
      const headers = new NodeHeaders(request.headers);
      const body = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
      const upstreamRequest = new NodeRequest(url, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: request.signal,
        ...(body ? { duplex: "half" } : {})
      });
      const upstream = await fetchImpl(upstreamRequest);
      status = upstream.status;
      if (upstream.status >= 300 && upstream.status < 400) {
        try {
          await upstream.body?.cancel();
        } catch {
          // The redirect is rejected even if cancelling its body fails.
        }
        throw new Error("本地 Node 出站拒绝上游重定向。");
      }
      const responseHeaders = new NodeHeaders(upstream.headers);
      // Node fetch returns a decoded body while retaining these wire headers.
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      return new NodeResponse(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });
    } finally {
      if (trace) {
        console.log(JSON.stringify({
          event: "node_outbound",
          sequence: currentSequence,
          method: request.method,
          pathname: url.pathname,
          status,
          durationMs: Date.now() - startedAt
        }));
      }
    }
  };
}

export function createLocalOutboundService({
  fetchImpl = nodeFetch,
  trace = process.env.ONEAPI_NODE_TRACE === "1",
  controlTimeoutMs = 10_000,
  generationTimeoutMs = 5 * 60 * 1000,
  pendingCancelTtlMs = 5_000,
  maxPendingCancels = 256
} = {}) {
  const outbound = createNodeOutbound(fetchImpl, trace);
  const active = new Map();
  const pendingCancels = new Map();
  const recentlyFinished = new Map();
  const openGroups = new Set();

  function removePending(requestId) {
    const timer = pendingCancels.get(requestId);
    if (timer) clearTimeout(timer);
    pendingCancels.delete(requestId);
  }

  function rememberPending(requestId) {
    if (pendingCancels.has(requestId)) return;
    if (pendingCancels.size >= maxPendingCancels) {
      throw new Error("本地 Node 取消队列已满。");
    }
    const timer = setTimeout(() => pendingCancels.delete(requestId), pendingCancelTtlMs);
    timer.unref?.();
    pendingCancels.set(requestId, timer);
  }

  function rememberFinished(requestId) {
    const existing = recentlyFinished.get(requestId);
    if (existing) clearTimeout(existing);
    if (!existing && recentlyFinished.size >= maxPendingCancels) {
      const oldest = recentlyFinished.keys().next().value;
      if (oldest) {
        clearTimeout(recentlyFinished.get(oldest));
        recentlyFinished.delete(oldest);
      }
    }
    const timer = setTimeout(() => recentlyFinished.delete(requestId), pendingCancelTtlMs);
    timer.unref?.();
    recentlyFinished.set(requestId, timer);
  }

  async function handler(request) {
    const url = new URL(request.url);
    if (url.origin === localControlOrigin) {
      const match = /^\/cancel\/([^/]+)$/.exec(url.pathname);
      if (request.method !== "POST" || url.search !== "" || !match || !localRequestIdPattern.test(match[1])) {
        throw new Error("本地 Node 取消请求无效。");
      }
      const requestId = match[1].toLowerCase();
      if (recentlyFinished.has(requestId)) return new NodeResponse(null, { status: 204 });
      const entry = active.get(requestId);
      if (entry) {
        entry.abort();
      } else {
        rememberPending(requestId);
      }
      return new NodeResponse(null, { status: 204 });
    }

    const requestId = request.headers.get(localRequestIdHeader)?.toLowerCase() ?? "";
    if (!localRequestIdPattern.test(requestId)) {
      throw new Error("本地 Node 出站缺少有效请求标识。");
    }
    if (active.has(requestId)) {
      throw new Error("本地 Node 出站请求标识重复。");
    }
    const headers = new NodeHeaders(request.headers);
    headers.delete(localRequestIdHeader);
    const groupId = headers.get(localRequestGroupHeader)?.toLowerCase() ?? "";
    if (groupId && !localRequestIdPattern.test(groupId)) {
      throw new Error("本地 Node 出站请求组无效。");
    }
    headers.delete(localRequestGroupHeader);
    const controller = new AbortController();
    let bodyReader;
    let finished = false;
    const timeoutMs = url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/responses"
      ? generationTimeoutMs
      : controlTimeoutMs;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      active.delete(requestId);
      removePending(requestId);
      rememberFinished(requestId);
    };
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(new Error("local upstream cancelled"));
      void bodyReader?.cancel("local upstream cancelled").catch(() => undefined);
      finish();
    };
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    active.set(requestId, { abort, groupId });
    if (pendingCancels.has(requestId)) {
      removePending(requestId);
      abort();
    }
    if (groupId && !openGroups.has(groupId)) abort();
    if (controller.signal.aborted) {
      finish();
      throw new Error("本地 Node 出站请求已取消。");
    }

    let streaming = false;
    try {
      const upstream = await outbound(new NodeRequest(request, {
        headers,
        signal: controller.signal
      }));
      if (!upstream.body) return upstream;
      bodyReader = upstream.body.getReader();
      const body = new ReadableStream({
        async pull(streamController) {
          try {
            const next = await bodyReader.read();
            if (next.done) {
              finish();
              streamController.close();
            } else {
              streamController.enqueue(next.value);
            }
          } catch (error) {
            finish();
            streamController.error(error);
          }
        },
        async cancel(reason) {
          abort();
          await bodyReader.cancel(reason).catch(() => undefined);
          finish();
        }
      });
      const response = new NodeResponse(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers
      });
      streaming = true;
      return response;
    } finally {
      if (!streaming) finish();
    }
  }

  return {
    handler,
    snapshot: () => ({ active: active.size, pending: pendingCancels.size, groups: openGroups.size }),
    openGroup(groupId) {
      const normalized = typeof groupId === "string" ? groupId.toLowerCase() : "";
      if (!localRequestIdPattern.test(normalized)) return false;
      if (openGroups.has(normalized)) return true;
      if (openGroups.size >= maxPendingCancels) return false;
      openGroups.add(normalized);
      return true;
    },
    closeGroup(groupId) {
      const normalized = typeof groupId === "string" ? groupId.toLowerCase() : "";
      if (localRequestIdPattern.test(normalized)) openGroups.delete(normalized);
    },
    cancelGroup(groupId) {
      const normalized = typeof groupId === "string" ? groupId.toLowerCase() : "";
      if (!localRequestIdPattern.test(normalized)) return;
      openGroups.delete(normalized);
      for (const entry of [...active.values()]) {
        if (entry.groupId === normalized) entry.abort();
      }
    },
    dispose() {
      for (const entry of [...active.values()]) entry.abort();
      for (const requestId of [...pendingCancels.keys()]) removePending(requestId);
      for (const timer of recentlyFinished.values()) clearTimeout(timer);
      recentlyFinished.clear();
      openGroups.clear();
    }
  };
}

async function assertPortAvailable(port) {
  if (port === 0) return;
  await new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolvePromise));
  });
}

async function acquireStoreLock(persistRoot) {
  await mkdir(persistRoot, { recursive: true });
  const canonicalRoot = await realpath(persistRoot);
  const lockPath = resolve(canonicalRoot, ".oneapi-node-runtime.lock.sqlite");
  const database = new DatabaseSync(lockPath);
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch {
    database.close();
    throw new Error("本地存储已被另一个 OneAPI Node 进程占用。");
  }
  let released = false;
  return {
    canonicalRoot,
    async release() {
      if (released) return;
      released = true;
      try {
        database.exec("ROLLBACK;");
      } finally {
        database.close();
      }
    }
  };
}

async function bundleWorker(main, define) {
  const result = await esbuild.build({
    absWorkingDir: projectRoot,
    entryPoints: [resolve(projectRoot, main)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*"],
    define,
    logLevel: "silent"
  });
  assert.equal(result.outputFiles.length, 1, "Worker bundle 应只有一个输出文件。");
  return result.outputFiles[0].text;
}

export async function createRuntime({
  useMock = mock,
  persistRoot: requestedPersistRoot = process.env.ONEAPI_NODE_PERSIST_ROOT,
  requestedPort = process.env.ONEAPI_NODE_PORT,
  localOutboundFetch,
  localOutboundOptions
} = {}) {
  const { workerOptions, define, main, externalWorkers } =
    unstable_getMiniflareWorkerOptions(configPath, useMock ? "test" : undefined, {
      overrides: { enableContainers: false }
    });
  assert.ok(main, "wrangler.jsonc 缺少 Worker main 入口。");
  assert.equal(externalWorkers.length, 0, "本地 Node 启动器不支持外部 Worker。");
  const bindings = {
    ...(workerOptions.bindings ?? {}),
    ...(useMock ? { MOCK_INSTANCE_NONCE: crypto.randomUUID() } : {}),
    ...(useMock && !localOutboundFetch ? { MOCK_UPSTREAM: "true" } : {})
  };
  const {
    modulesRules: _bundledModuleRules,
    serviceBindings: configuredServiceBindings,
    ...runtimeWorkerOptions
  } = workerOptions;
  for (const key of ["ADMIN_API_KEY", "GATEWAY_API_KEY", "TOKEN_ENCRYPTION_KEY"]) {
    assert.equal(typeof bindings[key], "string", `缺少 ${key}；先运行 npm run setup。`);
    assert.ok(bindings[key].length > 0, `${key} 不能为空。`);
  }
  const script = await bundleWorker(main, define);
  if (useMock) {
    if (typeof requestedPersistRoot !== "string") {
      throw new Error("--mock 必须通过 ONEAPI_NODE_PERSIST_ROOT 指定隔离存储目录。");
    }
    assert.notEqual(resolve(requestedPersistRoot), defaultPersistRoot, "--mock 不得使用真实本地存储目录。");
  }
  const persistRoot = requestedPersistRoot ? resolve(requestedPersistRoot) : defaultPersistRoot;
  const port = requestedPort !== undefined && requestedPort !== "" ? Number(requestedPort) : 8787;
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, "ONEAPI_NODE_PORT 必须是有效端口。");
  await assertPortAvailable(port);
  const storeLock = await acquireStoreLock(persistRoot);
  const useLocalOutbound = !useMock || Boolean(localOutboundFetch);
  const localOutbound = useLocalOutbound ? createLocalOutboundService({
    ...(localOutboundOptions ?? {}),
    ...(localOutboundFetch ? { fetchImpl: localOutboundFetch } : {})
  }) : undefined;
  let runtime;
  let frontServer;
  try {
    runtime = new Miniflare(convertV4MiniflareOptions({
    ...runtimeWorkerOptions,
    name: workerName,
    script,
    modules: true,
    bindings,
    rootPath: projectRoot,
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    resourcePersistencePath: persistRoot,
    // Miniflare normally adds CF-Worker before a custom outbound service.
    // This preserves the headers created by src/codex/*.ts for Node fetch.
    stripCfConnectingIp: false,
    serviceBindings: useLocalOutbound ? {
      ...(configuredServiceBindings ?? {}),
      ONEAPI_LOCAL_OUTBOUND: localOutbound.handler
    } : configuredServiceBindings,
    outboundService: async () => {
      throw new Error("本地运行时拒绝绕过私有出站 binding 的 global fetch。");
    }
    }));
    await runtime.ready;
    const groupControl = async (action, groupId) => {
      const response = await runtime.dispatchFetch(`https://oneapi.internal/__internal/request-groups/${action}?group_id=${encodeURIComponent(groupId)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bindings.TOKEN_ENCRYPTION_KEY}` }
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status !== 204) throw new Error("本地请求组控制失败。");
    };
    frontServer = await startLocalHttpServer({
      runtime,
      port,
      bridgeToken: bindings.TOKEN_ENCRYPTION_KEY,
      openGroup: async (groupId) => {
        if (localOutbound && !localOutbound.openGroup(groupId)) return false;
        try {
          await groupControl("open", groupId);
          return true;
        } catch {
          localOutbound?.closeGroup(groupId);
          await groupControl("close", groupId).catch(() => undefined);
          return false;
        }
      },
      cancelGroup: async (groupId) => {
        try {
          await groupControl("cancel", groupId);
        } finally {
          localOutbound?.cancelGroup(groupId);
        }
      },
      closeGroup: async (groupId) => {
        try {
          await groupControl("close", groupId);
        } finally {
          localOutbound?.closeGroup(groupId);
        }
      }
    });
  } catch (error) {
    localOutbound?.dispose();
    await frontServer?.close();
    await runtime?.dispose();
    await storeLock.release();
    throw error;
  }
  const disposeRuntime = runtime.dispose.bind(runtime);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await frontServer.close();
      localOutbound?.dispose();
      await disposeRuntime();
    } finally {
      await storeLock.release();
    }
  };
  return {
    ready: Promise.resolve(frontServer.url),
    dispatchFetch: runtime.dispatchFetch.bind(runtime),
    getDurableObjectNamespace: runtime.getDurableObjectNamespace.bind(runtime),
    getLocalOutboundSnapshot: () => localOutbound?.snapshot(),
    dispose
  };
}

async function main() {
  const runtime = await createRuntime();
  const url = await runtime.ready;
  console.log(`OneAPI 本地 Node 出站服务已启动：${url.origin}`);
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await runtime.dispose();
  }
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
