import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarkerOutbound, readClientVersion, validatePreflightStatus } from './probe-local-marker.mjs';

const VERSION = '0.153.4';
const URL = `https://chatgpt.com/backend-api/codex/models?client_version=${VERSION}`;

function upstreamRequest() {
  return new Request(URL, {
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer SECRET_TOKEN',
      'ChatGPT-Account-Id': 'SECRET_ACCOUNT',
      'User-Agent': 'fixed-agent',
    },
    signal: new AbortController().signal,
  });
}

test('sends baseline then a variant differing only by CF-Worker and emits safe summaries', async () => {
  const calls = [];
  const marker = createMarkerOutbound({
    clientVersion: VERSION,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(calls.length === 1 ? '{"models":[]}' : 'SECRET_BLOCK_PAGE', {
        status: calls.length === 1 ? 200 : 403,
        headers: { 'Content-Type': calls.length === 1 ? 'application/json' : 'text/html', 'CF-Ray': 'safe-ray-SIN', Server: 'cloudflare' },
      });
    },
  });
  const baseline = await marker.outbound(upstreamRequest());
  assert.equal(baseline.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, URL);
  assert.equal(calls[1].url, URL);
  assert.strictEqual(calls[0].init.signal, calls[1].init.signal);
  const first = Object.fromEntries(new Headers(calls[0].init.headers));
  const second = Object.fromEntries(new Headers(calls[1].init.headers));
  assert.deepEqual(Object.keys(second).filter((key) => first[key] !== second[key]), ['cf-worker']);
  assert.equal(second['cf-worker'], 'oneapi.12213443th.workers.dev');
  assert.deepEqual(marker.report.baseline, {
    status: 200, contentType: 'application/json', bodyBytes: 13,
    bodySha256: 'a6fe9ec6e26a38d99fca418b69826e0238b7a2bb319ff05eb153a6fcfd1fa28d',
    cfRay: 'safe-ray-SIN', server: 'cloudflare', cfMitigated: null,
  });
  assert.equal(marker.report.variant.status, 403);
  const serialized = JSON.stringify(marker.report);
  assert.equal(serialized.includes('SECRET_TOKEN'), false);
  assert.equal(serialized.includes('SECRET_ACCOUNT'), false);
  assert.equal(serialized.includes('SECRET_BLOCK_PAGE'), false);
});

test('a rejected baseline stops the variant and returns synthetic 502', async () => {
  let calls = 0;
  const marker = createMarkerOutbound({
    clientVersion: VERSION,
    fetchImpl: async () => {
      calls += 1;
      return new Response('rejected', { status: 401, headers: { 'Content-Type': 'text/plain' } });
    },
  });
  const response = await marker.outbound(upstreamRequest());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: 'marker_probe_baseline_rejected' } });
  assert.equal(calls, 1);
  assert.equal(marker.report.resourceRequests, 1);
  assert.equal(marker.report.variant, null);
});

test('rejects every non-model upstream before fetch and validates the refresh margin', async () => {
  let calls = 0;
  const marker = createMarkerOutbound({ clientVersion: VERSION, fetchImpl: async () => { calls += 1; } });
  await assert.rejects(() => marker.outbound(new Request('https://auth.openai.com/oauth/token', { method: 'POST' })), (error) => error.code === 'unexpected_upstream_rejected');
  assert.equal(calls, 0);
  assert.equal(marker.report.resourceRequests, 0);

  const now = 1_800_000_000_000;
  assert.deepEqual(validatePreflightStatus({ connected: true, reauthenticationRequired: false, account: { tokenExpiresAt: now + 360_001, lastRefreshAt: now } }, now), { tokenExpiresAt: now + 360_001, lastRefreshAt: now });
  assert.throws(() => validatePreflightStatus({ connected: true, reauthenticationRequired: false, account: { tokenExpiresAt: now + 360_000, lastRefreshAt: now } }, now), (error) => error.code === 'refresh_window_too_close');
  assert.equal(readClientVersion('export const CLIENT_VERSION = "0.153.4";'), VERSION);
});

test('bounds oversized and non-ending baseline bodies without starting the variant', async () => {
  let oversizedCancelled = false;
  const oversized = createMarkerOutbound({
    clientVersion: VERSION,
    bodyTimeoutMs: 100,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel() { oversizedCancelled = true; },
    })),
  });
  await assert.rejects(() => oversized.outbound(upstreamRequest()), (error) => error.code === 'baseline_request_failed');
  assert.equal(oversizedCancelled, true);
  assert.equal(oversized.report.resourceRequests, 1);
  assert.deepEqual(oversized.report.baseline, { error: 'response_too_large' });

  let timeoutCancelled = false;
  const hanging = createMarkerOutbound({
    clientVersion: VERSION,
    bodyTimeoutMs: 20,
    fetchImpl: async () => new Response(new ReadableStream({
      pull() {},
      cancel() { timeoutCancelled = true; },
    })),
  });
  await assert.rejects(() => hanging.outbound(upstreamRequest()), (error) => error.code === 'baseline_request_failed');
  assert.equal(timeoutCancelled, true);
  assert.equal(hanging.report.resourceRequests, 1);
  assert.deepEqual(hanging.report.baseline, { error: 'response_body_timeout' });
});
