import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetMockUpstream } from "../src/codex/mock";
import type { StoredAdminSession, StoredApiKey } from "../src/types";

const origin = "https://example.com";
const admin = "mock-admin-key-for-tests-only-00000001";
const gateway = "mock-gateway-key-for-tests-only-0001";
const bearerHeaders = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });
const accountStub = () => {
  const testEnv = env as unknown as import("../src/types").Env;
  return testEnv.ACCOUNT.get(testEnv.ACCOUNT.idFromName("primary"));
};

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("oneapi_admin_session=");
  return setCookie!.split(";", 1)[0]!;
}

async function login(password = admin): Promise<{ response: Response; cookie: string | null }> {
  const response = await SELF.fetch(`${origin}/admin/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  return { response, cookie: response.ok ? sessionCookie(response) : null };
}

const sessionHeaders = (cookie: string) => ({ Cookie: cookie, Origin: origin, "Content-Type": "application/json" });

async function connectWithSession(cookie: string): Promise<void> {
  const started = await SELF.fetch(`${origin}/admin/device/start`, {
    method: "POST",
    headers: sessionHeaders(cookie),
    body: "{}"
  });
  expect(started.status).toBe(200);
  const state = await started.json() as { id: string; nextPollAt: number };
  await new Promise((resolve) => setTimeout(resolve, Math.max(30, state.nextPollAt - Date.now() + 2)));
  const polled = await SELF.fetch(`${origin}/admin/device/poll`, {
    method: "POST",
    headers: sessionHeaders(cookie),
    body: JSON.stringify({ login_id: state.id })
  });
  expect(polled.status).toBe(200);
}

async function createApiKey(cookie: string, name = "test client"): Promise<{ id: string; key: string }> {
  const response = await SELF.fetch(`${origin}/admin/api-keys`, {
    method: "POST",
    headers: sessionHeaders(cookie),
    body: JSON.stringify({ name })
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; key: string }>;
}

describe("AUTH-001 administrator session and API keys", () => {
  beforeEach(async () => {
    resetMockUpstream();
    await runInDurableObject(accountStub(), async (_instance, state) => {
      await state.storage.delete(["admin-sessions", "admin-login-failures", "api-keys"]);
    });
    await SELF.fetch(`${origin}/admin/disconnect`, {
      method: "POST",
      headers: bearerHeaders(admin),
      body: "{}"
    });
  });

  it("creates a seven-day HttpOnly session, restores it after DO restart, expires it, and caps session count", async () => {
    const { response, cookie } = await login();
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Path=/admin");
    expect(setCookie).toContain("Max-Age=604800");
    const created = await response.json() as { authenticated: boolean; expiresAt: number };
    expect(created.authenticated).toBe(true);
    expect(created.expiresAt).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);

    const rawSecret = cookie!.split("=", 2)[1]!;
    await runInDurableObject(accountStub(), async (_instance, state) => {
      const stored = await state.storage.get<StoredAdminSession[]>("admin-sessions");
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain(rawSecret);
      expect(stored![0]!.digest).not.toBe(rawSecret);
    });

    await abortAllDurableObjects();
    const restored = await SELF.fetch(`${origin}/admin/session`, { headers: { Cookie: cookie! } });
    expect(await restored.json()).toEqual({ authenticated: true, expiresAt: created.expiresAt, provider: "session", logoutUrl: null });

    await runInDurableObject(accountStub(), async (_instance, state) => {
      const stored = await state.storage.get<StoredAdminSession[]>("admin-sessions");
      await state.storage.put("admin-sessions", stored!.map((session) => ({ ...session, expiresAt: Date.now() - 1 })));
    });
    const expired = await SELF.fetch(`${origin}/admin/session`, { headers: { Cookie: cookie! } });
    expect(await expired.json()).toEqual({ authenticated: false, expiresAt: null, provider: null, logoutUrl: null });
    expect((await SELF.fetch(`${origin}/admin/status`, { headers: { Cookie: cookie! } })).status).toBe(401);

    const cookies: string[] = [];
    for (let index = 0; index < 9; index += 1) cookies.push((await login()).cookie!);
    await runInDurableObject(accountStub(), async (_instance, state) => {
      expect(await state.storage.get<StoredAdminSession[]>("admin-sessions")).toHaveLength(8);
    });
    expect(await (await SELF.fetch(`${origin}/admin/session`, { headers: { Cookie: cookies[0]! } })).json())
      .toEqual({ authenticated: false, expiresAt: null, provider: null, logoutUrl: null });
    expect((await (await SELF.fetch(`${origin}/admin/session`, { headers: { Cookie: cookies[8]! } })).json() as { authenticated: boolean }).authenticated)
      .toBe(true);

    const loopbackHttp = await SELF.fetch("http://127.0.0.1/admin/session", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1", "Content-Type": "application/json" },
      body: JSON.stringify({ password: admin })
    });
    expect(loopbackHttp.status).toBe(200);
    expect(loopbackHttp.headers.get("set-cookie")).not.toMatch(/; Secure(?:;|$)/);
    const insecureRemote = await SELF.fetch("http://example.com/admin/session", {
      method: "POST",
      headers: { Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ password: admin })
    });
    expect(insecureRemote.status).toBe(403);
  });

  it("rate limits failed administrator logins without storing the submitted password", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login(`wrong-${attempt}`)).response.status).toBe(401);
    }
    const limited = await login(admin);
    expect(limited.response.status).toBe(429);
    expect((await limited.response.json() as { error: { code: string } }).error.code).toBe("admin_login_rate_limited");
    await runInDurableObject(accountStub(), async (_instance, state) => {
      const serialized = JSON.stringify(await state.storage.get("admin-login-failures"));
      expect(serialized).not.toContain("wrong-");
      await state.storage.put("admin-login-failures", [Date.now() - 16 * 60 * 1000]);
    });
    expect((await login(admin)).response.status).toBe(200);
  });

  it("enforces exact-origin JSON controls for cookies while preserving no-Origin admin Bearer automation", async () => {
    expect((await SELF.fetch(`${origin}/admin/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: admin })
    })).status).toBe(403);
    const { cookie } = await login();
    expect((await SELF.fetch(`${origin}/admin/status`, {
      headers: { Cookie: cookie!, Origin: "http://localhost:5173" }
    })).status).toBe(403);
    expect((await SELF.fetch(`${origin}/admin/status`, {
      headers: { Cookie: cookie!, Origin: "https://example.com:444" }
    })).status).toBe(403);
    expect((await SELF.fetch(`${origin}/admin/status`, {
      headers: { Cookie: cookie!, Origin: "https://example.com/not-an-origin" }
    })).status).toBe(403);
    expect((await SELF.fetch(`${origin}/admin/status`, {
      headers: { Cookie: cookie!, "Sec-Fetch-Site": "same-site" }
    })).status).toBe(403);
    expect((await SELF.fetch(`${origin}/admin/test/models`, {
      headers: { Cookie: cookie!, "Sec-Fetch-Site": "cross-site" }
    })).status).toBe(403);
    expect((await SELF.fetch(`${origin}/admin/test/models`, {
      headers: { Cookie: cookie!, Origin: "null" }
    })).status).toBe(403);
    expect((await SELF.fetch(`${origin}/admin/disconnect`, {
      method: "POST",
      headers: { Cookie: cookie!, "Content-Type": "application/json" },
      body: "{}"
    })).status).toBe(403);
    expect((await SELF.fetch(`${origin}/admin/disconnect`, {
      method: "POST",
      headers: {
        Cookie: cookie!,
        "Content-Type": "application/json",
        "CF-Access-Authenticated-User-Email": "forged@example.com"
      },
      body: "{}"
    })).status).toBe(403);
    expect((await SELF.fetch(`${origin}/admin/disconnect`, {
      method: "POST",
      headers: { Cookie: cookie!, Origin: origin, "Content-Type": "text/plain" },
      body: "{}"
    })).status).toBe(415);
    expect((await SELF.fetch(`${origin}/admin/status`, { headers: { Cookie: cookie! } })).status).toBe(200);
    expect((await SELF.fetch(`${origin}/admin/disconnect`, {
      method: "POST",
      headers: bearerHeaders(admin),
      body: "{}"
    })).status).toBe(204);
  });

  it("lets a session operate every admin area and built-in model test without an API key", async () => {
    expect((await SELF.fetch(`${origin}/admin/status`)).status).toBe(401);
    expect((await SELF.fetch(`${origin}/admin/test/models`)).status).toBe(401);
    const { cookie } = await login();
    await connectWithSession(cookie!);
    expect((await SELF.fetch(`${origin}/admin/status`, { headers: { Cookie: cookie! } })).status).toBe(200);
    const models = await SELF.fetch(`${origin}/admin/test/models`, { headers: { Cookie: cookie! } });
    expect(models.status).toBe(200);
    const ordinary = await SELF.fetch(`${origin}/admin/test/responses`, {
      method: "POST",
      headers: sessionHeaders(cookie!),
      body: JSON.stringify({ model: "gpt-mock", input: "hello" })
    });
    expect((await ordinary.json() as { output_text: string }).output_text).toBe("你好，mock");
    const streamed = await SELF.fetch(`${origin}/admin/test/responses`, {
      method: "POST",
      headers: sessionHeaders(cookie!),
      body: JSON.stringify({ model: "gpt-mock", input: "hello", stream: true })
    });
    expect(await streamed.text()).toContain("response.completed");
    expect((await SELF.fetch(`${origin}/v1/models`, { headers: { Cookie: cookie! } })).status).toBe(401);
  });

  it("creates a key once, persists only its digest and metadata, supports SDK routes, then revokes it", async () => {
    const { cookie } = await login();
    await connectWithSession(cookie!);
    const created = await createApiKey(cookie!, "desktop SDK");
    expect(created.key).toMatch(/^oneapi_sk_[A-Za-z0-9_-]{43}$/);

    const listed = await SELF.fetch(`${origin}/admin/api-keys`, { headers: { Cookie: cookie! } });
    const listBody = await listed.json() as { data: Array<Record<string, unknown>> };
    const createdEntry = listBody.data.find((entry) => entry.id === created.id);
    expect(listBody.data.find((entry) => entry.id === "legacy")).toBeTruthy();
    expect(createdEntry).toMatchObject({ id: created.id, name: "desktop SDK" });
    expect(createdEntry).not.toHaveProperty("key");
    expect(JSON.stringify(listBody)).not.toContain(created.key);
    await runInDurableObject(accountStub(), async (_instance, state) => {
      const stored = await state.storage.get<StoredApiKey[]>("api-keys");
      expect(stored).toHaveLength(1);
      expect(stored![0]).not.toHaveProperty("key");
      expect(stored![0]!.digest).toBeTruthy();
      expect(JSON.stringify(stored)).not.toContain(created.key);
    });

    await abortAllDurableObjects();
    const keyHeaders = bearerHeaders(created.key);
    const ordinary = await SELF.fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: keyHeaders,
      body: JSON.stringify({ model: "gpt-mock", input: "hello" })
    });
    expect((await ordinary.json() as { output_text: string }).output_text).toBe("你好，mock");
    const streamed = await SELF.fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: keyHeaders,
      body: JSON.stringify({ model: "gpt-mock", input: "hello", stream: true })
    });
    expect(await streamed.text()).toContain("response.completed");

    expect((await SELF.fetch(`${origin}/admin/status`, { headers: bearerHeaders(created.key) })).status).toBe(401);
    expect((await login(created.key)).response.status).toBe(401);
    expect((await SELF.fetch(`${origin}/v1/models`, { headers: bearerHeaders(admin) })).status).toBe(401);
    expect((await SELF.fetch(`${origin}/v1/models`, { headers: bearerHeaders(gateway) })).status).toBe(200);

    const revoked = await SELF.fetch(`${origin}/admin/api-keys/${created.id}`, {
      method: "DELETE",
      headers: sessionHeaders(cookie!),
      body: "{}"
    });
    expect(revoked.status).toBe(204);
    expect((await SELF.fetch(`${origin}/v1/models`, { headers: keyHeaders })).status).toBe(401);

    await runInDurableObject(accountStub(), async (_instance, state) => {
      const keys: StoredApiKey[] = Array.from({ length: 32 }, (_, index) => ({
        id: crypto.randomUUID(),
        name: `bounded-${index}`,
        digest: `digest-${index}`,
        masked: `masked-${index}`,
        createdAt: index
      }));
      await state.storage.put("api-keys", keys);
    });
    const limited = await SELF.fetch(`${origin}/admin/api-keys`, {
      method: "POST",
      headers: sessionHeaders(cookie!),
      body: JSON.stringify({ name: "one too many" })
    });
    expect(limited.status).toBe(409);
    expect((await limited.json() as { error: { code: string } }).error.code).toBe("api_key_limit_reached");
  });

  it("logs out only the current admin session and leaves Codex plus API keys usable", async () => {
    const { cookie } = await login();
    const otherSession = (await login()).cookie!;
    await connectWithSession(cookie!);
    const created = await createApiKey(cookie!, "survives logout");
    const nonEmpty = await SELF.fetch(`${origin}/admin/session`, {
      method: "DELETE",
      headers: sessionHeaders(cookie!),
      body: JSON.stringify({ unexpected: true })
    });
    expect(nonEmpty.status).toBe(400);
    expect((await (await SELF.fetch(`${origin}/admin/session`, { headers: { Cookie: cookie! } })).json() as { authenticated: boolean }).authenticated)
      .toBe(true);
    const malformed = await SELF.fetch(`${origin}/admin/session`, {
      method: "DELETE",
      headers: sessionHeaders(cookie!),
      body: "{"
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as { error: { code: string } }).error.code).toBe("invalid_json");
    expect((await (await SELF.fetch(`${origin}/admin/session`, { headers: { Cookie: cookie! } })).json() as { authenticated: boolean }).authenticated)
      .toBe(true);
    const loggedOut = await SELF.fetch(`${origin}/admin/session`, {
      method: "DELETE",
      headers: sessionHeaders(cookie!),
      body: "{}"
    });
    expect(loggedOut.status).toBe(204);
    expect(loggedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await (await SELF.fetch(`${origin}/admin/session`, { headers: { Cookie: cookie! } })).json())
      .toEqual({ authenticated: false, expiresAt: null, provider: null, logoutUrl: null });
    expect((await (await SELF.fetch(`${origin}/admin/session`, { headers: { Cookie: otherSession } })).json() as { authenticated: boolean }).authenticated)
      .toBe(true);
    expect((await SELF.fetch(`${origin}/admin/status`, { headers: bearerHeaders(admin) })).status).toBe(200);
    expect((await SELF.fetch(`${origin}/v1/models`, { headers: bearerHeaders(created.key) })).status).toBe(200);
  });

  it("serves only the fixed login and admin shells while keeping management data protected", async () => {
    for (const method of ["GET", "HEAD"]) {
      const redirect = await SELF.fetch(`${origin}/?next=${encodeURIComponent("https://attacker.example")}`, {
        method,
        redirect: "manual"
      });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe(`${origin}/admin/login`);
      if (method === "HEAD") expect(await redirect.text()).toBe("");
    }

    const navigation = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
    for (const path of ["/admin/login", "/admin/"]) {
      const shell = await SELF.fetch(origin + path, { headers: navigation });
      expect(shell.status).toBe(200);
      const html = await shell.text();
      expect(html).toContain('id="login-form"');
      expect(html).toContain('id="api-key-form"');
      expect(html).toContain('href="/styles.css"');
      expect(html).toContain('src="/app.js"');
      expect(html).not.toContain('id="access-login"');
    }
    expect((await SELF.fetch(`${origin}/admin/login?next=/admin/`, { headers: navigation })).status).toBe(403);
    expect((await SELF.fetch(`${origin}/admin/status`, { headers: navigation })).status).toBe(403);
    expect((await SELF.fetch(`${origin}/admin/status`)).status).toBe(401);

    const html = await (await SELF.fetch(`${origin}/admin/login`)).text();
    const script = await (await SELF.fetch(`${origin}/app.js`)).text();
    expect(html).toContain('id="login-form"');
    expect(html).toContain('id="api-key-form"');
    expect(html).toContain('id="created-key-panel"');
    expect(html).not.toContain('id="admin-key"');
    expect(html).not.toContain('id="gateway-key"');
    expect(script).toContain('credentials: "same-origin"');
    expect(script).toContain('"/admin/test/responses"');
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("GATEWAY_API_KEY");
    expect(script).not.toContain("ADMIN_API_KEY");
  });
});
