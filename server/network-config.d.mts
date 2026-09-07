export function normalizeAddress(value?: string): string;
export function isLoopbackAddress(value?: string): boolean;
export function isPrivateAddress(value?: string): boolean;
export function isTrustedLanPeer(value?: string): boolean;
export function isLoopbackHost(value?: string): boolean;
export function exactLanOrigin(value: string): string;
export function parseLanOrigins(value?: string): string[];
export function formatIpOrigin(address: string, port: number, protocol?: 'http:' | 'https:'): string;
