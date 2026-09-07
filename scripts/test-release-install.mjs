import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

test('released archive installs with setup and starts without npm dependencies', { timeout: 20000 }, async () => {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.match(version, /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/);
  const root = await mkdtemp(join(tmpdir(), 'oneapi-release-install-'));
  let child;
  try {
    const extracted = spawnSync('tar', ['-xzf', resolve(`dist/oneapi-server-${version}.tar.gz`), '-C', root], { windowsHide: true, encoding: 'utf8' });
    assert.equal(extracted.status, 0, 'archive extraction failed');
    const cwd = join(root, 'server');
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    assert.equal(pkg.version, version);
    assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
    assert.equal((await readdir(cwd)).includes('node_modules'), false);
    assert.match(await readFile(join(cwd, 'INSTALL.md'), 'utf8'), /node setup\.mjs/);
    const setup = () => spawnSync(process.execPath, ['setup.mjs'], { cwd, env: { ...process.env, ONEAPI_ENV_FILE: '.env' }, windowsHide: true, encoding: 'utf8' });
    assert.equal(setup().status, 0, 'initial setup failed');
    const envText = await readFile(join(cwd, '.env'), 'utf8');
    const settings = Object.fromEntries(envText.split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => {
      const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
    }));
    assert.notEqual(settings.ADMIN_API_KEY, settings.GATEWAY_API_KEY);
    assert.equal(Buffer.from(settings.TOKEN_ENCRYPTION_KEY, 'base64').length, 32);
    const again = setup();
    assert.equal(again.status, 0, 'repeat setup failed');
    assert.equal(await readFile(join(cwd, '.env'), 'utf8'), envText);
    assert.ok(!again.stdout.includes(settings.ADMIN_API_KEY));
    const env = { ...process.env, NODE_OPTIONS: '', HOST: '127.0.0.1', PORT: '18794', PUBLIC_ORIGIN: '', DATA_DIR: './data' };
    for (const key of ['ADMIN_API_KEY', 'GATEWAY_API_KEY', 'TOKEN_ENCRYPTION_KEY', 'ONEAPI_ENV_FILE']) delete env[key];
    child = spawn(process.execPath, ['--env-file=.env', 'oneapi.mjs'], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const ready = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('install startup timeout')), 8000);
      let output = '';
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('install startup failed')); });
      child.stdout.on('data', bytes => {
        output += bytes;
        const line = output.split('\n').find(item => item.includes('oneapi_ready'));
        if (line) { clearTimeout(timer); accept(JSON.parse(line)); }
      });
      child.stderr.resume();
    });
    const base = ready.listen;
    const health = await fetch(base + '/health', { signal: AbortSignal.timeout(3000) });
    assert.equal(health.status, 200); await health.arrayBuffer();
    const login = await fetch(base + '/admin/session', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: settings.ADMIN_API_KEY }), signal: AbortSignal.timeout(3000) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const status = await fetch(base + '/admin/status', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).connected, false, 'release must not contain a user account');
    const keys = await fetch(base + '/admin/api-keys', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
    assert.equal(keys.status, 200);
    assert.deepEqual((await keys.json()).data.map(item => item.id), ['legacy'], 'only the newly generated local gateway key is present');
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('oneapi-release-install-')) throw new Error('cleanup rejected');
    await rm(root, { recursive: true, force: true });
  }
});
