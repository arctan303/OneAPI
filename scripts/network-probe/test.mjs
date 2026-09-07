import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleProbeDoRequest,
  handleWorkerRequest,
  PROBE_MARKER,
  readObservationResponse,
  requireSyntheticRequest,
  safeHandle,
  SYNTHETIC_BODY,
  syntheticRequest,
} from './core.mjs';

const ORIGIN = 'https://oneapi-network-probe.fixture.workers.dev';

function observation() {
  const absent = { present: false };
  return {
    schema: 'oneapi-network-observation-v1',
    provenance: {
      'cf-worker': absent,
      via: absent,
      forwarded: absent,
      'x-forwarded-for': absent,
      'cf-connecting-ip': absent,
      'accept-encoding': absent,
      'user-agent': absent,
    },
    transport: {
      httpProtocol: 'HTTP/2',
      colo: 'SIN',
      tlsVersion: 'TLSv1.3',
      tlsCipher: 'AEAD-AES128-GCM-SHA256',
      tlsClientCiphersSha1: null,
      tlsClientExtensionsSha1: null,
      tlsClientHelloLength: '508',
      asn: 13335,
      asOrganization: 'Cloudflare, Inc.',
    },
    interpretation: {
      cfConnectingIp: 'edge_header_not_verified_socket_ip',
      transport: 'collector_inbound_metadata_not_chatgpt_handshake_evidence',
    },
  };
}

test('collector returns only hashed provenance and whitelisted transport metadata', async () => {
  const request = syntheticRequest(`${ORIGIN}/collect`);
  const headers = new Headers(request.headers);
  headers.set('cf-worker', 'sensitive-worker-zone.example');
  headers.set('via', 'sensitive-hop');
  headers.set('forwarded', 'for=198.51.100.4');
  headers.set('x-forwarded-for', '198.51.100.5');
  headers.set('cf-connecting-ip', '198.51.100.6');
  headers.set('authorization', 'Bearer MUST_NOT_APPEAR');
  headers.set('cookie', 'session=MUST_NOT_APPEAR');
  const incoming = new Request(request, { headers });
  Object.defineProperty(incoming, 'cf', { value: {
    httpProtocol: 'HTTP/3',
    colo: 'SIN',
    tlsVersion: 'TLSv1.3',
    tlsCipher: 'AEAD-AES128-GCM-SHA256',
    tlsClientCiphersSha1: 'GXSPDLP4G3X+prK73a4wBuOaHRc=',
    tlsClientExtensionsSha1: 'OWFiM2I5ZDc0YWI0YWYzZmFkMGU0ZjhlYjhiYmVkMjgxNTU5YTU2Mg==',
    tlsClientHelloLength: '508',
    tlsClientRandom: 'MUST_NOT_APPEAR',
    asn: 13335,
    asOrganization: 'Cloudflare, Inc.',
  } });
  const result = await (await handleWorkerRequest(incoming, {})).json();
  const serialized = JSON.stringify(result);
  for (const secret of ['sensitive-worker-zone.example', 'sensitive-hop', '198.51.100.4', '198.51.100.5', '198.51.100.6', 'MUST_NOT_APPEAR']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(result.provenance['cf-worker'].valueSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.transport.httpProtocol, 'HTTP/3');
  assert.equal(result.transport.asn, 13335);
  assert.equal('tlsClientRandom' in result.transport, false);
  assert.equal(Object.keys(result.provenance).sort().join(','), 'accept-encoding,cf-connecting-ip,cf-worker,forwarded,user-agent,via,x-forwarded-for');
});

test('top-level probe makes one fixed synthetic request and accepts no caller target', async () => {
  const calls = [];
  const outbound = async (request) => {
    calls.push(request);
    return Response.json(observation());
  };
  const response = await handleWorkerRequest(syntheticRequest(`${ORIGIN}/run/top`), { COLLECTOR_ORIGIN: ORIGIN }, outbound);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ORIGIN}/collect`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(await calls[0].text(), SYNTHETIC_BODY);
  assert.equal(calls[0].headers.get('x-oneapi-network-probe'), PROBE_MARKER);
  assert.equal(calls[0].headers.get('user-agent'), 'OneAPI-Network-Probe/1.0');
  assert.equal(calls[0].headers.has('authorization'), false);
  assert.equal(calls[0].headers.has('cookie'), false);

  const invalidOrigin = await safeHandle(() => handleWorkerRequest(
    syntheticRequest(`${ORIGIN}/run/top?target=https://evil.example`),
    { COLLECTOR_ORIGIN: 'https://evil.example' },
    outbound,
  ));
  assert.equal(invalidOrigin.status, 404);
  assert.equal(calls.length, 1);
});

