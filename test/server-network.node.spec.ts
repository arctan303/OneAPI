import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { readServerConfig } from '../server/config.mjs';
import { startHttpServer } from '../server/http.mjs';
import { exactLanOrigin, formatIpOrigin, isLoopbackAddress, isLoopbackHost, isPrivateAddress, normalizeAddress, parseLanOrigins } from '../server/network-config.mjs';
import { createServerRuntime } from '../src/runtime/node/runtime';
import type { GatewayRequestContext } from '../src/runtime/contracts';

const secrets = {
  ADMIN_API_KEY: 'a'.repeat(43),
  GATEWAY_API_KEY: 'b'.repeat(43),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

interface RawOptions {
  headers?: OutgoingHttpHeaders;
  method?: string;
  body?: string | Buffer;
}

interface RawResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function raw(url: string | URL, { headers = {}, method = 'GET', body }: RawOptions = {}): Promise<RawResult> {
  return new Promise<RawResult>((resolve, reject) => {
    const request = httpRequest(url, { headers, method }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function tempRuntime() {
  const root = await mkdtemp(path.join(tmpdir(), 'oneapi-lan-test-'));
  const publicDir = path.join(root, 'public');
  await mkdir(publicDir);
  await Promise.all([
    writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>OneAPI</title>'),
    writeFile(path.join(publicDir, 'app.js'), ''),
    writeFile(path.join(publicDir, 'styles.css'), ''),
  ]);
  const config = { ...secrets, LAN_ORIGINS: 'http://192.168.10.20:9090' };
  const runtime = await createServerRuntime({
    databasePath: path.join(root, 'oneapi.sqlite'),
    publicDir,
    config,
    logger: () => undefined,
  });
  await runtime.ready;
  return { root, runtime, config };
}

test('private origin parsing accepts only literal RFC1918 and ULA addresses', () => {
  for (const value of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.4.3', 'fc00::1', 'fd12:3456::1']) {
    assert.equal(isPrivateAddress(value), true, value);
  }
  for (const value of ['8.8.8.8', '172.32.0.1', '100.64.0.1', 'fd12', 'fc::1', 'fd::1', 'fc00.example', 'not:ipv6']) {
    assert.equal(isPrivateAddress(value), false, value);
  }
  assert.equal(exactLanOrigin('http://192.168.1.2:9090'), 'http://192.168.1.2:9090');
  assert.equal(exactLanOrigin('https://[fd12:3456::1]:9443'), 'https://[fd12:3456::1]:9443');
  assert.equal(formatIpOrigin('192.168.1.2', 80), 'http://192.168.1.2');
  for (const origin of ['http://fd12:9090', 'http://fc00.example:9090', 'http://8.8.8.8:9090', 'http://192.168.1.2/path']) {
    assert.throws(() => exactLanOrigin(origin));
  }
});

test('loopback normalization covers 127/8, IPv6 and IPv4-mapped forms', () => {
  for (const address of [
    '127.0.0.1', '127.0.0.2', '127.255.255.254',
    '::1', '[::1]', '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.2', '[::ffff:7f00:2]', '0:0:0:0:0:ffff:7f00:2',
  ]) assert.equal(isLoopbackAddress(address), true, address);
  for (const address of ['126.255.255.255', '128.0.0.1', '::2', '::ffff:192.168.1.2']) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(normalizeAddress('[::ffff:127.0.0.2]'), '127.0.0.2');
  const mapped = readServerConfig({ ...secrets, HOST: '::ffff:127.0.0.2', PORT: '9090' });
  if ('help' in mapped && mapped.help) throw new Error('resolved config expected');
  assert.deepEqual(mapped.accessUrls, ['http://127.0.0.2:9090']);
  const ipv6 = readServerConfig({ ...secrets, HOST: '0:0:0:0:0:0:0:1', PORT: '9090' });
  if ('help' in ipv6 && ipv6.help) throw new Error('resolved config expected');
  assert.deepEqual(ipv6.accessUrls, ['http://[::1]:9090']);
});
test('startup arguments override environment and --help needs no secrets', () => {
  const help = readServerConfig({}, '.', ['--help']);
  assert.equal(help.help, true);
  if (!help.help) throw new Error('help result expected');
  assert.match(help.helpText, /--public-origin/);
  const interfaces = {
    Ethernet: [
      { address: '192.168.50.4', family: 'IPv4', internal: false },
      { address: '8.8.8.8', family: 'IPv4', internal: false },
    ],
  };
  const result = readServerConfig(
    { ...secrets, HOST: '127.0.0.1', PORT: '8787', LAN_ORIGINS: 'http://10.0.0.1:8787' },
    '.',
    ['--host', '0.0.0.0', '--port', '9090', '--lan'],
    interfaces,
  );
  if ('help' in result && result.help) throw new Error('resolved config expected');
  assert.equal(result.host, '0.0.0.0');
  assert.equal(result.port, 9090);
  assert.equal(result.config.LAN_ORIGINS, 'http://192.168.50.4:9090');
  assert.deepEqual(result.accessUrls, ['http://192.168.50.4:9090']);
  assert.throws(() => readServerConfig(secrets, '.', ['--host', '0.0.0.0'], interfaces), /LAN_ORIGINS|PUBLIC_ORIGIN/);
  assert.throws(() => readServerConfig(secrets, '.', ['--host', '192.168.50.9', '--lan'], interfaces), /assigned/);
  assert.throws(() => readServerConfig({ ...secrets, LAN_ORIGINS: 'http://fd12:9090' }), /LAN_ORIGINS/);
  assert.throws(() => readServerConfig(secrets, '.', ['--port', '0']), /PORT/);
  const crowdedInterfaces = {
    Ethernet: Array.from({ length: 33 }, (_, index) => ({
      address: `10.0.0.${index + 1}`,
      family: 'IPv4',
      internal: false,
    })),
  };
  assert.throws(
    () => readServerConfig(secrets, '.', ['--host', '0.0.0.0', '--lan'], crowdedInterfaces),
    /at most 32 origins/,
  );
});

test('HTTP adapter maps only configured LAN authorities and preserves configured scheme', async () => {
  const seen: Array<{ url: string; remoteAddress?: string }> = [];
  const runtime = { async fetch(request: Request, context: GatewayRequestContext = {}) {
    seen.push({ url: request.url, remoteAddress: context.remoteAddress });
    return new Response('ok');
  } };
  const server = await startHttpServer({
    runtime,
    port: 0,
    lanOrigins: ['http://192.168.10.20:9090', 'https://10.0.0.2:9443'],
  });
  try {
    assert.equal((await raw(server.url, { headers: { Host: '192.168.10.20:9090' } })).status, 200);
    assert.equal(seen.at(-1)?.url, 'http://192.168.10.20:9090/');
    assert.equal((await raw(server.url, { headers: { Host: '10.0.0.2:9443', Forwarded: 'for=8.8.8.8' } })).status, 200);
    assert.equal(seen.at(-1)?.url, 'https://10.0.0.2:9443/');
    assert.equal((await raw(server.url, { headers: { Host: '192.168.10.21:9090', 'X-Forwarded-Host': '192.168.10.20:9090' } })).status, 403);
  } finally {
    await server.close();
  }
  await assert.rejects(
    startHttpServer({ runtime, port: 0, lanOrigins: ['http://192.168.1.2', 'https://192.168.1.2'] }),
    /both HTTP and HTTPS/,
  );
});

test('non-.1 IPv4 loopback supports health and the admin session lifecycle', async () => {
  const resolved = readServerConfig({ ...secrets, HOST: '127.0.0.2', PORT: '9090' });
  if ('help' in resolved && resolved.help) throw new Error('resolved config expected');
  assert.deepEqual(resolved.accessUrls, ['http://127.0.0.2:9090']);

  const { root, runtime } = await tempRuntime();
  const server = await startHttpServer({ runtime, host: resolved.host, port: 0 });
  const origin = server.url.origin;
  try {
    assert.equal((await raw(new URL('/health', origin))).status, 200);
    const login = await raw(new URL('/admin/session', origin), {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: secrets.ADMIN_API_KEY }),
    });
    assert.equal(login.status, 200);
    const cookies = login.headers['set-cookie'];
    assert.ok(Array.isArray(cookies));
    assert.doesNotMatch(cookies[0]!, /; Secure/i);
    const cookie = cookies[0]!.split(';', 1)[0]!;
    const session = await raw(new URL('/admin/session', origin), { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    assert.equal(JSON.parse(session.body).authenticated, true);
    const logout = await raw(new URL('/admin/session', origin), {
      method: 'DELETE',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': '2' },
      body: '{}',
    });
    assert.equal(logout.status, 204);
    const logoutCookies = logout.headers['set-cookie'];
    assert.ok(Array.isArray(logoutCookies));
    assert.match(logoutCookies[0]!, /Max-Age=0/);
  } finally {
    await server.close();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
test('LAN HTTP login and logout require exact origin while public peers cannot forge LAN access', async () => {
  const { root, runtime, config } = await tempRuntime();
  const server = await startHttpServer({ runtime, port: 0, lanOrigins: config.LAN_ORIGINS });
  const origin = 'http://192.168.10.20:9090';
  const headers = { Host: '192.168.10.20:9090', Origin: origin, 'Content-Type': 'application/json' };
  try {
    const crossSite = await raw(new URL('/admin/session', server.url), {
      method: 'POST',
      headers: { ...headers, Origin: 'http://192.168.10.21:9090' },
      body: JSON.stringify({ password: secrets.ADMIN_API_KEY }),
    });
    assert.equal(crossSite.status, 403);

    const login = await raw(new URL('/admin/session', server.url), {
      method: 'POST',
      headers,
      body: JSON.stringify({ password: secrets.ADMIN_API_KEY }),
    });
    assert.equal(login.status, 200);
    const loginCookies = login.headers['set-cookie'];
    assert.ok(Array.isArray(loginCookies));
    const cookie = loginCookies[0]!.split(';', 1)[0]!;
    assert.doesNotMatch(loginCookies[0]!, /; Secure/i);

    const session = await raw(new URL('/admin/session', server.url), {
      headers: { Host: '192.168.10.20:9090', Cookie: cookie },
    });
    assert.equal(session.status, 200);
    assert.equal(JSON.parse(session.body).authenticated, true);

    const unauthorized = await raw(new URL('/admin/status', server.url), {
      headers: { Host: '192.168.10.20:9090' },
    });
    assert.equal(unauthorized.status, 401);

    const forged = await runtime.fetch(new Request(origin + '/health', {
      headers: { Forwarded: 'for=192.168.10.3', 'X-Forwarded-For': '192.168.10.3' },
    }), { remoteAddress: '203.0.113.9' });
    assert.equal(forged.status, 403);

    const logout = await raw(new URL('/admin/session', server.url), {
      method: 'DELETE',
      headers: { ...headers, Cookie: cookie, 'Content-Length': '2' },
      body: '{}',
    });
    assert.equal(logout.status, 204);
    const logoutCookies = logout.headers['set-cookie'];
    assert.ok(Array.isArray(logoutCookies));
    assert.match(logoutCookies[0]!, /Max-Age=0/);
  } finally {
    await server.close();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
