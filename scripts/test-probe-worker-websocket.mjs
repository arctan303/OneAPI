import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runProbe } from './probe-worker-websocket.mjs';

const NOW = new Date('2026-09-07T00:00:00.000Z');
const ORIGIN = 'https://probe.example.test';
const HEALTH = { ok: true, service: 'oneapi-codex-gateway-demo' };

async function fixtureRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'oneapi-ws-probe-'));
  await writeFile(path.join(root, 'wrangler.worker.jsonc'), JSON.stringify({ vars: { PUBLIC_ORIGIN: ORIGIN } }));
  await writeFile(path.join(root, '.dev.vars.worker'), 'ADMIN_API_KEY=fixture-admin-key\n');
  return root;
}

function statusPayload({ connected = true, accountId = 'must-not-appear', tokenExpiresAt = NOW.getTime() + 2 * 60 * 60 * 1000, lastRefreshAt = NOW.getTime() - 60 * 60 * 1000 } = {}) {
  return { connected, reauthenticationRequired: false, account: { id: accountId, tokenExpiresAt, lastRefreshAt } };
}

function fakeFetch(calls, mode, { connected = true, probeError = false, statusSequence } = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init: { ...init } });
    assert.equal(init.redirect, 'error');
    if (url === ORIGIN + '/health') {
      assert.equal(init.headers, undefined); assert.equal(init.method, undefined);
      return new Response(JSON.stringify(HEALTH), { status: 200 });
    }
    if (url === ORIGIN + '/admin/status') {
      assert.deepEqual(init.headers, { Authorization: 'Bearer fixture-admin-key' });
      assert.equal(init.method, undefined); assert.ok(init.signal);
      const statusIndex = calls.filter((call) => call.url === ORIGIN + '/admin/status').length - 1;
      const statusOptions = statusSequence?.[statusIndex] ?? { connected };
      return new Response(JSON.stringify(statusPayload(statusOptions)), { status: 200 });
    }
    assert.equal(url, ORIGIN + '/admin/diagnostics/websocket');
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { Authorization: 'Bearer fixture-admin-key', 'Content-Type': 'application/json' });
    assert.equal(init.body, '{}'); assert.ok(init.signal);
    if (mode === 'probe') {
      if (probeError) return new Response(JSON.stringify({ error: { code: 'websocket_probe_network_error', message: 'must-not-appear' } }), { status: 502 });
      return new Response(JSON.stringify({ result: { status: 101, upgraded: true, messageObserved: false, errorObserved: false, closed: false, serverSelectedModelPresent: true, reasoningIncluded: true, diagnostic: { event: 'websocket_ok', raw: 'must-not-appear' } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'websocket_diagnostic_disabled', message: 'must-not-appear' } }), { status: 503 });
  };
}

test('probe performs one health, two status reads, and one websocket request with safe result fields', async () => {
  const root = await fixtureRoot();
  try {
    const calls = []; const result = await runProbe({ root, mode: 'probe', now: NOW, fetchImpl: fakeFetch(calls, 'probe') });
    assert.equal(result.failed, false); assert.equal(calls.length, 4);
    assert.deepEqual(result.report.health, { statusCode: 200, ok: true, service: 'oneapi-codex-gateway-demo' });
    assert.deepEqual(result.report.status, { before: { statusCode: 200, connected: true, reauthenticationRequired: false, expiresWindow: 'within_24h', lastRefreshWindow: 'within_1h' }, after: { statusCode: 200, connected: true, reauthenticationRequired: false, expiresWindow: 'within_24h', lastRefreshWindow: 'within_1h' }, stable: true });
    assert.deepEqual(result.report.target.result, { status: 101, upgraded: true, messageObserved: false, errorObserved: false, closed: false, serverSelectedModelPresent: true, reasoningIncluded: true, diagnostic: { event: 'websocket_ok' } });
    const saved = await readFile(result.outputPath, 'utf8'); assert.ok(!saved.includes('fixture-admin-key')); assert.ok(!saved.includes('must-not-appear'));
    assert.equal(calls.filter((call) => call.url === ORIGIN + '/admin/diagnostics/websocket').length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('disabled mode accepts the fixed 503 code after exactly one diagnostic request', async () => {
  const root = await fixtureRoot();
  try {
    const calls = []; const result = await runProbe({ root, mode: 'disabled', now: NOW, fetchImpl: fakeFetch(calls, 'disabled') });
    assert.equal(result.failed, false); assert.equal(calls.length, 4);
    assert.equal(calls.filter((call) => call.url === ORIGIN + '/admin/diagnostics/websocket').length, 1);
    assert.deepEqual(result.report.target, { statusCode: 503, result: {}, messageCode: 'websocket_diagnostic_disabled' });
    assert.equal(result.report.status.stable, true);
    const saved = await readFile(result.outputPath, 'utf8'); assert.ok(!saved.includes('fixture-admin-key')); assert.ok(!saved.includes('must-not-appear'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('probe preserves a safe JSON error code on target failure', async () => {
  const root = await fixtureRoot();
  try {
    const calls = [];
    const result = await runProbe({ root, mode: 'probe', now: NOW, fetchImpl: fakeFetch(calls, 'probe', { probeError: true }) });
    assert.equal(result.failed, true);
    assert.equal(calls.length, 4);
    assert.equal(calls.filter((call) => call.url === ORIGIN + '/admin/diagnostics/websocket').length, 1);
    assert.deepEqual(result.report.target, { statusCode: 502, result: {}, messageCode: 'websocket_probe_network_error' });
    assert.equal(result.report.status.stable, true);
    const saved = await readFile(result.outputPath, 'utf8');
    assert.ok(!saved.includes('fixture-admin-key'));
    assert.ok(!saved.includes('must-not-appear'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('probe marks status unstable when precise account state changes within the same windows', async () => {
  const root = await fixtureRoot();
  try {
    const calls = [];
    const result = await runProbe({
      root,
      mode: 'probe',
      now: NOW,
      fetchImpl: fakeFetch(calls, 'probe', {
        statusSequence: [
          { accountId: 'acct-A', tokenExpiresAt: NOW.getTime() + 2 * 60 * 60 * 1000, lastRefreshAt: NOW.getTime() - 60 * 60 * 1000 },
          { accountId: 'acct-B', tokenExpiresAt: NOW.getTime() + 2 * 60 * 60 * 1000 + 1000, lastRefreshAt: NOW.getTime() - 60 * 60 * 1000 + 1000 },
        ],
      }),
    });
    assert.equal(result.failed, true);
    assert.equal(calls.length, 4);
    assert.equal(result.report.status.stable, false);
    assert.equal(result.report.status.before.expiresWindow, 'within_24h');
    assert.equal(result.report.status.after.expiresWindow, 'within_24h');
    assert.equal(result.report.status.before.lastRefreshWindow, 'within_1h');
    assert.equal(result.report.status.after.lastRefreshWindow, 'within_1h');
    const saved = await readFile(result.outputPath, 'utf8');
    assert.ok(!saved.includes('acct-A'));
    assert.ok(!saved.includes('acct-B'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('probe stops before the target when the preflight status is disconnected', async () => {
  const root = await fixtureRoot();
  try {
    const calls = []; const result = await runProbe({ root, mode: 'probe', now: NOW, fetchImpl: fakeFetch(calls, 'probe', { connected: false }) });
    assert.equal(result.failed, true); assert.equal(result.report.passed, false); assert.equal(calls.length, 2);
    assert.equal(calls.some((call) => call.url === ORIGIN + '/admin/diagnostics/websocket'), false); assert.deepEqual(result.report.target, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});
