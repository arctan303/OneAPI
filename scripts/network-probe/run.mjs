import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { convertV4MiniflareOptions, fetch as nodeFetch, Miniflare } from 'miniflare';
import {
  readObservationResponse,
  syntheticRequest,
  validateCollectorOrigin,
  WORKER_NAME,
} from './core.mjs';

const MODES = new Set(['node', 'worker-top', 'worker-do', 'local-workerd']);
const directory = path.dirname(fileURLToPath(import.meta.url));

async function dispatchSynthetic(fetchImpl, request, signal) {
  return fetchImpl(request.url, {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: await request.text(),
    cache: request.cache,
    redirect: request.redirect,
    ...(signal ? { signal } : {}),
  });
}

export async function createLocalRuntime(collectorOrigin) {
  const origin = validateCollectorOrigin(collectorOrigin);
  const localOptions = { cf: false, persist: false };
  if (localOptions.cf !== false || localOptions.persist !== false) throw new Error('local_isolation_invalid');
  const bundle = await esbuild.build({
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
  if (bundle.outputFiles.length !== 1) throw new Error('local_bundle_invalid');
  return new Miniflare(convertV4MiniflareOptions({
    name: WORKER_NAME,
    modules: true,
    script: bundle.outputFiles[0].text,
    rootPath: directory,
    compatibilityDate: '2026-09-07',
    compatibilityFlags: ['global_fetch_strictly_public'],
    bindings: { COLLECTOR_ORIGIN: origin },
    durableObjects: { PROBE: { className: 'ProbeDO', useSQLite: true } },
    cf: localOptions.cf,
    // Unset persistence stores resources in an ephemeral directory removed by dispose().
    resourcePersistencePath: localOptions.persist ? path.join(directory, '.state') : undefined,
    unsafeEnableSharedStorage: false,
    logRequests: false,
  }));
}

export async function runProbe(mode, collectorOrigin) {
  if (!MODES.has(mode)) throw new Error('probe_mode_invalid');
  const origin = validateCollectorOrigin(collectorOrigin);
  if (mode === 'node') {
    const request = syntheticRequest(`${origin}/collect`);
    return readObservationResponse(await dispatchSynthetic(nodeFetch, request, AbortSignal.timeout(20_000)));
  }
  if (mode === 'worker-top' || mode === 'worker-do') {
    const pathName = mode === 'worker-top' ? '/run/top' : '/run/do';
    const request = syntheticRequest(`${origin}${pathName}`);
    return readObservationResponse(await dispatchSynthetic(nodeFetch, request, AbortSignal.timeout(20_000)));
  }

  const miniflare = await createLocalRuntime(origin);
  try {
    const request = syntheticRequest('http://probe.local/run/top');
    return readObservationResponse(await dispatchSynthetic(miniflare.dispatchFetch.bind(miniflare), request));
  } finally {
    await miniflare.dispose();
  }
}

async function main() {
  const mode = process.argv[2] ?? '';
  const origin = process.argv[3] ?? '';
  try {
    const observation = await runProbe(mode, origin);
    console.log(JSON.stringify({ mode, observation }));
  } catch {
    console.error('network_probe_failed');
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main();
