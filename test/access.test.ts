import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccessTokenVerifier, type AccessIdentity } from "../src/access";
import { configureMockAccessJwks, configureMockAccessJwksDelay, mockUpstreamStats, resetMockUpstream } from "../src/codex/mock";
import { configuredOrigin } from "../src/index";
import type { AccessConfig, EncryptedValue, Env } from "../src/types";

const origin = "https://example.com";
const admin = "mock-admin-key-for-tests-only-00000001";
const gateway = "mock-gateway-key-for-tests-only-0001";
const importSecret = "mock-import-secret-for-tests-only-00000001";
const teamDomain = "team.cloudflareaccess.com";
const applicationAud = "aud_test_0123456789";
const bearerHeaders = (key: string) => ({ Authorization: "Bearer " + key, "Content-Type": "application/json" });
const accountStub = () => {
  const testEnv = env as unknown as Env;
  return testEnv.ACCOUNT.get(testEnv.ACCOUNT.idFromName("primary"));
};

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

let firstKey: SigningKey;
let secondKey: SigningKey;

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signingKey(kid: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as JsonWebKey & { kid: string } };
}

async function accessJwt(key: SigningKey, claims: Partial<Record<string, unknown>> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid, ...header }));
  const encodedPayload = base64Url(JSON.stringify({
    iss: "https://" + teamDomain,
    aud: [applicationAud],
    nbf: now - 1,
    exp: now + 3600,
    email: "owner@example.com",
    ...claims
  }));
  const signed = new TextEncoder().encode(encodedHeader + "." + encodedPayload);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, signed));
  return encodedHeader + "." + encodedPayload + "." + base64Url(signature);
}

async function patchAccess(body: Record<string, unknown>, headers: HeadersInit = bearerHeaders(admin)): Promise<Response> {
  return SELF.fetch(origin + "/admin/access", {
    method: "PATCH",
    headers,
    body: JSON.stringify(body)
  });
}

function unsignedIdToken(accountId = "acct_imported"): string {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "import@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "mock" }
  };
  return base64Url(JSON.stringify({ alg: "none", typ: "JWT" })) + "." + base64Url(JSON.stringify(payload)) + ".mock";
}

beforeAll(async () => {
  firstKey = await signingKey("key-one");
  secondKey = await signingKey("key-two");
});

beforeEach(async () => {
  resetMockUpstream();
  (env as unknown as { ACCOUNT_IMPORT_SECRET?: string }).ACCOUNT_IMPORT_SECRET = importSecret;
  await abortAllDurableObjects();
  await runInDurableObject(accountStub(), async (_instance, state) => {
    await state.storage.delete([
      "access-config",
      "admin-sessions",
      "admin-login-failures",
      "credentials",
      "credential-version",
      "login-public",
      "login-private",
      "model-capabilities",
      "generation",
      "reauth-required",
      "usage-cache"
    ]);
  });
});

