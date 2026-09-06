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
  reasoningEfforts: string[];
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
}
