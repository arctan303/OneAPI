export interface Env {
  ACCOUNT: DurableObjectNamespace;
  ASSETS: Fetcher;
  ADMIN_API_KEY: string;
  GATEWAY_API_KEY: string;
  TOKEN_ENCRYPTION_KEY: string;
  MOCK_UPSTREAM?: string;
  ALLOW_TEST_HOSTS?: string;
  MOCK_INSTANCE_NONCE?: string;
  ONEAPI_LOCAL_OUTBOUND?: Fetcher;
  ONEAPI_RELAY_ORIGIN?: string;
  ONEAPI_RELAY_KEY?: string;
  ONEAPI_WS_DIAGNOSTIC?: string;
  PUBLIC_ORIGIN?: string;
  WORKER_ORIGIN?: string;
  ACCOUNT_IMPORT_SECRET?: string;
}

export interface AccessConfig {
  enabled: boolean;
  teamDomain: string | null;
  applicationAud: string | null;
  updatedAt: number;
  revision: number;
}

export interface StoredCredentials {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number | null;
  lastRefreshAt: number;
  version: number;
}

export interface EncryptedValue {
  version: 1;
  iv: string;
  ciphertext: string;
}

export interface LoginPublicState {
  id: string;
  status: "pending" | "connected" | "cancelled" | "expired" | "failed";
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
  nextPollAt: number;
  intervalMs: number;
  generation: number;
  error?: { code: string; message: string };
}

export interface LoginPrivateState {
  deviceAuthId: string;
}

export interface ModelCapability {
  id: string;
  reasoning: {
    supportedEfforts: string[] | null;
    defaultEffort: string | null;
  };
}

export interface StoredAdminSession {
  digest: string;
  createdAt: number;
  expiresAt: number;
}

export interface StoredApiKey {
  id: string;
  name: string;
  digest: string;
  masked: string;
  createdAt: number;
  enabled?: boolean;
  expiresAt?: number | null;
  modelAccess?: ModelAccess;
  rateLimitPerMinute?: number | null;
  concurrencyLimit?: number | null;
}

export interface ModelAccess {
  mode: "all" | "allowlist";
  models: string[];
}

export interface ApiKeyPolicy {
  enabled: boolean;
  expiresAt: number | null;
  modelAccess: ModelAccess;
  rateLimitPerMinute: number | null;
  concurrencyLimit: number | null;
}

export interface GatewayIdentity extends ApiKeyPolicy {
  id: string;
  name: string;
  masked: string;
  createdAt: number;
  legacy: boolean;
}

export interface UsageWindow {
  limitId: string | null;
  label: string | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: number | null;
  resetsInSeconds?: number | null;
  windowDurationMins: number | null;
}

export interface UsageSnapshot {
  available: true;
  fetchedAt: number;
  lastSuccessAt: number;
  error: null;
  windows: { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null };
  additional: UsageWindow[];
}

export interface LogSettings {
  summaryRetentionDays: number;
  bodyRetentionDays: number;
  captureBodies: boolean;
  maxBodyBytes: number;
}

export type RequestLogOutcome = "completed" | "error" | "cancelled" | "incomplete";

export interface RequestLogUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface RequestLogSummary {
  id: string;
  requestId: string;
  keyId: string;
  keyName: string;
  protocol: "responses" | "chat";
  model: string;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  httpStatus: number | null;
  outcome: RequestLogOutcome;
  usage: RequestLogUsage;
  bodyCaptured: boolean;
  bodyExpired: boolean;
  requestTruncated: boolean;
  responseTruncated: boolean;
  ignoredParameters: string[];
}

export interface StoredRequestLog extends RequestLogSummary {
  requestBody: Record<string, unknown> | null;
  responseBody: Record<string, unknown> | null;
  bodyExpiresAt: number | null;
}
