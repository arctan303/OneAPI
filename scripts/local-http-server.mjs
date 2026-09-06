import { createServer } from "node:http";
import { Headers as MiniflareHeaders } from "miniflare";

export const LOCAL_REQUEST_GROUP_HEADER = "X-OneAPI-Local-Request-Group";
export const LOCAL_BRIDGE_TOKEN_HEADER = "X-OneAPI-Local-Bridge-Token";

const LISTEN_HOST = "127.0.0.1";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function requestHeaders(request, groupId, bridgeToken, bodyLength, hasBodySemantics) {
  const connectionHeaders = new Set(
    String(request.headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
  const headers = new MiniflareHeaders();
  for (const [name, value] of Object.entries(request.headers)) {
    const normalizedName = name.toLowerCase();
    if (
      normalizedName === LOCAL_REQUEST_GROUP_HEADER.toLowerCase()
      || normalizedName === LOCAL_BRIDGE_TOKEN_HEADER.toLowerCase()
      || normalizedName === "content-length"
      || HOP_BY_HOP_HEADERS.has(normalizedName)
      || connectionHeaders.has(normalizedName)
      || value === undefined
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  headers.set(LOCAL_REQUEST_GROUP_HEADER, groupId);
  headers.set(LOCAL_BRIDGE_TOKEN_HEADER, bridgeToken);
  if (hasBodySemantics) headers.set("Content-Length", String(bodyLength));
  return headers;
}

function readRequestBody(request) {
  const declaredLength = request.headers["content-length"];
  if (
    typeof declaredLength === "string"
    && /^[0-9]+$/.test(declaredLength)
    && Number(declaredLength) > MAX_REQUEST_BODY_BYTES
  ) {
    request.resume();
    return Promise.resolve({ oversized: true });
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        request.resume();
        finish({ oversized: true });
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => finish({ oversized: false, body: Buffer.concat(chunks, total) });
    const onError = (error) => finish(undefined, error);
    const onAborted = () => finish(undefined, new Error("client request aborted"));

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function sendJsonError(response, status, code, message, param, type = "invalid_request_error", closeConnection = true) {
  const body = Buffer.from(JSON.stringify({
    error: {
      message,
      type,
      code,
      ...(param ? { param } : {})
    }
  }));
  for (const name of response.getHeaderNames()) response.removeHeader(name);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(closeConnection ? { Connection: "close" } : {})
  });
  response.end(body);
}

function setResponseHeaders(target, source) {
  const connectionHeaders = new Set(
    String(source.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
  for (const [name, value] of source) {
    const normalizedName = name.toLowerCase();
    if (
      normalizedName !== "set-cookie"
      && !HOP_BY_HOP_HEADERS.has(normalizedName)
      && !connectionHeaders.has(normalizedName)
    ) {
      target.setHeader(name, value);
    }
  }

  const setCookies = typeof source.getSetCookie === "function"
    ? source.getSetCookie()
    : [];
  if (setCookies.length > 0) {
    target.setHeader("Set-Cookie", setCookies);
  } else {
    const setCookie = source.get("set-cookie");
    if (setCookie !== null) target.setHeader("Set-Cookie", setCookie);
  }
}

function waitForDrainOrClose(response) {
  return new Promise((resolve) => {
    const finish = () => {
      response.off("drain", finish);
      response.off("close", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
  });
}

function groupLifecycle(groupId, openGroup, cancelGroup, closeGroup) {
  let openAttempted = false;
  let opened = false;
  let cancelRequested = false;
  let cancelPromise;
  let finalizePromise;
  let reader;
  let readerCancelled = false;

  const cancelReader = () => {
    if (!reader || readerCancelled) return;
    readerCancelled = true;
    void reader.cancel("client disconnected").catch(() => undefined);
  };
  const cancelOpened = () => {
    if (!opened) return;
    cancelReader();
    cancelPromise ??= Promise.resolve()
      .then(() => cancelGroup(groupId))
      .catch(() => undefined);
  };
  const finalize = () => {
    if (!opened) return Promise.resolve();
    finalizePromise ??= Promise.resolve(cancelPromise)
      .then(() => closeGroup(groupId))
      .catch(() => undefined);
    return finalizePromise;
  };

  return {
    async open() {
      if (openAttempted) return opened && !cancelRequested;
      openAttempted = true;
      const accepted = await openGroup(groupId);
      if (accepted === false) return false;
      opened = true;
      if (cancelRequested) cancelOpened();
      return !cancelRequested;
    },
    cancel() {
      cancelRequested = true;
      cancelOpened();
    },
    close: finalize,
    finalize,
    get requested() {
      return cancelRequested;
    },
    setReader(nextReader) {
      reader = nextReader;
      if (cancelRequested) cancelReader();
    }
  };
}

async function pumpResponse(source, target, lifecycle) {
  if (!source.body) {
    target.end();
    return;
  }

  const reader = source.body.getReader();
  lifecycle.setReader(reader);
  if (lifecycle.requested || target.destroyed) return;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (target.destroyed) return;
      if (!target.write(Buffer.from(next.value))) {
        await waitForDrainOrClose(target);
        if (target.destroyed) return;
      }
    }
    if (!target.destroyed) target.end();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled reader may already have released its lock.
    }
  }
}

export async function startLocalHttpServer({ runtime, port, bridgeToken, openGroup, cancelGroup, closeGroup }) {
  if (!runtime || typeof runtime.dispatchFetch !== "function") {
    throw new TypeError("runtime.dispatchFetch is required");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("port must be an integer between 0 and 65535");
  }
  if (typeof bridgeToken !== "string" || bridgeToken.length === 0) {
    throw new TypeError("bridgeToken is required");
  }
  if (typeof openGroup !== "function" || typeof cancelGroup !== "function" || typeof closeGroup !== "function") {
    throw new TypeError("openGroup, cancelGroup and closeGroup are required");
  }

  const server = createServer((request, response) => {
    const groupId = crypto.randomUUID();
    const lifecycle = groupLifecycle(groupId, openGroup, cancelGroup, closeGroup);
    request.once("aborted", lifecycle.cancel);
    response.once("close", () => {
      if (!response.writableEnded) lifecycle.cancel();
    });

    void (async () => {
      try {
      const opened = await lifecycle.open();
      if (!opened) {
        if (!lifecycle.requested && !response.destroyed) {
          sendJsonError(response, 503, "local_capacity_exhausted", "本地请求并发容量已满。", undefined, "server_error");
        }
        return;
      }
      const collected = await readRequestBody(request);
      if (collected.oversized) {
        sendJsonError(response, 413, "request_too_large", "请求体超过本地 1 MiB 限制。", "body", "invalid_request_error", false);
        lifecycle.close();
        return;
      }
      if (lifecycle.requested || response.destroyed) return;

      const method = request.method ?? "GET";
      const hasBodySemantics = method !== "GET" && method !== "HEAD";
      if (!hasBodySemantics && collected.body.byteLength > 0) {
        sendJsonError(response, 400, "invalid_request_body", "GET 或 HEAD 请求不能包含请求体。", "body");
        lifecycle.close();
        return;
      }
      const headers = requestHeaders(request, groupId, bridgeToken, collected.body.byteLength, hasBodySemantics);
      const host = headers.get("host") ?? LISTEN_HOST;
      let targetUrl;
      try {
        const baseOrigin = new URL("http://" + host).origin;
        const pathAndQuery = request.url?.startsWith("/") ? request.url : "/" + (request.url ?? "");
        const target = new URL(pathAndQuery, baseOrigin);
        if (target.origin !== baseOrigin) throw new Error("request target changed origin");
        targetUrl = target.href;
      } catch {
        sendJsonError(response, 400, "invalid_request_target", "请求目标无效。");
        lifecycle.close();
        return;
      }

      const body = hasBodySemantics && collected.body.byteLength > 0 ? collected.body : undefined;
      const runtimeResponse = await runtime.dispatchFetch(targetUrl, {
        method,
        headers,
        body,
        redirect: "manual",
        ...(body ? { duplex: "half" } : {})
      });
      if (lifecycle.requested || response.destroyed) {
        await runtimeResponse.body?.cancel("client disconnected").catch(() => undefined);
        return;
      }

      response.statusCode = runtimeResponse.status;
      if (runtimeResponse.statusText) response.statusMessage = runtimeResponse.statusText;
      setResponseHeaders(response, runtimeResponse.headers);
      await pumpResponse(runtimeResponse, response, lifecycle);
      } catch (error) {
        lifecycle.cancel();
        throw error;
      } finally {
        await lifecycle.finalize();
      }
    })().catch(() => {
      if (response.destroyed) return;
      if (!response.headersSent) {
        sendJsonError(response, 502, "local_runtime_error", "本地运行时请求失败。", undefined, "server_error");
      } else {
        response.destroy();
      }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LISTEN_HOST);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("local HTTP server did not expose a TCP address");
  }

  let closePromise;
  const close = () => {
    if (!closePromise) {
      closePromise = new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections?.();
      });
    }
    return closePromise;
  };

  return {
    url: new URL("http://" + LISTEN_HOST + ":" + address.port),
    close
  };
}
