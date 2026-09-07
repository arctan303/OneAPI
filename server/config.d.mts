export interface NetworkInterfaceEntry {
  address: string;
  family?: string | number;
  internal?: boolean;
}

export interface ServerRuntimeValues {
  ADMIN_API_KEY: string;
  GATEWAY_API_KEY: string;
  TOKEN_ENCRYPTION_KEY: string;
  PUBLIC_ORIGIN?: string;
  LAN_ORIGINS?: string;
}

export interface ResolvedServerConfig {
  help?: false;
  host: string;
  port: number;
  databasePath: string;
  config: ServerRuntimeValues;
  accessUrls: string[];
}

export interface ServerHelp {
  help: true;
  helpText: string;
}

export const SERVER_HELP: string;
export function readServerConfig(
  source?: Record<string, string | undefined>,
  cwd?: string,
  argv?: string[],
  interfaces?: Record<string, NetworkInterfaceEntry[] | undefined>
): ResolvedServerConfig | ServerHelp;
