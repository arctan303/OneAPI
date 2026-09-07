import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { fetch as nodeFetch } from 'miniflare';

const HOST = '127.0.0.1';
const PORT = 8791;
const SERVICE = 'oneapi-egress-relay';
const REQUEST_LIMIT = 64 * 1024;
const ENVELOPE_LIMIT = 96 * 1024;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const RESPONSE_ENVELOPE_LIMIT = 4 * 1024 * 1024;
const MAX_ACTIVE_UPSTREAM = 2;
const REPLAY_WINDOW_MS = 90_000;
const CLOCK_SKEW_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const GENERATE_TIMEOUT_MS = 60_000;
const PROTOCOL_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'relay-protocol.ts');
const OPERATIONS = new Set(['ping', 'models', 'usage', 'generate']);
const HEADER_NAMES = new Set(['authorization', 'chatgpt-account-id', 'accept', 'content-type', 'originator', 'user-agent', 'version']);
const RESPONSE_HEADERS = new Set(['content-type', 'server', 'cf-ray', 'cf-mitigated', 'x-request-id', 'openai-request-id', 'cf-request-id']);

function fixedError(status, category) {
  return { status, body: JSON.stringify({ error: category }) };
}

function parseRelayVars(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^(".*"|'.*')$/, '$1').replace(/^(['"])(.*)\1$/, '$2');
  }
  if (typeof values.ONEAPI_RELAY_KEY !== 'string' || !values.ONEAPI_RELAY_KEY) throw new Error('relay_key_missing');
  return { key: values.ONEAPI_RELAY_KEY };
}

async function loadProtocol(entry = PROTOCOL_ENTRY) {
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    sourcemap: false,
    logLevel: 'silent',
  });
  const source = built.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function targetFor(request, timeouts = {}) {
  const requestTimeoutMs = timeouts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const generationTimeoutMs = timeouts.generationTimeoutMs ?? GENERATE_TIMEOUT_MS;
  if (request.operation === 'models') {
    return {
      url: `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(request.clientVersion)}`,
      method: 'GET',
      timeoutMs: requestTimeoutMs,
    };
  }
  if (request.operation === 'usage') {
    return { url: 'https://chatgpt.com/backend-api/wham/usage', method: 'GET', timeoutMs: requestTimeoutMs };
  }
  return {
    url: 'https://chatgpt.com/backend-api/codex/responses',
    method: 'POST',
    timeoutMs: generationTimeoutMs,
    body: request.bodyText,
  };
}

function upstreamHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (HEADER_NAMES.has(normalized)) output[normalized] = value;
  }
  return output;
}

function boundedText(value, max = 512) {
  return typeof value === 'string' && value.length <= max && !/[\r\n]/.test(value);
}

async function readLimited(response, limit, controller) {
  const signal = controller.signal;
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('upstream_timeout');
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        controller.abort();
        await reader.cancel('upstream_body_too_large').catch(() => undefined);
        throw new Error('upstream_body_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function responseHeaderSubset(headers) {
  const output = {};
  for (const name of RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value && boundedText(value, 512)) output[name] = value;
  }
  return output;
}

function plainCategory(error) {
  const value = error instanceof Error ? error.message : '';
  return /^[a-z_]+$/.test(value) ? value : 'relay_failed';
}

