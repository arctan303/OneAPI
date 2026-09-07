export type StorageKey = string;
export type StorageDeleteResult = boolean | number | void;

export interface StorageTransaction {
  get<T>(key: StorageKey): Promise<T | undefined>;
  put<T>(key: StorageKey, value: T): Promise<void>;
  put(values: Record<StorageKey, unknown>): Promise<void>;
  delete(key: StorageKey | StorageKey[]): Promise<StorageDeleteResult>;
}

export interface SqlCursor<T extends Record<string, unknown>> extends Iterable<T> {
  toArray(): T[];
}

export interface SqlStorage {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlCursor<T>;
}

export interface AccountStorage extends StorageTransaction {
  readonly sql: SqlStorage;
  transaction<T>(callback: (transaction: StorageTransaction) => Promise<T>): Promise<T>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface AccountServiceConfig {
  ADMIN_API_KEY: string;
  GATEWAY_API_KEY: string;
  TOKEN_ENCRYPTION_KEY: string;
  MOCK_UPSTREAM?: string;
  ONEAPI_RELAY_ORIGIN?: string;
  ONEAPI_RELAY_KEY?: string;
  ONEAPI_WS_DIAGNOSTIC?: string;
  ACCOUNT_IMPORT_SECRET?: string;
}

export interface AccountServiceOptions {
  outboundFetch?: (request: Request, requestGroupId?: string) => Promise<Response>;
}

export const LOCAL_REQUEST_GROUP_HEADER = "X-OneAPI-Local-Request-Group";

export interface GatewayConfig {
  ADMIN_API_KEY: string;
  GATEWAY_API_KEY: string;
  TOKEN_ENCRYPTION_KEY: string;
  PUBLIC_ORIGIN?: string;
  WORKER_ORIGIN?: string;
  MOCK_UPSTREAM?: string;
  MOCK_INSTANCE_NONCE?: string;
  ALLOW_TEST_HOSTS?: string;
}

export interface GatewayHandlers {
  accountFetch(request: Request): Promise<Response>;
  staticFetch(request: Request): Promise<Response>;
  cancelLease?(leaseId: string): Promise<void>;
  allowInternalControl?: boolean;
  allowLoopbackWithoutPeer?: boolean;
  log?(entry: { requestId: string; path: string; method: string; status: number; durationMs: number }): void;
}

export interface GatewayRequestContext {
  remoteAddress?: string;
}