describe("Cloudflare Access administrator authentication", () => {
  it("accepts only exact HTTPS deployment origins", () => {
    expect(configuredOrigin("https://api.arcinks.com", "PUBLIC_ORIGIN")).toBe("https://api.arcinks.com");
    expect(configuredOrigin("https://oneapi.example.workers.dev/", "WORKER_ORIGIN")).toBe("https://oneapi.example.workers.dev");
    for (const invalid of [
      "http://api.arcinks.com",
      "https://api.arcinks.com:444",
      "https://api.arcinks.com/path",
      "https://api.arcinks.com?next=evil",
      "https://user@api.arcinks.com",
      " https://api.arcinks.com"
    ]) {
      expect(() => configuredOrigin(invalid, "PUBLIC_ORIGIN")).toThrow();
    }
  });

  it("normalizes only fixed cloudflareaccess.com team domains and exposes only the public enabled bit", async () => {
    for (const invalid of [
      "https://evil.example",
      "https://team.cloudflareaccess.com.evil.example",
      "https://team.cloudflareaccess.com:444",
      "https://team.cloudflareaccess.com/certs",
      "https://team.cloudflareaccess.com/?next=evil",
      "https://user@team.cloudflareaccess.com",
      "https://nested.team.cloudflareaccess.com"
    ]) {
      const response = await patchAccess({ enabled: true, teamDomain: invalid, applicationAud });
      expect(response.status, invalid).toBe(400);
    }
    const configured = await patchAccess({
      enabled: true,
      teamDomain: "HTTPS://TEAM.CLOUDFLAREACCESS.COM/",
      applicationAud
    });
    expect(configured.status).toBe(200);
    expect(await configured.json()).toMatchObject({ enabled: true, teamDomain, applicationAud });
    expect(await (await SELF.fetch(origin + "/access/status")).json()).toEqual({ enabled: true });
    expect((await SELF.fetch(origin + "/admin/access")).status).toBe(401);
    expect((await SELF.fetch(origin + "/admin/access", { headers: bearerHeaders(gateway) })).status).toBe(401);
  });

  it("accepts a valid signed Access JWT as administrator and rejects forged or invalid claims", async () => {
    configureMockAccessJwks({ keys: [firstKey.jwk] });
    expect((await patchAccess({ enabled: true, teamDomain, applicationAud })).status).toBe(200);
    const token = await accessJwt(firstKey);
    const headers = { "Cf-Access-Jwt-Assertion": token };
    expect((await SELF.fetch(origin + "/admin/status", { headers })).status).toBe(200);
    const session = await (await SELF.fetch(origin + "/admin/session", { headers })).json() as Record<string, unknown>;
    expect(session).toMatchObject({ authenticated: true, provider: "access", logoutUrl: "/cdn-cgi/access/logout" });
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect((await SELF.fetch(origin + "/v1/models", { headers })).status).toBe(401);
    expect((await SELF.fetch(origin + "/admin/status", {
      headers: { "CF-Access-Authenticated-User-Email": "forged@example.com" }
    })).status).toBe(401);

    const invalidTokens = [
      await accessJwt(firstKey, { aud: ["wrong-audience"] }),
      await accessJwt(firstKey, { iss: "https://attacker.cloudflareaccess.com" }),
      await accessJwt(firstKey, { exp: Math.floor(Date.now() / 1000) }),
      await accessJwt(firstKey, { nbf: Math.floor(Date.now() / 1000) + 60 }),
      await accessJwt(firstKey, {}, { alg: "none" }),
      (await accessJwt(secondKey)).slice(0, -2) + "aa",
      (await accessJwt(firstKey)).split(".").slice(0, 2).join(".") + ".AQ"
    ];
    for (const invalid of invalidTokens) {
      expect((await SELF.fetch(origin + "/admin/status", {
        headers: { "Cf-Access-Jwt-Assertion": invalid }
      })).status).toBe(401);
    }
  });

  it("enforces same-origin mutations, invalidates Access identity on config changes, and makes logout behavior explicit", async () => {
    configureMockAccessJwks({ keys: [firstKey.jwk] });
    await patchAccess({ enabled: true, teamDomain, applicationAud });
    const token = await accessJwt(firstKey);
    const accessHeaders = { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" };
    expect((await patchAccess({ enabled: true, teamDomain, applicationAud }, accessHeaders)).status).toBe(403);
    expect((await patchAccess(
      { enabled: true, teamDomain, applicationAud },
      { ...accessHeaders, Origin: origin }
    )).status).toBe(200);

    const login = await SELF.fetch(origin + "/admin/access/login", {
      headers: { "Cf-Access-Jwt-Assertion": token },
      redirect: "manual"
    });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe(origin + "/");

    const logout = await SELF.fetch(origin + "/admin/session", {
      method: "DELETE",
      headers: { ...accessHeaders, Origin: origin },
      body: "{}"
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("x-oneapi-access-logout")).toBe("/cdn-cgi/access/logout");
    expect((await SELF.fetch(origin + "/admin/status", { headers: { "Cf-Access-Jwt-Assertion": token } })).status).toBe(200);

    await patchAccess({ enabled: true, teamDomain, applicationAud: "replacement_aud" });
    expect((await SELF.fetch(origin + "/admin/status", { headers: { "Cf-Access-Jwt-Assertion": token } })).status).toBe(401);
    await patchAccess({ enabled: false, teamDomain, applicationAud: "replacement_aud" });
    expect((await SELF.fetch(origin + "/admin/status", { headers: { "Cf-Access-Jwt-Assertion": token } })).status).toBe(401);
    expect((await SELF.fetch(origin + "/admin/status", { headers: bearerHeaders(admin) })).status).toBe(200);
  });

  it("rejects a JWT verification that finishes after the Access config changes", async () => {
    configureMockAccessJwks({ keys: [firstKey.jwk] });
    configureMockAccessJwksDelay(75);
    await patchAccess({ enabled: true, teamDomain, applicationAud });
    const token = await accessJwt(firstKey);
    const pending = SELF.fetch(origin + "/admin/status", {
      headers: { "Cf-Access-Jwt-Assertion": token }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await patchAccess({ enabled: false, teamDomain, applicationAud });
    expect((await pending).status).toBe(401);
  });

  it("caches bounded JWKS and refreshes once for key rotation without following arbitrary URLs", async () => {
    const verifier = new AccessTokenVerifier();
    const config: AccessConfig = {
      enabled: true,
      teamDomain,
      applicationAud,
      updatedAt: 1,
      revision: 1
    };
    let current = { keys: [firstKey.jwk] };
    const requests: Request[] = [];
    const fetcher = async (request: Request): Promise<Response> => {
      requests.push(request);
      return Response.json(current);
    };
    const now = Date.now();
    const first = await verifier.verify(await accessJwt(firstKey, {
      nbf: Math.floor(now / 1000) - 1,
      exp: Math.floor(now / 1000) + 3600
    }), config, fetcher, now) satisfies AccessIdentity;
    expect(first.expiresAt).toBeGreaterThan(now);
    await verifier.verify(await accessJwt(firstKey, {
      nbf: Math.floor(now / 1000) - 1,
      exp: Math.floor(now / 1000) + 3600
    }), config, fetcher, now + 1000);
    expect(requests).toHaveLength(1);
    current = { keys: [secondKey.jwk] };
    await verifier.verify(await accessJwt(secondKey, {
      nbf: Math.floor(now / 1000) - 1,
      exp: Math.floor(now / 1000) + 3600
    }), config, fetcher, now + 31_000);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) =>
      request.url === "https://" + teamDomain + "/cdn-cgi/access/certs" &&
      request.method === "GET" && request.redirect === "manual"
    )).toBe(true);

    const oversized = new AccessTokenVerifier();
    await expect(oversized.verify(
      await accessJwt(firstKey),
      config,
      async () => new Response("{}", { headers: { "Content-Length": String(65 * 1024) } })
    )).rejects.toMatchObject({ status: 503, code: "invalid_access_jwks" });
  });
});

describe("one-way OAuth account import", () => {
  const importHeaders = {
    ...bearerHeaders(admin),
    "X-OneAPI-Import-Secret": importSecret
  };
  const body = () => ({
    idToken: unsignedIdToken(),
    accessToken: "mock-import-access-token-00000001",
    refreshToken: "mock-import-refresh-token-0000001"
  });

  it("requires TLS, administrator Bearer, feature secret, strict fields, and a small body", async () => {
    expect((await SELF.fetch("http://127.0.0.1/admin/account/import", {
      method: "POST",
      headers: importHeaders,
      body: JSON.stringify(body())
    })).status).toBe(403);
    expect((await SELF.fetch(origin + "/admin/account/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OneAPI-Import-Secret": importSecret },
      body: JSON.stringify(body())
    })).status).toBe(401);
    expect((await SELF.fetch(origin + "/admin/account/import", {
      method: "POST",
      headers: { ...bearerHeaders(gateway), "X-OneAPI-Import-Secret": importSecret },
      body: JSON.stringify(body())
    })).status).toBe(401);
    expect((await SELF.fetch(origin + "/admin/account/import", {
      method: "POST",
      headers: { ...bearerHeaders(admin), "X-OneAPI-Import-Secret": "wrong-secret-value-that-is-long-enough" },
      body: JSON.stringify(body())
    })).status).toBe(401);
    expect((await SELF.fetch(origin + "/admin/account/import", {
      method: "POST",
      headers: importHeaders,
      body: JSON.stringify({ ...body(), accountId: "attacker-controlled" })
    })).status).toBe(400);
    expect((await SELF.fetch(origin + "/admin/account/import", {
      method: "POST",
      headers: importHeaders,
      body: JSON.stringify({ ...body(), refreshToken: "x".repeat(33 * 1024) })
    })).status).toBe(413);
  });

  it("validates against the fixed model endpoint, encrypts at rest, returns no secret, and never overwrites", async () => {
    const imported = body();
    const response = await SELF.fetch(origin + "/admin/account/import", {
      method: "POST",
      headers: importHeaders,
      body: JSON.stringify(imported)
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(mockUpstreamStats().modelRequests).toBe(1);
    await runInDurableObject(accountStub(), async (_instance, state) => {
      const encrypted = await state.storage.get<EncryptedValue>("credentials");
      expect(encrypted).toMatchObject({ version: 1 });
      expect(JSON.stringify(encrypted)).not.toContain(imported.idToken);
      expect(JSON.stringify(encrypted)).not.toContain(imported.accessToken);
      expect(JSON.stringify(encrypted)).not.toContain(imported.refreshToken);
    });
    const status = await SELF.fetch(origin + "/admin/status", { headers: bearerHeaders(admin) });
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({ connected: true, account: { id: "acct_imported" } });

    const second = await SELF.fetch(origin + "/admin/account/import", {
      method: "POST",
      headers: importHeaders,
      body: JSON.stringify({ ...body(), idToken: unsignedIdToken("acct_other") })
    });
    expect(second.status).toBe(409);
    expect(mockUpstreamStats().modelRequests).toBe(1);
    expect(JSON.stringify(statusBody)).not.toContain(imported.accessToken);
  });
});
