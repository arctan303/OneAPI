import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function targetFromArgs(argv) {
  let target = process.env.ONEAPI_ENV_FILE || '.env';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env-path' && argv[i + 1]) {
      target = argv[++i];
      continue;
    }
    throw new Error('unknown argument');
  }
  return resolve(target);
}

function generatedEnv() {
  const key = () => randomBytes(32).toString('base64url');
  return [
    '# OneAPI Node server environment. Keep this file mode 0600.',
    'HOST=127.0.0.1',
    'PORT=8787',
    'DATA_DIR=./data',
    '# PUBLIC_ORIGIN=https://api.example.com',
    `ADMIN_API_KEY=${key()}`,
    `GATEWAY_API_KEY=${key()}`,
    `TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
    '',
  ].join('\n');
}

export function setupEnv(target = targetFromArgs([])) {
  const resolved = resolve(target);
  if (existsSync(resolved)) {
    return { created: false, path: resolved };
  }
  const parent = dirname(resolved);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o750 });
  let fd;
  try {
    fd = openSync(resolved, 'wx', 0o600);
    writeSync(fd, generatedEnv(), undefined, 'utf8');
    chmodSync(resolved, 0o600);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error?.code === 'EEXIST') return { created: false, path: resolved };
    throw error;
  }
  closeSync(fd);
  return { created: true, path: resolved };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const result = setupEnv(targetFromArgs(argv));
    console.log(result.created
      ? JSON.stringify({ event: 'env_created', path: result.path, secretsPrinted: false })
      : JSON.stringify({ event: 'env_exists', path: result.path, unchanged: true, secretsPrinted: false }));
    return result;
  } catch {
    console.error(JSON.stringify({ error: 'env_setup_failed', secretsPrinted: false }));
    process.exitCode = 1;
    return { created: false, failed: true };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
