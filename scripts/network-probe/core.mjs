export const WORKER_NAME = 'oneapi-network-probe';
export const PROBE_MARKER = 'oneapi-network-probe-v1';
export const SYNTHETIC_BODY = JSON.stringify({ probe: PROBE_MARKER });

const MAX_REQUEST_BYTES = 128;
const MAX_RESPONSE_BYTES = 4096;
const OUTBOUND_TIMEOUT_MS = 10_000;
const HASHED_HEADERS = ['cf-worker', 'via', 'forwarded', 'x-forwarded-for', 'cf-connecting-ip', 'accept-encoding', 'user-agent'];
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class ProbeError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function validateCollectorOrigin(value) {
  if (typeof value !== 'string' || value.length > 512 || value.trim() !== value) {
    throw new ProbeError(500, 'collector_origin_invalid');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProbeError(500, 'collector_origin_invalid');
  }
  const labels = url.hostname.split('.');
  if (
    url.protocol !== 'https:' || value !== url.origin || url.username || url.password || url.port ||
    url.pathname !== '/' || url.search || url.hash || labels.length < 4 || labels[0] !== WORKER_NAME ||
    labels.at(-2) !== 'workers' || labels.at(-1) !== 'dev'
  ) {
    throw new ProbeError(500, 'collector_origin_invalid');
  }
  return url.origin;
}

export function syntheticRequest(target) {
  return new Request(target, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-OneAPI-Network-Probe': PROBE_MARKER,
      'User-Agent': 'OneAPI-Network-Probe/1.0',
    },
    body: SYNTHETIC_BODY,
    cache: 'no-store',
    redirect: 'manual',
  });
}

async function readBoundedBody(responseOrRequest, limit, tooLargeCode, timeoutCode, timeoutStatus, timeoutMs) {
  const declared = responseOrRequest.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new ProbeError(413, tooLargeCode);
  }
  if (!responseOrRequest.body) return '';
  const reader = responseOrRequest.body.getReader();
  const chunks = [];
  let total = 0;
  let timer;
  let timedOut = false;
  const timeoutError = new ProbeError(timeoutStatus, timeoutCode);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
      void reader.cancel('synthetic probe body timeout').catch(() => undefined);
    }, timeoutMs);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (timedOut) throw timeoutError;
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel('bounded synthetic probe');
        throw new ProbeError(413, tooLargeCode);
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ProbeError(400, 'synthetic_request_invalid');
  }
}

export async function requireSyntheticRequest(request, timeoutMs = 2_000) {
  if (request.method !== 'POST') throw new ProbeError(405, 'method_not_allowed');
  if (
    request.headers.get('accept') !== 'application/json' ||
    request.headers.get('content-type') !== 'application/json' ||
    request.headers.get('x-oneapi-network-probe') !== PROBE_MARKER
  ) {
    throw new ProbeError(400, 'synthetic_request_invalid');
  }
  if (await readBoundedBody(request, MAX_REQUEST_BYTES, 'synthetic_request_too_large', 'synthetic_request_timeout', 408, timeoutMs) !== SYNTHETIC_BODY) {
    throw new ProbeError(400, 'synthetic_request_invalid');
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function headerFingerprint(headers, name) {
  const value = headers.get(name);
  if (value === null) return { present: false };
  const encoded = new TextEncoder().encode(`${name}\0${value}`);
  const bounded = encoded.byteLength > 4096 ? encoded.slice(0, 4096) : encoded;
  const copy = new Uint8Array(new ArrayBuffer(bounded.byteLength));
  copy.set(bounded);
  return {
    present: true,
    valueSha256: bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer))),
    ...(encoded.byteLength > bounded.byteLength ? { truncated: true } : {}),
  };
}

function safeToken(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function safeOrganization(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  return normalized || null;
}

export async function collectObservation(request) {
  const cf = request.cf && typeof request.cf === 'object' ? request.cf : {};
  const provenance = {};
  for (const name of HASHED_HEADERS) provenance[name] = await headerFingerprint(request.headers, name);
  return {
    schema: 'oneapi-network-observation-v1',
    provenance,
    transport: {
      httpProtocol: safeToken(cf.httpProtocol, /^[A-Za-z0-9./_-]{1,32}$/),
      colo: safeToken(cf.colo, /^[A-Z]{3}$/),
      tlsVersion: safeToken(cf.tlsVersion, /^[A-Za-z0-9._-]{1,32}$/),
      tlsCipher: safeToken(cf.tlsCipher, /^[A-Za-z0-9+._-]{1,100}$/),
      tlsClientCiphersSha1: safeToken(cf.tlsClientCiphersSha1, /^[A-Za-z0-9+/=]{1,100}$/),
      tlsClientExtensionsSha1: safeToken(cf.tlsClientExtensionsSha1, /^[A-Za-z0-9+/=]{1,100}$/),
      tlsClientHelloLength: safeToken(cf.tlsClientHelloLength, /^\d{1,8}$/),
      asn: Number.isSafeInteger(cf.asn) && cf.asn >= 0 ? cf.asn : null,
      asOrganization: safeOrganization(cf.asOrganization),
    },
    interpretation: {
      cfConnectingIp: 'edge_header_not_verified_socket_ip',
      transport: 'collector_inbound_metadata_not_chatgpt_handshake_evidence',
    },
  };
}

function headerObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.present !== 'boolean') {
    throw new ProbeError(502, 'collector_response_invalid');
  }
  if (!value.present) return { present: false };
  if (typeof value.valueSha256 !== 'string' || !HASH_PATTERN.test(value.valueSha256)) {
    throw new ProbeError(502, 'collector_response_invalid');
  }
  return { present: true, valueSha256: value.valueSha256, ...(value.truncated === true ? { truncated: true } : {}) };
}

