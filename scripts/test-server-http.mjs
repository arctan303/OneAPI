import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { readServerConfig } from '../server/config.mjs';
import { startHttpServer } from '../server/http.mjs';

const secrets = { ADMIN_API_KEY: 'a'.repeat(43), GATEWAY_API_KEY: 'b'.repeat(43), TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
function raw(url, { headers = {}, method = 'GET', body, path } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers, method, ...(path ? { path } : {}) }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}
function deadline(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test deadline exceeded')), 2000); })])
    .finally(() => clearTimeout(timer));
}

test('configuration selects only production fields and requires HTTPS for a public listener', () => {
  const result = readServerConfig({ ...secrets, MOCK_UPSTREAM: 'true', ONEAPI_WS_DIAGNOSTIC: 'true', ALLOW_TEST_HOSTS: 'true' });
  assert.deepEqual(result.config, secrets);
  assert.equal(result.host, '127.0.0.1');
  assert.throws(() => readServerConfig({ ...secrets, HOST: '0.0.0.0' }), /PUBLIC_ORIGIN/);
  assert.throws(() => readServerConfig({ ...secrets, PUBLIC_ORIGIN: 'http://example.test' }), /HTTPS/);
  assert.throws(() => readServerConfig({ ...secrets, PUBLIC_ORIGIN: 'https://example.test:8443' }), /HTTPS/);
  assert.equal(readServerConfig({ ...secrets, HOST: '0.0.0.0', PUBLIC_ORIGIN: 'https://example.test' }).config.PUBLIC_ORIGIN, 'https://example.test');
});

test('HTTP host and target guards ignore forwarded identity and preserve independent cookies', async () => {
  const seen = [];
  const runtime = { async fetch(input, meta) {
    seen.push({ url: input.url, headers: Object.fromEntries(input.headers), remote: meta.remoteAddress });
    const headers = new Headers({ 'Content-Type': 'text/plain' });
    headers.append('Set-Cookie', 'first=1; HttpOnly'); headers.append('Set-Cookie', 'second=2; HttpOnly');
    return new Response('ok', { headers });
  } };
  const server = await startHttpServer({ runtime, port: 0, publicOrigin: 'https://gateway.example' });
  try {
    assert.equal((await raw(server.url, { headers: { Host: 'evil.example', 'X-Forwarded-Host': 'gateway.example' } })).status, 403);
    assert.equal(seen.length, 0);
    const valid = await raw(new URL('/admin/status', server.url), { headers: { Host: 'gateway.example',
      'X-Forwarded-Proto': 'http', 'X-OneAPI-Local-Bridge-Token': 'attacker', 'Cf-Access-Jwt-Assertion': 'signed-fixture' } });
    assert.equal(valid.status, 200);
    assert.equal(seen[0].url, 'https://gateway.example/admin/status');
    assert.equal(seen[0].headers['x-forwarded-proto'], undefined);
    assert.equal(seen[0].headers['x-oneapi-local-bridge-token'], undefined);
    assert.equal(seen[0].headers['cf-access-jwt-assertion'], 'signed-fixture');
    assert.equal(valid.headers['set-cookie'].length, 2);
    assert.equal((await raw(server.url, { path: '//evil.example/path' })).status, 403);
  } finally { await server.close(); }
});

test('oversized request is rejected before the application receives it', async () => {
  let calls = 0;
  const server = await startHttpServer({ runtime: { async fetch() { calls++; return new Response('unexpected'); } }, port: 0 });
  try {
    const response = await raw(server.url, { method: 'POST', headers: { 'Content-Length': String(1024 * 1024 + 1) }, body: Buffer.alloc(1024 * 1024 + 1) });
    assert.equal(response.status, 413); assert.equal(calls, 0);
  } finally { await server.close(); }
});

test('disconnect before response aborts only that request and lets another call complete', async () => {
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  let cancelled;
  const ended = new Promise(resolve => { cancelled = resolve; });
  const runtime = { async fetch(input) {
    if (new URL(input.url).pathname === '/slow') {
      started();
      await new Promise(resolve => input.signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true }));
      return new Response('cancelled');
    }
    return new Response('other call completed');
  } };
  const server = await startHttpServer({ runtime, port: 0 });
  try {
    const slow = httpRequest(new URL('/slow', server.url));
    slow.on('error', () => {}); slow.end();
    await deadline(begun);
    const other = await raw(new URL('/fast', server.url));
    assert.equal(other.body, 'other call completed');
    slow.destroy(); await deadline(ended);
  } finally { await server.close(); }
});

test('stream disconnect reaches the response source cancellation', async () => {
  let cancelled;
  const ended = new Promise(resolve => { cancelled = resolve; });
  const runtime = { async fetch() { return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: fixture\n\n')); }, cancel() { cancelled(); },
  }), { headers: { 'Content-Type': 'text/event-stream' } }); } };
  const server = await startHttpServer({ runtime, port: 0 });
  try {
    const req = httpRequest(server.url); req.on('error', () => {}); req.end();
    const [res] = await deadline(once(req, 'response'));
    await deadline(once(res, 'data')); res.destroy();
    await deadline(ended);
  } finally { await server.close(); }
});
