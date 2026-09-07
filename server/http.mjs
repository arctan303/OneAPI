import { createServer } from 'node:http';
import { isLoopbackAddress, isLoopbackHost, isTrustedLanPeer, parseLanOrigins } from './network-config.mjs';

const MAX_BODY = 1024 * 1024;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const INTERNAL_HEADERS = new Set(['x-oneapi-local-request-group', 'x-oneapi-local-request-id', 'x-oneapi-local-bridge-token']);


function requestUrl(request, publicOrigin, lanOriginsByHost) {
  const hostCount = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === 'host').length;
  if (hostCount !== 1 || !request.headers.host || /[\s/@\\?#]/.test(request.headers.host)) throw new Error('invalid_host');
  const host = request.headers.host;
  let base;
  if (publicOrigin && host.toLowerCase() === new URL(publicOrigin).host.toLowerCase()) {
    base = publicOrigin;
  } else {
    const local = new URL('http://' + host);
    const hostname = local.hostname.replace(/^\[|\]$/g, '');
    const lanOrigin = lanOriginsByHost.get(local.host.toLowerCase());
    if (lanOrigin) {
      if (!isTrustedLanPeer(request.socket.remoteAddress)) throw new Error('host_not_allowed');
      base = lanOrigin;
    } else {
      if (!isLoopbackAddress(request.socket.remoteAddress) || !isLoopbackHost(hostname)) {
        throw new Error('host_not_allowed');
      }
      base = local.origin;
    }
  }
  const target = request.url ?? '/';
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) throw new Error('invalid_target');
  const parsed = new URL(target, base);
  if (parsed.origin !== base) throw new Error('invalid_target');
  return parsed;
}

function incomingHeaders(request) {
  const connectionNames = new Set(String(request.headers.connection ?? '').toLowerCase().split(',').map(x => x.trim()));
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_HEADERS.has(name) || connectionNames.has(name) || INTERNAL_HEADERS.has(name)
      || name === 'content-length' || name.startsWith('x-forwarded-') || name === 'forwarded') continue;
    if (Array.isArray(value)) for (const part of value) headers.append(name, part);
    else headers.set(name, value);
  }
  return headers;
}

function readBody(request) {
  if (Number(request.headers['content-length'] ?? 0) > MAX_BODY) {
    request.resume();
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      request.off('data', onData); request.off('end', onEnd);
      request.off('error', onError); request.off('aborted', onAborted);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { cleanup(); request.resume(); resolve(null); }
      else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const onError = () => { cleanup(); reject(new Error('request_read_failed')); };
    const onAborted = () => { cleanup(); reject(new Error('client_disconnected')); };
    request.on('data', onData); request.once('end', onEnd);
    request.once('error', onError); request.once('aborted', onAborted);
  });
}

function sendError(response, status, code) {
  if (response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  for (const header of response.getHeaderNames()) response.removeHeader(header);
  const body = JSON.stringify({ error: { code, type: status >= 500 ? 'server_error' : 'invalid_request_error', message: code } });
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function writeHeaders(response, source) {
  const connectionNames = new Set((source.headers.get('connection') ?? '').toLowerCase().split(',').map(x => x.trim()));
  response.statusCode = source.status;
  for (const [name, value] of source.headers) {
    if (name !== 'set-cookie' && !HOP_HEADERS.has(name) && !connectionNames.has(name)) response.setHeader(name, value);
  }
  const cookies = source.headers.getSetCookie();
  if (cookies.length) response.setHeader('Set-Cookie', cookies);
}

async function pump(source, response, signal, method) {
  if (method === 'HEAD' || !source.body) {
    if (source.body) void source.body.cancel().catch(() => {});
    response.end();
    return;
  }
  const reader = source.body.getReader();
  const cancel = () => { void reader.cancel('client disconnected').catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) { cancel(); return; }
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted || response.destroyed) break;
      if (done) { response.end(); break; }
      if (!response.write(value)) {
        await new Promise((resolve, reject) => {
          const clear = () => { response.off('drain', drained); response.off('close', closed); response.off('error', closed); };
          const drained = () => { clear(); resolve(); };
          const closed = () => { clear(); reject(new Error('client_disconnected')); };
          response.once('drain', drained); response.once('close', closed); response.once('error', closed);
          if (response.destroyed) closed();
        });
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (signal.aborted || response.destroyed) cancel();
    reader.releaseLock();
  }
}

export async function startHttpServer({ runtime, host = '127.0.0.1', port = 8787, publicOrigin, lanOrigins = [] }) {
  const configuredLanOrigins = Array.isArray(lanOrigins) ? lanOrigins.flatMap(parseLanOrigins) : parseLanOrigins(lanOrigins);
  const lanOriginsByHost = new Map();
  for (const origin of configuredLanOrigins) {
    const hostKey = new URL(origin).host.toLowerCase();
    if (lanOriginsByHost.has(hostKey) && lanOriginsByHost.get(hostKey) !== origin) {
      throw new Error('LAN_ORIGINS cannot contain both HTTP and HTTPS for the same host');
    }
    lanOriginsByHost.set(hostKey, origin);
  }
  const controllers = new Set();
  const pending = new Set();
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 5_000 }, (request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => { if (!controller.signal.aborted) controller.abort(new Error('client disconnected')); };
    request.once('aborted', abort);
    const onClose = () => { if (!response.writableEnded) abort(); };
    response.once('close', onClose);
    const task = (async () => {
      let url;
      try { url = requestUrl(request, publicOrigin, lanOriginsByHost); }
      catch { request.resume(); sendError(response, 403, 'host_or_target_not_allowed'); return; }
      const body = await readBody(request);
      if (body === null) { sendError(response, 413, 'request_too_large'); return; }
      if (controller.signal.aborted || response.destroyed) return;
      const method = request.method ?? 'GET';
      if (['GET', 'HEAD'].includes(method) && body.length) { sendError(response, 400, 'invalid_request_body'); return; }
      const headers = incomingHeaders(request);
      const input = new Request(url, { method, headers, signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(method) && body.length ? { body, duplex: 'half' } : {}) });
      const result = await runtime.fetch(input, { remoteAddress: request.socket.remoteAddress });
      if (controller.signal.aborted || response.destroyed) { void result.body?.cancel().catch(() => {}); return; }
      writeHeaders(response, result);
      await pump(result, response, controller.signal, method);
    })().catch(() => {
      abort();
      sendError(response, 502, 'server_request_failed');
    }).finally(() => {
      request.off('aborted', abort); response.off('close', onClose);
      controllers.delete(controller); pending.delete(task);
    });
    pending.add(task);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const url = new URL(`http://${address.family === 'IPv6' ? '[' + address.address + ']' : address.address}:${address.port}`);
  let closing;
  return {
    url,
    close() {
      closing ??= (async () => {
        for (const controller of controllers) controller.abort(new Error('server shutdown'));
        await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
        await Promise.allSettled([...pending]);
      })();
      return closing;
    },
  };
}
