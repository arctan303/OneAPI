import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { formatIpOrigin, isLoopbackHost, isPrivateAddress, normalizeAddress, parseLanOrigins } from './network-config.mjs';

export const SERVER_HELP = `Usage: node oneapi.mjs [options]

Options:
  --host <ip|localhost>       Listening address (default: HOST or 127.0.0.1)
  --port <1-65535>            Listening port (default: PORT or 8787)
  --lan                       Allow this machine's private IP origins for this run
  --public-origin <https://>  Exact public HTTPS origin for a reverse proxy or tunnel
  --help                      Show this help without opening the database

Command-line options override .env for this process and do not edit it.`;

function parseArgs(argv) {
  const result = {};
  const valued = new Map([['--host', 'host'], ['--port', 'port'], ['--public-origin', 'publicOrigin']]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      if (result.help) throw new Error('--help may only be specified once');
      result.help = true;
      continue;
    }
    if (argument === '--lan') {
      if (result.lan) throw new Error('--lan may only be specified once');
      result.lan = true;
      continue;
    }
    const key = valued.get(argument);
    if (!key) throw new Error(`Unknown option: ${argument}`);
    if (result[key] !== undefined) throw new Error(`${argument} may only be specified once`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    result[key] = value;
  }
  return result;
}

function exactPublicOrigin(value) {
  let origin;
  try { origin = new URL(value); } catch { throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin'); }
  if (origin.protocol !== 'https:' || origin.origin !== value || origin.port || value.length > 512 || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin');
  }
  return origin.origin;
}

function privateInterfaceAddresses(interfaces) {
  const values = [];
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      const address = normalizeAddress(entry.address);
      if (!entry.internal && isPrivateAddress(address)) values.push({ address, family: address.includes(':') ? 6 : 4 });
    }
  }
  return values;
}

function lanOriginsForRun(host, port, interfaces) {
  const addresses = privateInterfaceAddresses(interfaces);
  let selected;
  if (host === '0.0.0.0') selected = addresses.filter(item => item.family === 4);
  else if (host === '::') selected = addresses.filter(item => item.family === 6);
  else {
    const normalized = normalizeAddress(host);
    if (!isPrivateAddress(normalized) || !addresses.some(item => item.address === normalized)) {
      throw new Error('--lan requires HOST to be a private IP assigned to this machine, 0.0.0.0, or ::');
    }
    selected = [{ address: normalized, family: normalized.includes(':') ? 6 : 4 }];
  }
  if (selected.length === 0) throw new Error('--lan found no matching private network interface');
  return parseLanOrigins(selected.map(item => formatIpOrigin(item.address, port)).join(','));
}

export function readServerConfig(source = process.env, cwd = process.cwd(), argv = [], interfaces = networkInterfaces()) {
  const args = parseArgs(argv);
  if (args.help) return { help: true, helpText: SERVER_HELP };
  const host = args.host ?? source.HOST ?? '127.0.0.1';
  if (!isIP(host) && host !== 'localhost') throw new Error('HOST must be an IP address or localhost');
  const portText = args.port ?? source.PORT ?? '8787';
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
  const publicOriginValue = args.publicOrigin ?? source.PUBLIC_ORIGIN;
  if (publicOriginValue) config.PUBLIC_ORIGIN = exactPublicOrigin(publicOriginValue);
  const lanOrigins = args.lan ? lanOriginsForRun(host, port, interfaces) : parseLanOrigins(source.LAN_ORIGINS);
  if (lanOrigins.length) config.LAN_ORIGINS = lanOrigins.join(',');
  if (!isLoopbackHost(host) && lanOrigins.length === 0 && !config.PUBLIC_ORIGIN) {
    throw new Error('LAN_ORIGINS or PUBLIC_ORIGIN is required when HOST is not loopback');
  }
  const dataDir = resolve(cwd, source.DATA_DIR || 'data');
  const normalizedHost = host === 'localhost' ? host : normalizeAddress(host);
  const accessHost = normalizedHost.includes(':') ? `[${normalizedHost}]` : normalizedHost;
  const accessUrls = [
    ...(isLoopbackHost(host) ? [new URL(`http://${accessHost}:${port}`).origin] : []),
    ...lanOrigins,
    ...(config.PUBLIC_ORIGIN ? [config.PUBLIC_ORIGIN] : []),
  ];
  return { host, port, databasePath: resolve(dataDir, 'oneapi.sqlite'), config, accessUrls };
}
