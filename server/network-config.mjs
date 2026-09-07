const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Parts(value) {
  const match = IPV4.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(part => part <= 255) ? parts : null;
}

export function normalizeAddress(value = '') {
  let address = String(value).toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  address = address.split('%', 1)[0];
  if (!address.includes(':')) return address;
  try { address = new URL(`http://[${address}]/`).hostname.slice(1, -1); }
  catch { return address; }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!mapped) return address;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function isLoopbackAddress(value) {
  const address = normalizeAddress(value);
  if (address === '::1') return true;
  const parts = ipv4Parts(address);
  return parts?.[0] === 127;
}

export function isPrivateAddress(value) {
  const address = normalizeAddress(value);
  const parts = ipv4Parts(address);
  if (parts) return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
  try {
    const parsed = new URL(`http://[${address}]/`);
    const first = Number.parseInt(parsed.hostname.slice(1).split(':', 1)[0], 16);
    return first >= 0xfc00 && first <= 0xfdff;
  } catch {
    return false;
  }
}

export function isTrustedLanPeer(value) {
  return isLoopbackAddress(value) || isPrivateAddress(value);
}

export function isLoopbackHost(value) {
  return value === 'localhost' || isLoopbackAddress(value);
}

export function exactLanOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.trim() !== value) throw new Error('LAN_ORIGINS must contain exact private IP origins');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('LAN_ORIGINS must contain exact private IP origins'); }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalHost = parsed.hostname.startsWith('[') || ipv4Parts(parsed.hostname) !== null;
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
      || value !== parsed.origin || !literalHost || !isPrivateAddress(hostname)) {
    throw new Error('LAN_ORIGINS must contain exact http/https RFC1918 or ULA IP origins');
  }
  return parsed.origin;
}

export function parseLanOrigins(value) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string' || value.length > 4096) throw new Error('LAN_ORIGINS is invalid');
  const origins = value.split(',').map(item => exactLanOrigin(item.trim()));
  if (origins.length > 32) throw new Error('LAN_ORIGINS accepts at most 32 origins');
  return [...new Set(origins)];
}

export function formatIpOrigin(address, port, protocol = 'http:') {
  if (!isPrivateAddress(address)) throw new Error('LAN address must be RFC1918 or ULA');
  const host = normalizeAddress(address).includes(':') ? `[${normalizeAddress(address)}]` : normalizeAddress(address);
  return new URL(`${protocol}//${host}:${port}`).origin;
}
