import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.mock.jsonc", environment: "test" },
    miniflare: {
      bindings: {
        ADMIN_API_KEY: "mock-admin-key-for-tests-only-00000001",
        GATEWAY_API_KEY: "mock-gateway-key-for-tests-only-0001",
        TOKEN_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        MOCK_UPSTREAM: "true",
        ALLOW_TEST_HOSTS: "true"
      }
    }
  })],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000
  }
});
