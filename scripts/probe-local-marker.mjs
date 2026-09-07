import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch as nodeFetch, Headers as NodeHeaders, Response as NodeResponse } from 'miniflare';
import { createRuntime } from './dev-local.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'oneapi.12213443th.workers.dev';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const BODY_TIMEOUT_MS = 4_500;
const TOKEN_MARGIN_MS = 6 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000 - TOKEN_MARGIN_MS;

export class MarkerProbeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fixedError(error) {
  const name = ['AbortError', 'TimeoutError', 'TypeError', 'Error'].includes(error?.name) ? error.name : 'Error';
  return { error: 'request_failed', name };
}

function safeHeader(headers, name, pattern, maxLength) {
  const value = headers.get(name);
  return typeof value === 'string' && value.length <= maxLength && pattern.test(value) ? value : null;
}

export async function captureResponse(response, timeoutMs = BODY_TIMEOUT_MS) {
  const reader = response.body?.getReader();
  const hash = createHash('sha256');
  const chunks = [];
  let bodyBytes = 0;
  if (reader) {
    let timer;
    let timedOut = false;
    const timeoutError = new MarkerProbeError('response_body_timeout');
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(timeoutError);
        void reader.cancel('marker probe response timeout').catch(() => undefined);
      }, timeoutMs);
    });
    try {
      while (true) {
        const chunk = await Promise.race([reader.read(), timeout]);
        if (timedOut) throw timeoutError;
        if (chunk.done) break;
        bodyBytes += chunk.value.byteLength;
        if (bodyBytes > MAX_BODY_BYTES) {
          void reader.cancel('marker probe response too large').catch(() => undefined);
          throw new MarkerProbeError('response_too_large');
        }
        chunks.push(chunk.value);
        hash.update(chunk.value);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const bytes = new Uint8Array(bodyBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const summary = {
    status: response.status,
    contentType: safeHeader(response.headers, 'content-type', /^[\x20-\x7e]+$/, 128),
    bodyBytes,
    bodySha256: hash.digest('hex'),
    cfRay: safeHeader(response.headers, 'cf-ray', /^[A-Za-z0-9-]+$/, 100),
    server: safeHeader(response.headers, 'server', /^[A-Za-z0-9 ._/-]+$/, 100),
    cfMitigated: response.headers.get('cf-mitigated') === 'challenge' ? 'challenge' : null,
  };
  return { bytes, summary };
}

export function createMarkerOutbound({ fetchImpl = nodeFetch, clientVersion, bodyTimeoutMs = BODY_TIMEOUT_MS }) {
  assert.match(clientVersion, /^\d+\.\d+\.\d+$/);
  const expectedUrl = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}`;
  const report = { resourceRequests: 0, baseline: null, variant: null };
  let intercepted = false;

  const outbound = async (request) => {
    if (intercepted) throw new MarkerProbeError('multiple_model_requests_rejected');
    if (request.method !== 'GET' || request.url !== expectedUrl) throw new MarkerProbeError('unexpected_upstream_rejected');
    if (request.headers.has('cf-worker') || request.headers.has('cf-connecting-ip')) {
      throw new MarkerProbeError('baseline_provenance_header_present');
    }
    intercepted = true;
    const baselineHeaders = new NodeHeaders(request.headers);
    const send = async (headers) => {
      report.resourceRequests += 1;
      return fetchImpl(request.url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: request.signal,
      });
    };

    let baseline;
    let capturedBaseline;
    try {
      baseline = await send(baselineHeaders);
      capturedBaseline = await captureResponse(baseline, bodyTimeoutMs);
      report.baseline = capturedBaseline.summary;
    } catch (error) {
      report.baseline = error instanceof MarkerProbeError ? { error: error.code } : fixedError(error);
      throw new MarkerProbeError('baseline_request_failed');
    }
    if (baseline.status !== 200) {
      return new NodeResponse(JSON.stringify({ error: { code: 'marker_probe_baseline_rejected' } }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const variantHeaders = new NodeHeaders(baselineHeaders);
    variantHeaders.set('CF-Worker', MARKER);
    try {
      const variant = await send(variantHeaders);
      report.variant = (await captureResponse(variant, bodyTimeoutMs)).summary;
    } catch (error) {
      report.variant = error instanceof MarkerProbeError ? { error: error.code } : fixedError(error);
    }
    const responseHeaders = new NodeHeaders(baseline.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    return new NodeResponse(capturedBaseline.bytes, {
      status: baseline.status,
      statusText: baseline.statusText,
      headers: responseHeaders,
    });
  };

  return { outbound, report, expectedUrl };
}

export function validatePreflightStatus(status, now = Date.now()) {
  if (!status || status.connected !== true || status.reauthenticationRequired !== false || !status.account) {
    throw new MarkerProbeError('account_not_ready');
  }
  const { tokenExpiresAt, lastRefreshAt } = status.account;
  const safe = typeof tokenExpiresAt === 'number'
    ? tokenExpiresAt > now + TOKEN_MARGIN_MS
    : tokenExpiresAt === null && typeof lastRefreshAt === 'number' && lastRefreshAt > now - REFRESH_MAX_AGE_MS;
  if (!safe) throw new MarkerProbeError('refresh_window_too_close');
  return { tokenExpiresAt, lastRefreshAt };
}

function assertStatusStable(before, after) {
  if (
    after?.connected !== true || after?.reauthenticationRequired !== false ||
    after.account?.tokenExpiresAt !== before.tokenExpiresAt ||
    after.account?.lastRefreshAt !== before.lastRefreshAt
  ) throw new MarkerProbeError('account_status_changed');
}

async function readJson(response) {
  const text = await response.text();
  if (text.length > 256 * 1024) throw new MarkerProbeError('local_response_too_large');
  try { return JSON.parse(text); } catch { throw new MarkerProbeError('local_response_invalid'); }
}

async function localAdmin(origin, adminKey, pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: { Authorization: `Bearer ${adminKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  return { response, body: await readJson(response) };
}

function readAdminKey(source) {
  const match = /^ADMIN_API_KEY\s*=\s*(.+)$/m.exec(source);
  let value = match?.[1]?.trim();
  if (value && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
  if (!value || /[\r\n]/.test(value)) throw new MarkerProbeError('admin_key_missing');
  return value;
}

export function readClientVersion(source) {
  const matches = [...source.matchAll(/export const CLIENT_VERSION = "([^"]+)";/g)];
  if (matches.length !== 1 || !/^\d+\.\d+\.\d+$/.test(matches[0][1])) throw new MarkerProbeError('client_version_invalid');
  return matches[0][1];
}

async function main() {
  let runtime;
  let marker;
  let before;
  let statusStable = false;
  try {
    const [vars, constants] = await Promise.all([
      readFile(path.join(root, '.dev.vars'), 'utf8'),
      readFile(path.join(root, 'src/codex/constants.ts'), 'utf8'),
    ]);
    const adminKey = readAdminKey(vars);
    const clientVersion = readClientVersion(constants);
    marker = createMarkerOutbound({ clientVersion });
    runtime = await createRuntime({ requestedPort: 0, localOutboundFetch: marker.outbound });
    const origin = (await runtime.ready).origin;
    const beforeResult = await localAdmin(origin, adminKey, '/admin/status');
    if (beforeResult.response.status !== 200) throw new MarkerProbeError('admin_status_rejected');
    before = validatePreflightStatus(beforeResult.body);
    let models;
    let modelsError;
    try {
      models = await localAdmin(origin, adminKey, '/admin/test/models');
    } catch (error) {
      modelsError = error;
    }
    let statusError;
    try {
      const afterResult = await localAdmin(origin, adminKey, '/admin/status');
      if (afterResult.response.status !== 200) throw new MarkerProbeError('admin_status_rejected');
      assertStatusStable(before, afterResult.body);
      statusStable = true;
    } catch (error) {
      statusError = error;
    }
    if (modelsError) throw modelsError;
    if (statusError) throw statusError;
    if (marker.report.resourceRequests < 1 || marker.report.resourceRequests > 2) throw new MarkerProbeError('request_budget_invalid');
    console.log(JSON.stringify({
      clientVersion,
      resourceRequests: marker.report.resourceRequests,
      baseline: marker.report.baseline,
      ...(marker.report.variant ? { variant: marker.report.variant } : {}),
      adminModelsStatus: models.response.status,
      statusStable: true,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      error: { code: error instanceof MarkerProbeError ? error.code : 'marker_probe_failed' },
      ...(marker ? {
        resourceRequests: marker.report.resourceRequests,
        ...(marker.report.baseline ? { baseline: marker.report.baseline } : {}),
        ...(marker.report.variant ? { variant: marker.report.variant } : {}),
      } : {}),
      ...(before ? { statusStable } : {}),
    }));
    process.exitCode = 1;
  } finally {
    await runtime?.dispose();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
