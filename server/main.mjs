import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readServerConfig } from './config.mjs';
import { startHttpServer } from './http.mjs';
import { createServerRuntime } from '../src/runtime/node/runtime.ts';

export { createServerRuntime, readServerConfig, startHttpServer };

export async function main() {
  const { host, port, databasePath, config } = readServerConfig();
  const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), 'public');
  const runtime = await createServerRuntime({ databasePath, publicDir, config });
  let http;
  try {
    await runtime.ready;
    http = await startHttpServer({ runtime, host, port, publicOrigin: config.PUBLIC_ORIGIN });
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  console.log(JSON.stringify({ event: 'oneapi_ready', runtime: 'node', listen: http.url.origin,
    ...(config.PUBLIC_ORIGIN ? { publicOrigin: config.PUBLIC_ORIGIN } : {}) }));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try { await http.close(); } finally { await runtime.dispose(); }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  }
  return { runtime, http, shutdown };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({ error: 'server_start_failed', message: 'Check configuration, data directory permissions, and whether another instance is running.' }));
    process.exitCode = 1;
  });
}
