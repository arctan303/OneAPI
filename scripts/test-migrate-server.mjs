import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { serialize } from 'node:v8';
import { mkdir, mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { migrateLegacy } from '../dist/server/migrate.mjs';

const outputRoot = resolve('output/server-migration-tests');
const encryptionKey = Buffer.alloc(32, 9).toString('base64');
const credentials = { idToken: 'fixture-id-token', accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token',
  accountId: 'fixture-account', expiresAt: Date.now() + 86_400_000, lastRefreshAt: Date.now(), version: 1 };
async function fixture() {
  await mkdir(outputRoot, { recursive: true });
  const root = await mkdtemp(join(outputRoot, 'migration-'));
  const legacyRoot = join(root, 'legacy');
  const directory = join(legacyRoot, 'do/oneapi-codex-gateway-demo-AccountDurableObject');
  await mkdir(directory, { recursive: true });
  const source = join(directory, 'a'.repeat(64) + '.sqlite');
  const iv = new Uint8Array(12).fill(4);
  const key = await crypto.subtle.importKey('raw', Buffer.from(encryptionKey, 'base64'), 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('oneapi:credentials:v1') }, key,
    new TextEncoder().encode(JSON.stringify(credentials)));
  const envelope = { version: 1, iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') };
  const sourceDb = new DatabaseSync(source);
  sourceDb.exec('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB NOT NULL)');
  const put = sourceDb.prepare('INSERT INTO _cf_KV VALUES (?, ?)');
  put.run('credentials', serialize(envelope)); put.run('credential-version', serialize(1));
  put.run('api-keys', serialize([{ id: 'key_fixture', digest: 'fixture-key-digest', name: 'kept', masked: 'fixture...key', createdAt: 1 }]));
  put.run('access-config', serialize({ enabled: false, teamDomain: null, applicationAud: null, revision: 1, updatedAt: 1 }));
  put.run('admin-sessions', serialize([{ digest: 'session_must_not_migrate' }]));
  put.run('leases', serialize([{ id: 'lease_must_not_migrate' }]));
  sourceDb.exec(`CREATE TABLE request_logs (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, key_id TEXT NOT NULL, key_name TEXT NOT NULL, protocol TEXT NOT NULL,
    model TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, duration_ms INTEGER, http_status INTEGER,
    outcome TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, body_captured INTEGER NOT NULL,
    request_truncated INTEGER NOT NULL, response_truncated INTEGER NOT NULL, request_body TEXT, response_body TEXT, body_expires_at INTEGER)`);
  const addLog = sourceDb.prepare('INSERT INTO request_logs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  addLog.run('finished', 'req1', 'key_fixture', 'kept', 'responses', 'gpt-5.5', 1, 2, 1, 200, 'completed', 1, 2, 3, 1, 0, 0, '{"input":"fixture"}', '{"output":"fixture"}', null);
  addLog.run('active', 'req2', 'key_fixture', 'kept', 'responses', 'gpt-5.5', 2, null, null, null, 'started', null, null, null, 0, 0, 0, null, null, null);
  sourceDb.close();
  return { root, source, legacyRoot, envelope, targetPath: join(root, 'new/oneapi.sqlite') };
}
async function cleanup(root) {
  const absolute = resolve(root);
  assert.equal(absolute.startsWith(outputRoot + (process.platform === 'win32' ? '\\' : '/')), true);
  await rm(absolute, { recursive: true, force: true });
}
async function hash(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }

test('migrates encrypted OAuth, API keys, Access config and completed logs without changing the source', async () => {
  const value = await fixture();
  try {
    const before = await hash(value.source);
    const result = await migrateLegacy({ ...value, encryptionKey });
    assert.deepEqual(result, { migrated: true, accountMigrated: true, persistentKeys: 4, completedLogs: 1,
      omittedActiveLogs: 1, sessionsMigrated: false, sourceUnchanged: true });
    assert.equal(await hash(value.source), before);
    const database = new DatabaseSync(value.targetPath, { readOnly: true });
    try {
      const row = database.prepare('SELECT value FROM oneapi_kv WHERE key = ?');
      assert.deepEqual(JSON.parse(row.get('credentials').value), value.envelope);
      assert.equal(JSON.parse(row.get('api-keys').value)[0].id, 'key_fixture');
      assert.equal(row.get('admin-sessions'), undefined); assert.equal(row.get('leases'), undefined);
      assert.deepEqual(database.prepare('SELECT id, total_tokens, request_body FROM request_logs').all().map(x => ({ ...x })),
        [{ id: 'finished', total_tokens: 3, request_body: '{"input":"fixture"}' }]);
    } finally { database.close(); }
    assert.equal((await readFile(value.targetPath)).includes(Buffer.from('fixture-access-token')), false);
    assert.equal((await readdir(join(value.root, 'new'))).some(name => name.includes('.migration-')), false);
    const targetHash = await hash(value.targetPath);
    await assert.rejects(migrateLegacy({ ...value, encryptionKey }), { code: 'target_already_exists' });
    assert.equal(await hash(value.targetPath), targetHash);
  } finally { await cleanup(value.root); }
});

test('wrong encryption key does not create a target or modify the source', async () => {
  const value = await fixture();
  try {
    const before = await hash(value.source);
    await assert.rejects(migrateLegacy({ ...value, encryptionKey: Buffer.alloc(32, 3).toString('base64') }), { code: 'credential_key_mismatch_or_invalid' });
    await assert.rejects(readFile(value.targetPath), { code: 'ENOENT' });
    assert.equal(await hash(value.source), before);
  } finally { await cleanup(value.root); }
});

test('running legacy Node store lock prevents migration', async () => {
  const value = await fixture();
  let lock;
  try {
    lock = new DatabaseSync(join(value.legacyRoot, '.oneapi-node-runtime.lock.sqlite'));
    lock.exec('BEGIN EXCLUSIVE');
    await assert.rejects(migrateLegacy({ ...value, encryptionKey }), { code: 'legacy_runtime_running' });
    await assert.rejects(readFile(value.targetPath), { code: 'ENOENT' });
  } finally { lock?.close(); await cleanup(value.root); }
});
