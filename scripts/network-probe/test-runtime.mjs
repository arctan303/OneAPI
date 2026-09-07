import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { convertV4MiniflareOptions, Miniflare, Response as MiniflareResponse } from 'miniflare';
import { syntheticRequest, WORKER_NAME } from './core.mjs';
import { createLocalRuntime } from './run.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://oneapi-network-probe.fixture.workers.dev';

async function plainInit(request) {
  return {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: await request.text(),
    cache: request.cache,
    redirect: request.redirect,
  };
}

async function bundledWorker() {
  const result = await esbuild.build({
    absWorkingDir: directory,
    entryPoints: [path.join(directory, 'worker.mjs')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:*'],
    logLevel: 'silent',
  });
  assert.equal(result.outputFiles.length, 1);
  return result.outputFiles[0].text;
}

test('Miniflare v5 loads the module graph and handles a local collector request', async () => {
  const runtime = await createLocalRuntime(ORIGIN);
  try {
    await runtime.ready;
    const request = syntheticRequest('http://probe.local/collect');
    const response = await runtime.dispatchFetch(request.url, await plainInit(request));
    const observation = await response.json();
    assert.equal(response.status, 200);
    assert.equal(observation.schema, 'oneapi-network-observation-v1');
    assert.equal(observation.provenance['user-agent'].present, true);
  } finally {
    await runtime.dispose();
  }
});

test('workerd top probe uses manual redirect and calls the fixed outbound service once', async () => {
  let collectorCalls = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    name: WORKER_NAME,
    script: await bundledWorker(),
    modules: true,
    rootPath: directory,
    compatibilityDate: '2026-09-07',
    compatibilityFlags: ['global_fetch_strictly_public'],
    bindings: { COLLECTOR_ORIGIN: ORIGIN },
    durableObjects: { PROBE: { className: 'ProbeDO', useSQLite: true } },
    cf: false,
    resourcePersistencePath: undefined,
    unsafeEnableSharedStorage: false,
    logRequests: false,
    outboundService: async () => {
      collectorCalls += 1;
      return new MiniflareResponse('fixture', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' },
      });
    },
  }));
  try {
    await runtime.ready;
    const request = syntheticRequest('http://probe.local/run/top');
    assert.equal(request.redirect, 'manual');
    const response = await runtime.dispatchFetch(request.url, await plainInit(request));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: { code: 'collector_http_403' } });
    assert.equal(collectorCalls, 1);
  } finally {
    await runtime.dispose();
  }
});
