import { createServer } from "node:http";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const EXPERIMENT_TIMEOUT_MS = 30_000;
const startedAt = Date.now();
let echoServer;
let runtime;
let timedOut = false;

function remainingMs() {
  return Math.max(1, EXPERIMENT_TIMEOUT_MS - (Date.now() - startedAt));
}

function assertWithinDeadline() {
  if (Date.now() - startedAt >= EXPERIMENT_TIMEOUT_MS) {
    timedOut = true;
    throw new Error("experiment timeout");
  }
}

function listenEchoServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const headers = request.headers;
      const summary = {
        "cf-worker": headers["cf-worker"] ?? null,
        "user-agent": headers["user-agent"] ?? null,
        "accept-encoding": headers["accept-encoding"] ?? null,
        "has-authorization": Object.hasOwn(headers, "authorization"),
        "has-cookie": Object.hasOwn(headers, "cookie"),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(summary));
    });
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string" || address.port === 8787) {
        server.close(() => reject(new Error("invalid echo port")));
        return;
      }
      echoServer = server;
      resolve(`http://127.0.0.1:${address.port}/echo`);
    });
  });
}

function parseSummary(body) {
  const value = JSON.parse(body);
  const keys = [
    "cf-worker",
    "user-agent",
    "accept-encoding",
    "has-authorization",
    "has-cookie",
  ];
  if (
    !value ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    value["has-authorization"] !== false ||
    value["has-cookie"] !== false
  ) {
    throw new Error("unexpected header summary");
  }
  return value;
}

async function fetchSummary(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("echo request failed");
  return parseSummary(await response.text());
}

async function disposeWithDeadline() {
  if (!runtime) return;
  let cleanupTimer;
  const dispose = Promise.resolve().then(() => runtime.dispose());
  try {
    await Promise.race([
      dispose,
      new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error("runtime cleanup timeout")), Math.min(2_000, remainingMs()));
        cleanupTimer.unref?.();
      }),
    ]);
    runtime = undefined;
  } finally {
    if (cleanupTimer) clearTimeout(cleanupTimer);
  }
}

async function closeEchoServer() {
  if (!echoServer) return;
  echoServer.closeAllConnections?.();
  const server = echoServer;
  echoServer = undefined;
  let closeTimer;
  try {
    await Promise.race([
      new Promise((resolve) => server.close(() => resolve())),
      new Promise((resolve) => {
        closeTimer = setTimeout(resolve, Math.min(2_000, remainingMs()));
        closeTimer.unref?.();
      }),
    ]);
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
  }
}

async function run() {
  const echoUrl = await listenEchoServer();
  assertWithinDeadline();

  const nodeSummary = await fetchSummary(echoUrl, AbortSignal.timeout(Math.min(5_000, remainingMs())));
  assertWithinDeadline();

  const workerScript = `export default { async fetch() {
    const response = await fetch(${JSON.stringify(echoUrl)});
    return new Response(await response.text(), { status: response.status });
  } }`;
  const v4Options = {
    name: "diagnose-runtime-headers",
    modules: true,
    script: workerScript,
    compatibilityDate: "2026-09-06",
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    cacheAPI: false,
    stripCfConnectingIp: true,
    resourcePersistencePath: undefined,
    isolatedResourcePersistencePath: undefined,
    resourceTmpPath: undefined,
  };
  runtime = new Miniflare(convertV4MiniflareOptions(v4Options));
  const workerResponse = await runtime.dispatchFetch(
    "http://127.0.0.1/diagnose",
    { signal: AbortSignal.timeout(Math.min(10_000, remainingMs())) },
  );
  if (!workerResponse.ok) throw new Error("worker request failed");
  const workerSummary = parseSummary(await workerResponse.text());
  assertWithinDeadline();

  const result = { node: nodeSummary, worker: workerSummary };
  if (workerSummary["has-authorization"] || workerSummary["has-cookie"] || nodeSummary["has-authorization"] || nodeSummary["has-cookie"]) {
    throw new Error("credential header detected");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

let experimentTimer;
try {
  await Promise.race([
    run(),
    new Promise((_, reject) => {
      experimentTimer = setTimeout(() => {
        timedOut = true;
        reject(new Error("experiment timeout"));
      }, EXPERIMENT_TIMEOUT_MS);
      experimentTimer.unref?.();
    }),
  ]);
} catch {
  process.stderr.write(timedOut ? "diagnostic timed out\n" : "diagnostic failed\n");
  process.exitCode = 1;
} finally {
  if (experimentTimer) clearTimeout(experimentTimer);
  try {
    await disposeWithDeadline();
  } catch {
    process.exitCode = 1;
  }
  await closeEchoServer();
}
