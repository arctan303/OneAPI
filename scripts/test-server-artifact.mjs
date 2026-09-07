import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, copyFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

test('manifest-only artifact starts outside the repository with no npm install', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'oneapi-artifact-'));
  let child;
  try {
    const manifest = JSON.parse(await readFile('dist/server/manifest.json', 'utf8'));
    assert.equal(manifest.runtimePackages, 0);
    for (const item of manifest.files) {
      assert.ok(!item.file.startsWith('.') || item.file === '.env.example');
      const target = resolve(root, item.file);
      assert.ok(target.startsWith(root + sep));
      const source = resolve('dist/server', item.file);
      const bytes = await readFile(source);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
    assert.equal((await readdir(root)).includes('node_modules'), false);
    // Help must work from the independent payload, without opening a data directory.
    for (const entry of ['oneapi.mjs', 'configure.mjs']) {
      const help = spawnSync(process.execPath, [entry, '--help'], {
        cwd: root, windowsHide: true, timeout: 5000, encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '', ADMIN_API_KEY: '', GATEWAY_API_KEY: '', TOKEN_ENCRYPTION_KEY: '', DATA_DIR: './help-must-not-create-data' }
      });
      assert.equal(help.status, 0, entry + ' --help should work without credentials');
      assert.match(help.stdout, /--help/);
    }
    assert.equal((await readdir(root)).includes('help-must-not-create-data'), false);
    child = spawn(process.execPath, ['oneapi.mjs', '--host', '127.0.0.1', '--port', '18793'], {
      cwd: root, windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '', ADMIN_API_KEY: 'a'.repeat(40), GATEWAY_API_KEY: 'g'.repeat(40),
        TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), HOST: '127.0.0.1', PORT: '18794',
        PUBLIC_ORIGIN: '', DATA_DIR: './data' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('artifact readiness timeout')), 10000);
      let output = '';
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('artifact exited before readiness')); });
      child.stdout.on('data', bytes => {
        output += bytes.toString();
        if (output.includes('oneapi_ready')) {
          clearTimeout(timer);
          accept(JSON.parse(output.trim().split('\n').find(line => line.includes('oneapi_ready'))));
        }
      });
      child.stderr.resume();
    });
    assert.equal(ready.runtime, 'node');
    assert.equal(new URL(ready.listen).port, '18793', 'startup --port must override the environment');
    const health = await fetch(ready.listen + '/health', { signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200);
    await health.arrayBuffer();
    const page = await fetch(ready.listen + '/', { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /OneAPI/);
    const protectedRoute = await fetch(ready.listen + '/admin/status');
    assert.equal(protectedRoute.status, 401);
    await protectedRoute.arrayBuffer();
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('oneapi-artifact-')) throw new Error('cleanup rejected');
    await rm(root, { recursive: true, force: true });
  }
});
