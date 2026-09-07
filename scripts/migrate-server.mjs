import { DatabaseSync } from 'node:sqlite';
import { deserialize } from 'node:v8';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteAccountStorage } from '../src/runtime/node/sqlite-storage.ts';

const KEEP_KEYS = ['credentials', 'credential-version', 'generation', 'reauth-required', 'api-keys',
  'legacy-key-policy', 'access-config', 'log-settings'];
const LOG_COLUMNS = ['id', 'request_id', 'key_id', 'key_name', 'protocol', 'model', 'started_at', 'completed_at',
  'duration_ms', 'http_status', 'outcome', 'input_tokens', 'output_tokens', 'total_tokens', 'body_captured',
  'request_truncated', 'response_truncated', 'request_body', 'response_body', 'body_expires_at'];

export class MigrationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function digest(path) {
  if (!await exists(path)) return null;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function sourceFingerprint(path) {
  return JSON.stringify([await digest(path), await digest(path + '-wal')]);
}
async function validateCredentials(envelope, encryptionKey) {
  if (!envelope) return false;
  const keyBytes = Buffer.from(encryptionKey ?? '', 'base64');
  if (keyBytes.length !== 32 || keyBytes.toString('base64') !== encryptionKey) throw new MigrationError('invalid_encryption_key');
  if (envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string'
    || Buffer.from(envelope.iv, 'base64').length !== 12 || envelope.ciphertext.length > 128 * 1024) {
    throw new MigrationError('invalid_credential_envelope');
  }
  let clear;
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64'),
      additionalData: new TextEncoder().encode('oneapi:credentials:v1') }, key, Buffer.from(envelope.ciphertext, 'base64')));
    const value = JSON.parse(new TextDecoder().decode(clear));
    if (!value || ['accessToken', 'refreshToken', 'idToken', 'accountId'].some(name => typeof value[name] !== 'string' || !value[name])) {
      throw new Error('invalid credentials');
    }
  } catch { throw new MigrationError('credential_key_mismatch_or_invalid'); }
  finally { keyBytes.fill(0); clear?.fill(0); }
  return true;
}

export async function migrateLegacy({ legacyRoot, targetPath, encryptionKey }) {
  const canonicalRoot = await realpath(resolve(legacyRoot));
  const storeDir = await realpath(join(canonicalRoot, 'do', 'oneapi-codex-gateway-demo-AccountDurableObject'));
  if (storeDir !== resolve(canonicalRoot, 'do', 'oneapi-codex-gateway-demo-AccountDurableObject')) throw new MigrationError('legacy_symlink_rejected');
  const names = (await readdir(storeDir)).filter(name => /^[a-f0-9]{64}\.sqlite$/.test(name));
  if (names.length !== 1) throw new MigrationError('legacy_store_ambiguous_or_missing');
  const sourcePath = await realpath(join(storeDir, names[0]));
  if (dirname(sourcePath) !== storeDir) throw new MigrationError('legacy_symlink_rejected');
  const target = resolve(targetPath);
  if (await exists(target)) throw new MigrationError('target_already_exists');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(dirname(target));
  if (canonicalParent !== dirname(target)) throw new MigrationError('target_symlink_rejected');
  const stage = `${target}.migration-${randomUUID()}`;
  let source;
  let lock;
  let storage;
  let stageCreated = false;
  try {
    lock = new DatabaseSync(join(canonicalRoot, '.oneapi-node-runtime.lock.sqlite'));
    try { lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE'); }
    catch { throw new MigrationError('legacy_runtime_running'); }
    const fingerprint = await sourceFingerprint(sourcePath);
    source = new DatabaseSync(sourcePath, { readOnly: true });
    source.exec('PRAGMA query_only = ON; BEGIN');
    const entries = Object.create(null);
    const rows = source.prepare(`SELECT key, value FROM _cf_KV WHERE key IN (${KEEP_KEYS.map(() => '?').join(',')})`).all(...KEEP_KEYS);
    for (const row of rows) {
      if (!(row.value instanceof Uint8Array) || row.value.byteLength > 1024 * 1024) throw new MigrationError('invalid_legacy_value');
      entries[row.key] = deserialize(row.value);
    }
    const accountMigrated = await validateCredentials(entries.credentials, encryptionKey);
    const hasLogs = Boolean(source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_logs'").get());
    const logCount = hasLogs ? source.prepare('SELECT count(*) AS total FROM request_logs WHERE completed_at IS NOT NULL').get().total : 0;
    const omittedActiveLogs = hasLogs ? source.prepare('SELECT count(*) AS total FROM request_logs WHERE completed_at IS NULL').get().total : 0;
    const file = await open(stage, 'wx', 0o600); stageCreated = true; await file.close();
    storage = new SqliteAccountStorage(stage);
    const logs = hasLogs ? source.prepare(`SELECT ${LOG_COLUMNS.join(',')} FROM request_logs WHERE completed_at IS NOT NULL`).iterate() : [];
    await storage.importEntries(entries, logs);
    await storage.close(); storage = undefined;
    source.exec('ROLLBACK'); source.close(); source = undefined;
    if (await sourceFingerprint(sourcePath) !== fingerprint) throw new MigrationError('legacy_source_changed');
    if (await exists(stage + '-wal') && (await lstat(stage + '-wal')).size > 0) throw new MigrationError('target_checkpoint_incomplete');
    // link() publishes without replacing an existing target, unlike POSIX rename().
    await link(stage, target);
    return { migrated: true, accountMigrated, persistentKeys: rows.length, completedLogs: logCount,
      omittedActiveLogs, sessionsMigrated: false, sourceUnchanged: true };
  } finally {
    try { await storage?.close(); } finally {
      try { source?.close(); } finally {
        if (lock) { try { lock.exec('ROLLBACK'); } catch {} lock.close(); }
        if (stageCreated) {
          for (const path of [stage, stage + '-wal', stage + '-shm', stage + '.lock.sqlite', stage + '.lock.sqlite-journal']) {
            if (dirname(resolve(path)) !== canonicalParent || !path.startsWith(stage)) throw new MigrationError('cleanup_path_rejected');
            await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
          }
        }
      }
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--legacy-root', '--target'].includes(args[index]) || !args[index + 1] || options[args[index]]) throw new MigrationError('invalid_arguments');
    options[args[index]] = args[index + 1];
  }
  if (!options['--legacy-root'] || !options['--target']) throw new MigrationError('required_arguments_missing');
  return migrateLegacy({ legacyRoot: options['--legacy-root'], targetPath: options['--target'], encryptionKey: process.env.TOKEN_ENCRYPTION_KEY });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify({ migrated: false, code: error instanceof MigrationError ? error.code : 'migration_failed' }));
    process.exitCode = 1;
  });
}