export function sanitizeObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 'oneapi-network-observation-v1') {
    throw new ProbeError(502, 'collector_response_invalid');
  }
  const provenance = {};
  for (const name of HASHED_HEADERS) provenance[name] = headerObservation(value.provenance?.[name]);
  const transport = value.transport && typeof value.transport === 'object' ? value.transport : {};
  const nullableString = (entry, max) => entry === null || (typeof entry === 'string' && entry.length <= max) ? entry : null;
  return {
    schema: value.schema,
    provenance,
    transport: {
      httpProtocol: nullableString(transport.httpProtocol, 32),
      colo: nullableString(transport.colo, 3),
      tlsVersion: nullableString(transport.tlsVersion, 32),
      tlsCipher: nullableString(transport.tlsCipher, 100),
      tlsClientCiphersSha1: nullableString(transport.tlsClientCiphersSha1, 100),
      tlsClientExtensionsSha1: nullableString(transport.tlsClientExtensionsSha1, 100),
      tlsClientHelloLength: nullableString(transport.tlsClientHelloLength, 8),
      asn: Number.isSafeInteger(transport.asn) && transport.asn >= 0 ? transport.asn : null,
      asOrganization: nullableString(transport.asOrganization, 100),
    },
    interpretation: {
      cfConnectingIp: 'edge_header_not_verified_socket_ip',
      transport: 'collector_inbound_metadata_not_chatgpt_handshake_evidence',
    },
  };
}

export async function readObservationResponse(response) {
  if (!response.ok) {
    await response.body?.cancel('collector response rejected').catch(() => undefined);
    throw new ProbeError(502, `collector_http_${response.status}`);
  }
  if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    await response.body?.cancel('collector response rejected').catch(() => undefined);
    throw new ProbeError(502, 'collector_content_type_invalid');
  }
  const text = await readBoundedBody(response, MAX_RESPONSE_BYTES, 'collector_response_too_large', 'collector_timeout', 504, OUTBOUND_TIMEOUT_MS);
  try {
    return sanitizeObservation(JSON.parse(text));
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError(502, 'collector_response_invalid');
  }
}

export async function fetchCollector(env, outboundFetch = globalThis.fetch) {
  const origin = validateCollectorOrigin(env.COLLECTOR_ORIGIN);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  try {
    const request = syntheticRequest(`${origin}/collect`);
    const response = await outboundFetch(new Request(request, { signal: controller.signal }));
    return await readObservationResponse(response);
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    const errorName = ['AbortError', 'TimeoutError', 'TypeError', 'Error'].includes(error?.name) ? error.name : 'Error';
    const message = typeof error?.message === 'string' ? error.message : '';
    const reason = controller.signal.aborted || errorName === 'AbortError' || errorName === 'TimeoutError'
      ? 'timeout'
      : /(?:error\s*code\s*:?\s*1042|same[ -]zone)/i.test(message)
        ? 'same_zone_fetch_rejected'
        : 'runtime_fetch_failed';
    throw new ProbeError(reason === 'timeout' ? 504 : 502, 'collector_fetch_failed', { name: errorName, reason });
  } finally {
    clearTimeout(timer);
  }
}

export function jsonResponse(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function handleProbeDoRequest(request, env, outboundFetch = globalThis.fetch) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.origin !== 'https://probe.internal' || url.pathname !== '/run' || url.search) {
    throw new ProbeError(404, 'not_found');
  }
  return jsonResponse(await fetchCollector(env, outboundFetch));
}

export async function handleWorkerRequest(request, env, outboundFetch = globalThis.fetch) {
  const url = new URL(request.url);
  if (url.search) throw new ProbeError(404, 'not_found');
  if (request.method === 'GET' && url.pathname === '/health') {
    return jsonResponse({ ok: true, service: WORKER_NAME });
  }
  if (!['/collect', '/run/top', '/run/do'].includes(url.pathname)) throw new ProbeError(404, 'not_found');
  await requireSyntheticRequest(request);
  if (url.pathname === '/collect') return jsonResponse(await collectObservation(request));
  if (url.pathname === '/run/top') return jsonResponse(await fetchCollector(env, outboundFetch));
  const id = env.PROBE.idFromName('synthetic');
  const response = await env.PROBE.get(id).fetch('https://probe.internal/run', { method: 'POST' });
  return jsonResponse(await readObservationResponse(response));
}

export async function safeHandle(action) {
  try {
    return await action();
  } catch (error) {
    const known = error instanceof ProbeError ? error : new ProbeError(500, 'probe_failed');
    return jsonResponse({ error: { code: known.code, ...(known.details ?? {}) } }, known.status);
  }
}
