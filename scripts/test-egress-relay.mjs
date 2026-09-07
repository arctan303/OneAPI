import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { createRelayServer, loadProtocol } from './egress-relay.mjs';

const KEY = Buffer.alloc(32, 7).toString('base64');

function id(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

async function relayRequest(protocol, value, envelope = protocol.encryptRelayRequest(KEY, value)) {
  const body = JSON.stringify(await envelope);
  const response = await fetch('http://127.0.0.1:8791/relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { response, decoded: response.status === 200 ? await protocol.decryptRelayResponse(KEY, await response.json()) : null };
}

function baseRequest(operation, requestId, extra = {}) {
  return {
    requestId,
    issuedAt: Date.now(),
    operation,
    headers: {
      authorization: 'Bearer fixture-access-token',
      'chatgpt-account-id': 'fixture-account',
      accept: 'application/json',
      'content-type': 'application/json',
      originator: 'codex_cli_rs',
      'user-agent': 'oneapi-fixture',
      version: '1.2.3',
    },
    ...extra,
  };
}

test('relay enforces encrypted auth, fixed targets, limits, replay and cancellation', async () => {
  const calls = [];
  let oversizedNext = false;
  const protocol = await loadProtocol();
  const upstream = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/wham/usage')) {
      return new Response(JSON.stringify({ total: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (oversizedNext) {
      oversizedNext = false;
      return new Response(new Uint8Array(2 * 1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    if (url.endsWith('/responses')) {
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    return new Response(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.5' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const relay = createRelayServer({ key: KEY, protocol, fetchImpl: upstream, generationTimeoutMs: 50 });
  relay.server.listen(8791, '127.0.0.1');
  await once(relay.server, 'listening');
  try {
    const health = await fetch('http://127.0.0.1:8791/health');
    assert.deepEqual(await health.json(), { ok: true, service: 'oneapi-egress-relay' });

    const ping = await relayRequest(protocol, { requestId: id(1), issuedAt: Date.now(), operation: 'ping', headers: {} });
    assert.equal(ping.response.status, 200);
    assert.deepEqual(ping.decoded, { requestId: id(1), status: 200, headers: {}, service: 'oneapi-egress-relay' });
    assert.equal(calls.length, 0);

    const models = await relayRequest(protocol, baseRequest('models', id(2), { clientVersion: '1.2.3' }));
    assert.equal(models.response.status, 200);
    assert.equal(models.decoded.status, 200);
    assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/models?client_version=1.2.3');
    assert.equal(calls[0].init.redirect, 'error');
    assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ['accept', 'authorization', 'chatgpt-account-id', 'content-type', 'originator', 'user-agent', 'version']);
    assert.equal('cf-worker' in calls[0].init.headers, false);
    assert.equal('cookie' in calls[0].init.headers, false);

    const usage = await relayRequest(protocol, baseRequest('usage', id(3)));
    assert.equal(usage.decoded.status, 200);
    assert.equal(calls[1].url, 'https://chatgpt.com/backend-api/wham/usage');

    const generate = await relayRequest(protocol, baseRequest('generate', id(7), { bodyText: JSON.stringify(protocol.fixedRelayGenerationBody()) }));
    assert.equal(generate.response.status, 200);
    assert.equal(generate.decoded.status, 502);
    assert.deepEqual(JSON.parse(Buffer.from(generate.decoded.bodyBase64, 'base64').toString()), { error: 'upstream_timeout' });
    assert.equal(calls[2].url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(calls[2].init.method, 'POST');
    assert.equal(JSON.parse(calls[2].init.body).stream, true);
    assert.equal(JSON.parse(calls[2].init.body).input[0].content[0].text, 'Reply only EGRESS_OK');

    oversizedNext = true;
    const tooLarge = await relayRequest(protocol, baseRequest('models', id(10), { clientVersion: '1.2.3' }));
    assert.equal(tooLarge.response.status, 200);
    assert.equal(tooLarge.decoded.status, 502);
    assert.deepEqual(JSON.parse(Buffer.from(tooLarge.decoded.bodyBase64, 'base64').toString()), { error: 'upstream_body_too_large' });

    const replay = await relayRequest(protocol, baseRequest('usage', id(3)));
    assert.equal(replay.response.status, 409);
    assert.equal(calls.length, 4);

    const expired = await relayRequest(protocol, { ...baseRequest('usage', id(8)), issuedAt: Date.now() - 31_000 });
    assert.equal(expired.response.status, 400);
    assert.equal(calls.length, 4);

    const tampered = await relayRequest(protocol, baseRequest('usage', id(4)), { v: 1, iv: 'fixture-request', data: 'tampered' });
    assert.equal(tampered.response.status, 401);

    await assert.rejects(() => protocol.encryptRelayRequest(KEY, baseRequest('usage', id(5), { headers: { authorization: 'x', cookie: 'x' } })), /unsupported fields|invalid header/);
    assert.equal(calls.length, 4);

    await assert.rejects(() => protocol.encryptRelayRequest(KEY, baseRequest('models', id(6), { clientVersion: 'https://evil.example' })), /clientVersion is invalid/);
    assert.equal(calls.length, 4);

    const oversized = await fetch('http://127.0.0.1:8791/relay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"v":1,"iv":"fixture-request","data":"${'A'.repeat(100 * 1024)}"}`,
    });
    assert.equal(oversized.status, 413);
  } finally {
    await relay.close();
  }
});

test('client disconnect aborts upstream work and releases active slots', async () => {
  const protocol = await loadProtocol();
  const started = [];
  const aborted = [];
  const calls = [];
  const upstream = async (url, init) => {
    calls.push(url);
    if (!url.endsWith('/responses')) {
      return new Response(JSON.stringify({ models: [{ slug: 'gpt-after-disconnect', supported_in_api: true }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const index = started.length;
    let startedResolve;
    let abortedResolve;
    started[index] = new Promise((resolve) => { startedResolve = resolve; });
    aborted[index] = new Promise((resolve) => { abortedResolve = resolve; });
    startedResolve();
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        abortedResolve();
        reject(new Error('aborted'));
      }, { once: true });
    });
  };
  const relay = createRelayServer({ key: KEY, protocol, fetchImpl: upstream, generationTimeoutMs: 5_000 });
  relay.server.listen(8791, '127.0.0.1');
  await once(relay.server, 'listening');

  const within = async (promise, label) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 1_000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const disconnect = async (requestId, expectedIndex) => {
    const envelope = await protocol.encryptRelayRequest(KEY, baseRequest('generate', requestId, {
      bodyText: JSON.stringify(protocol.fixedRelayGenerationBody()),
    }));
    const body = JSON.stringify(envelope);
    const client = httpRequest({
      host: '127.0.0.1',
      port: 8791,
      path: '/relay',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    });
    client.on('error', () => undefined);
    client.end(body);
    await within((async () => {
      while (!started[expectedIndex]) await new Promise((resolve) => setImmediate(resolve));
    })(), 'upstream_start_timeout');
    await within(started[expectedIndex], 'upstream_start_timeout');
    client.destroy();
    await within(aborted[expectedIndex], 'upstream_abort_timeout');
    await new Promise((resolve) => setImmediate(resolve));
  };

  try {
    await disconnect(id(20), 0);
    await disconnect(id(21), 1);
    const afterDisconnect = await relayRequest(protocol, baseRequest('models', id(22), { clientVersion: '1.2.3' }));
    assert.equal(afterDisconnect.response.status, 200);
    assert.equal(afterDisconnect.decoded.status, 200);
    assert.equal(calls.length, 3);
    assert.equal(calls[2], 'https://chatgpt.com/backend-api/codex/models?client_version=1.2.3');
  } finally {
    await relay.close();
  }
});

test('actual AES-GCM protocol can be loaded through esbuild when available', async (context) => {
  try {
    const protocol = await loadProtocol();
    assert.equal(typeof protocol.encryptRelayRequest, 'function');
    assert.equal(typeof protocol.decryptRelayRequest, 'function');
    assert.equal(typeof protocol.encryptRelayResponse, 'function');
    assert.equal(typeof protocol.decryptRelayResponse, 'function');
    const plain = { requestId: id(9), issuedAt: Date.now(), operation: 'ping', headers: {} };
    const envelope = await protocol.encryptRelayRequest(KEY, plain);
    assert.equal((await protocol.decryptRelayRequest(KEY, envelope)).requestId, plain.requestId);
  } catch (error) {
    if (error?.code === 'ENOENT' || /Could not resolve/.test(error?.message ?? '')) context.skip('shared protocol is not present yet');
    else throw error;
  }
});