export function createRelayServer({ key, fetchImpl = nodeFetch, protocol, now = () => Date.now(), port = PORT, requestTimeoutMs = REQUEST_TIMEOUT_MS, generationTimeoutMs = GENERATE_TIMEOUT_MS } = {}) {
  if (!key) throw new Error('relay_key_missing');
  if (!protocol?.decryptRelayRequest || !protocol?.encryptRelayResponse) throw new Error('relay_protocol_missing');
  if (protocol.parseRelayKey) protocol.parseRelayKey(key);
  const requestEnvelopeLimit = protocol.RELAY_REQUEST_ENVELOPE_MAX_BYTES ?? ENVELOPE_LIMIT;
  const responseBodyLimit = protocol.RELAY_RESPONSE_BODY_MAX_BYTES ?? RESPONSE_LIMIT;
  const responseEnvelopeLimit = protocol.RELAY_RESPONSE_ENVELOPE_MAX_BYTES ?? RESPONSE_ENVELOPE_LIMIT;
  const replays = new Map();
  let active = 0;
  const cleanReplays = () => {
    const cutoff = now() - REPLAY_WINDOW_MS;
    for (const [id, timestamp] of replays) if (timestamp < cutoff) replays.delete(id);
  };

  async function encryptedResponse(response, status = 200) {
    const encoded = JSON.stringify(await protocol.encryptRelayResponse(key, response));
    if (Buffer.byteLength(encoded) > responseEnvelopeLimit) return fixedError(413, 'response_too_large');
    return { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: encoded };
  }

  async function relay(request, incomingRequest, outgoingResponse) {
    cleanReplays();
    if (Math.abs(now() - request.issuedAt) > CLOCK_SKEW_MS) return fixedError(400, 'request_expired');
    if (replays.has(request.requestId)) return fixedError(409, 'request_replayed');
    if (replays.size >= 1000) return fixedError(503, 'replay_cache_full');
    replays.set(request.requestId, request.issuedAt);
    if (request.operation === 'ping') return encryptedResponse({ requestId: request.requestId, status: 200, headers: {}, service: SERVICE });
    if (active >= MAX_ACTIVE_UPSTREAM) return fixedError(503, 'upstream_busy');
    active += 1;
    const target = targetFor(request, { requestTimeoutMs, generationTimeoutMs });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, target.timeoutMs);
    incomingRequest?.once('aborted', cancel);
    outgoingResponse?.once('close', cancel);
    try {
      const headers = upstreamHeaders(request.headers);
      const upstream = await fetchImpl(target.url, {
        method: target.method,
        headers,
        body: target.body,
        redirect: 'error',
        signal: controller.signal,
      });
      const body = await readLimited(upstream, responseBodyLimit, controller);
      return encryptedResponse({
        requestId: request.requestId,
        status: upstream.status,
        headers: responseHeaderSubset(upstream.headers),
        bodyBase64: Buffer.from(body).toString('base64'),
      });
    } catch (error) {
      const category = error?.message === 'upstream_body_too_large' ? 'upstream_body_too_large' : controller.signal.aborted ? 'upstream_timeout' : plainCategory(error);
      return encryptedResponse({ requestId: request.requestId, status: 502, headers: {}, bodyBase64: Buffer.from(JSON.stringify({ error: category })).toString('base64') });
    } finally {
      clearTimeout(timer);
      incomingRequest?.off('aborted', cancel);
      outgoingResponse?.off('close', cancel);
      active -= 1;
    }
  }

  async function body(request, limit = ENVELOPE_LIMIT) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw new Error('request_too_large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  }

  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        const payload = JSON.stringify({ ok: true, service: SERVICE });
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(payload);
        return;
      }
      if (request.method !== 'POST' || request.url !== '/relay') {
        const result = fixedError(404, 'not_found');
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(result.body);
        return;
      }
      const length = Number(request.headers['content-length']);
      if (Number.isFinite(length) && length > requestEnvelopeLimit) {
        const result = fixedError(413, 'request_too_large');
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(result.body);
        request.resume();
        return;
      }
      const raw = await body(request, requestEnvelopeLimit);
      if (Buffer.byteLength(raw) > requestEnvelopeLimit) {
        const result = fixedError(413, 'request_too_large');
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(result.body);
        return;
      }
      let envelope;
      try { envelope = JSON.parse(raw); } catch { envelope = null; }
      if (!envelope || typeof envelope !== 'object') {
        const result = fixedError(400, 'envelope_invalid');
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(result.body);
        return;
      }
      let plain;
      try { plain = await protocol.decryptRelayRequest(key, envelope); } catch { plain = null; }
      if (!plain) {
        const result = fixedError(401, 'relay_auth_failed');
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(result.body);
        return;
      }
      const result = await relay(plain, request, response);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    } catch (error) {
      const result = fixedError(error?.message === 'request_too_large' ? 413 : 400, plainCategory(error));
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(result.body);
    }
  });
  return { server, port, host: HOST, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

export async function startRelay({ root = process.cwd(), key, fetchImpl = nodeFetch, protocol, port = PORT } = {}) {
  let relayKey = key;
  if (!relayKey) {
    const vars = await readFile(path.join(root, '.dev.vars.relay'), 'utf8');
    relayKey = parseRelayVars(vars).key;
  }
  const loadedProtocol = protocol ?? await loadProtocol();
  const relay = createRelayServer({ key: relayKey, fetchImpl, protocol: loadedProtocol, port });
  await new Promise((resolve, reject) => {
    relay.server.once('error', reject);
    relay.server.listen(port, HOST, resolve);
  });
  return relay;
}

export async function main() {
  try {
    const relay = await startRelay();
    console.log(`egress relay listening on ${HOST}:${relay.port}`);
    return relay;
  } catch (error) {
    console.error(plainCategory(error));
    process.exitCode = 1;
    return null;
  }
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await main();

export { ENVELOPE_LIMIT, HOST, PORT, REQUEST_LIMIT, RESPONSE_ENVELOPE_LIMIT, RESPONSE_LIMIT, SERVICE, loadProtocol, parseRelayVars };
