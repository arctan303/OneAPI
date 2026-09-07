import { isIP } from 'node:net';
import { resolve } from 'node:path';

export function readServerConfig(source = process.env, cwd = process.cwd()) {
  const host = source.HOST || '127.0.0.1';
  if (!isIP(host) && host !== 'localhost') throw new Error('HOST must be an IP address or localhost');
  const portText = source.PORT || '8787';
  if (!/^\d{1,5}$/.test(portText)) throw new Error('PORT must be an integer');
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const config = {};
  for (const name of ['ADMIN_API_KEY', 'GATEWAY_API_KEY']) {
    const value = source[name];
    if (typeof value !== 'string' || value.length < 32 || value.length > 512 || /\s/.test(value)) {
      throw new Error(`${name} must contain 32 to 512 non-whitespace characters`);
    }
    config[name] = value;
  }
  const encryptionKey = source.TOKEN_ENCRYPTION_KEY;
  if (typeof encryptionKey !== 'string' || Buffer.from(encryptionKey, 'base64').length !== 32
      || Buffer.from(encryptionKey, 'base64').toString('base64') !== encryptionKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 random bytes encoded as base64');
  }
  config.TOKEN_ENCRYPTION_KEY = encryptionKey;
  if (source.PUBLIC_ORIGIN) {
    let origin;
    try { origin = new URL(source.PUBLIC_ORIGIN); } catch { throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin'); }
    if (origin.protocol !== 'https:' || origin.origin !== source.PUBLIC_ORIGIN || origin.port || source.PUBLIC_ORIGIN.length > 512 || origin.username || origin.password) {
      throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin');
    }
    config.PUBLIC_ORIGIN = origin.origin;
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !config.PUBLIC_ORIGIN) {
    throw new Error('PUBLIC_ORIGIN is required when HOST is not loopback');
  }
  const dataDir = resolve(cwd, source.DATA_DIR || 'data');
  return { host, port, databasePath: resolve(dataDir, 'oneapi.sqlite'), config };
}
