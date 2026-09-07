import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function child(cleanup) {
  const code = `import { cleanupWithDeadline } from './scripts/cleanup-deadline.mjs'; await cleanupWithDeadline(${cleanup}, x => console.log(JSON.stringify(x)), 100);`;
  const processHandle = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  processHandle.stdout.on('data', bytes => { output += bytes; });
  processHandle.stderr.resume();
  const watchdog = setTimeout(() => processHandle.kill(), 2000);
  try { const [code, signal] = await once(processHandle, 'exit'); return { code, signal, output }; }
  finally { clearTimeout(watchdog); }
}
test('normal cleanup clears its deadline and exits successfully', async () => {
  const result = await child('async () => {}');
  assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.output, '');
});
test('nonsettling cleanup exits with a safe deadline failure within a fixed budget', async () => {
  const result = await child('async () => { await new Promise(() => {}); }');
  assert.equal(result.code, 1); assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.output), { stage: 'cleanup_deadline', failed: true, timeoutMs: 100 });
});
