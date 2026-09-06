export const SOURCE_REVISION = "ac192cd7937b0d73edc6dffe009940ae53782dd4";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTH_BASE_URL = "https://auth.openai.com";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEVICE_VERIFICATION_URL = `${AUTH_BASE_URL}/codex/device`;
export const DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000;
// Keep these aligned with the official Codex client protocol revision recorded
// in docs/verification/DEMO-001.md. The integration suffix remains explicit in
// the User-Agent instead of pretending to be an unmodified first-party binary.
export const CLIENT_VERSION = "0.153.4";
export const CODEX_ORIGINATOR = "codex_cli_rs";
export const CODEX_USER_AGENT = `${CODEX_ORIGINATOR}/${CLIENT_VERSION} (Cloudflare Workers; JavaScript) OneAPI/0.1.0`;