test('ProbeDO path is internal-only and performs one collector request without storage', async () => {
  const calls = [];
  const response = await handleProbeDoRequest(
    new Request('https://probe.internal/run', { method: 'POST' }),
    { COLLECTOR_ORIGIN: ORIGIN },
    async (request) => {
      calls.push(request);
      return Response.json(observation());
    },
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ORIGIN}/collect`);

  const external = await safeHandle(() => handleProbeDoRequest(
    new Request('https://evil.example/run', { method: 'POST' }),
    { COLLECTOR_ORIGIN: ORIGIN },
  ));
  assert.equal(external.status, 404);
});

test('public DO route calls only its fixed binding and rejects malformed or oversized bodies', async () => {
  let bindingCalls = 0;
  const env = {
    PROBE: {
      idFromName(name) {
        assert.equal(name, 'synthetic');
        return 'fixed-id';
      },
      get(id) {
        assert.equal(id, 'fixed-id');
        return { fetch: async (url, init) => {
          bindingCalls += 1;
          assert.equal(url, 'https://probe.internal/run');
          assert.equal(init.method, 'POST');
          return Response.json(observation());
        } };
      },
    },
  };
  assert.equal((await handleWorkerRequest(syntheticRequest(`${ORIGIN}/run/do`), env)).status, 200);
  assert.equal(bindingCalls, 1);

  const malformed = syntheticRequest(`${ORIGIN}/collect`);
  const bad = new Request(malformed, { body: JSON.stringify({ target: 'https://evil.example' }) });
  assert.equal((await safeHandle(() => handleWorkerRequest(bad, env))).status, 400);
  const oversized = new Request(`${ORIGIN}/collect`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-OneAPI-Network-Probe': PROBE_MARKER,
    },
    body: 'x'.repeat(129),
  });
  assert.equal((await safeHandle(() => handleWorkerRequest(oversized, env))).status, 413);
  assert.equal(bindingCalls, 1);
});

test('slow synthetic request bodies time out and cancel their reader', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull() {},
    cancel() { cancelled = true; },
  });
  const request = new Request(`${ORIGIN}/collect`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-OneAPI-Network-Probe': PROBE_MARKER,
      'User-Agent': 'OneAPI-Network-Probe/1.0',
    },
    body,
    duplex: 'half',
  });
  await assert.rejects(() => requireSyntheticRequest(request, 20), (error) => error.code === 'synthetic_request_timeout');
  assert.equal(cancelled, true);
});

test('collector failures expose only bounded status and fetch classifications', async () => {
  await assert.rejects(
    () => readObservationResponse(new Response('blocked', { status: 403, headers: { 'Content-Type': 'text/plain' } })),
    (error) => error.code === 'collector_http_403',
  );
  await assert.rejects(
    () => readObservationResponse(new Response('not json', { headers: { 'Content-Type': 'text/plain' } })),
    (error) => error.code === 'collector_content_type_invalid',
  );

  const sameZone = await safeHandle(() => handleWorkerRequest(
    syntheticRequest(`${ORIGIN}/run/top`),
    { COLLECTOR_ORIGIN: ORIGIN },
    async () => {
      const error = new TypeError('error code: 1042 SECRET_MUST_NOT_APPEAR');
      throw error;
    },
  ));
  const payload = await sameZone.json();
  assert.deepEqual(payload, {
    error: { code: 'collector_fetch_failed', name: 'TypeError', reason: 'same_zone_fetch_rejected' },
  });
  assert.equal(JSON.stringify(payload).includes('SECRET_MUST_NOT_APPEAR'), false);
});
