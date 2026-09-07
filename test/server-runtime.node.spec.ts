import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { startHttpServer } from "../server/http.mjs";
import { createDirectOutbound } from "../src/runtime/node/outbound";
import { createServerRuntime } from "../src/runtime/node/runtime";
import { SqliteAccountStorage } from "../src/runtime/node/sqlite-storage";
import { encryptJson } from "../src/security";
import { configureMockAccessJwks, mockUpstreamFetch, mockUpstreamStats, resetMockUpstream } from "../src/codex/mock";

const encryptionKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const within = <T>(promise: Promise<T>, label: string): Promise<T> => Promise.race([
  promise,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(label + " timed out")), 1_000))
]);

const auth = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });

const config = {
  ADMIN_API_KEY: "node-admin-key-for-tests-only-00000001",
  GATEWAY_API_KEY: "node-gateway-key-for-tests-only-0001",
  TOKEN_ENCRYPTION_KEY: encryptionKey
};

async function tempPath(name: string): Promise<{ root: string; database: string; publicDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "oneapi-node-test-"));
  const publicDir = join(root, "public");
  await mkdir(publicDir);
  await Promise.all([
    writeFile(join(publicDir, "index.html"), "<!doctype html><title>OneAPI</title>"),
    writeFile(join(publicDir, "app.js"), "console.log(\"ok\")"),
    writeFile(join(publicDir, "styles.css"), "body{}")
  ]);
  return { root, database: join(root, name), publicDir };
}

describe("SqliteAccountStorage", () => {
  it("serializes concurrent KV transactions and rolls failed transactions back", async () => {
    const { database } = await tempPath("transactions.sqlite");
    const storage = new SqliteAccountStorage(database);
    try {
      await storage.put("counter", 0);
      await Promise.all(Array.from({ length: 24 }, () => storage.transaction(async (transaction) => {
        const current = (await transaction.get<number>("counter")) ?? 0;
        await Promise.resolve();
        await transaction.put("counter", current + 1);
      })));
      expect(await storage.get("counter")).toBe(24);
      await expect(storage.transaction(async (transaction) => {
        await transaction.put("counter", 999);
        await transaction.put("partial", true);
        throw new Error("rollback");
      })).rejects.toThrow("rollback");
      expect(await storage.get("counter")).toBe(24);
      expect(await storage.get("partial")).toBeUndefined();
    } finally {
      await storage.close();
    }
  });

  it("migrates legacy request-log tables idempotently and reads old rows with empty ignored parameters", async () => {
    const { database, publicDir } = await tempPath("legacy-logs.sqlite");
    const legacyDatabase = new DatabaseSync(database);
    legacyDatabase.exec(`CREATE TABLE request_logs (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, key_id TEXT NOT NULL, key_name TEXT NOT NULL,
      protocol TEXT NOT NULL, model TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
      duration_ms INTEGER, http_status INTEGER, outcome TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
      total_tokens INTEGER, body_captured INTEGER NOT NULL, request_truncated INTEGER NOT NULL,
      response_truncated INTEGER NOT NULL, request_body TEXT, response_body TEXT, body_expires_at INTEGER
    )`);
    legacyDatabase.prepare(`INSERT INTO request_logs (
      id, request_id, key_id, key_name, protocol, model, started_at, completed_at, duration_ms,
      http_status, outcome, input_tokens, output_tokens, total_tokens, body_captured,
      request_truncated, response_truncated, request_body, response_body, body_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "00000000-0000-4000-8000-000000000010", "legacy-request", "legacy", "Legacy",
      "responses", "gpt-mock", Date.now(), Date.now(), 1, 200, "completed", 1, 1, 2, 0, 0, 0, null, null, null
    );
    legacyDatabase.close();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const runtime = await createServerRuntime({ databasePath: database, publicDir, config, logger: () => undefined });
      await runtime.ready;
      try {
        const response = await runtime.fetch(new Request("http://127.0.0.1/admin/logs", {
          headers: { Authorization: `Bearer ${config.ADMIN_API_KEY}` }
        }), { remoteAddress: "127.0.0.1" });
        expect(response.status).toBe(200);
        expect((await response.json() as any).data[0]).toMatchObject({
          requestId: "legacy-request", ignoredParameters: []
        });
      } finally {
        await runtime.dispose();
      }
    }
  });
  it("locks one database per process, persists after close, and imports only into an empty target", async () => {
    const { database } = await tempPath("persistence.sqlite");
    const first = new SqliteAccountStorage(database);
    await first.put("generation", 7);
    expect(() => new SqliteAccountStorage(database)).toThrow("Another OneAPI process");
    await first.close();
    const reopened = new SqliteAccountStorage(database);
    try {
      expect(await reopened.get("generation")).toBe(7);
      await expect(reopened.importEntries({ "access-config": { enabled: false } }, [])).rejects.toThrow("not empty");
    } finally {
      await reopened.close();
    }

    const freshPath = database.replace("persistence", "migration");
    const target = new SqliteAccountStorage(freshPath);
    try {
      const logs = function* () {
        yield {
          id: "00000000-0000-4000-8000-000000000001", request_id: "request", key_id: "legacy", key_name: "Legacy",
          protocol: "responses", model: "gpt-5.5", started_at: 1, completed_at: 2, duration_ms: 1, http_status: 200,
          outcome: "completed", input_tokens: 1, output_tokens: 1, total_tokens: 2, body_captured: 0,
          request_truncated: 0, response_truncated: 0, request_body: null, response_body: null, body_expires_at: null
        };
      };
      await target.importEntries({ generation: 3, "api-keys": [] }, logs());
      expect(await target.get("generation")).toBe(3);
      expect(target.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM request_logs").toArray()[0]?.count).toBe(1);
      await expect(target.importEntries({}, [])).rejects.toThrow("not empty");
    } finally {
      await target.close();
    }
  });
});

describe("Node server runtime", () => {
  it("serves assets, enforces peer-aware loopback Host, persists sessions, and disables diagnostics", async () => {
    const { database, publicDir } = await tempPath("runtime.sqlite");
    let runtime = await createServerRuntime({ databasePath: database, publicDir, config, logger: () => undefined });
    await runtime.ready;
    const denied = await runtime.fetch(new Request("http://127.0.0.1/health"), { remoteAddress: "203.0.113.7" });
    expect(denied.status).toBe(403);
    const asset = await runtime.fetch(new Request("http://127.0.0.1/admin/login"), { remoteAddress: "127.0.0.1" });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("OneAPI");
    const login = await runtime.fetch(new Request("http://127.0.0.1/admin/session", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1", "Content-Type": "application/json" },
      body: JSON.stringify({ password: config.ADMIN_API_KEY })
    }), { remoteAddress: "127.0.0.1" });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
    const disabled = await runtime.fetch(new Request("http://127.0.0.1/admin/diagnostics/egress", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.ADMIN_API_KEY}`, Origin: "http://127.0.0.1", "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "ping" })
    }), { remoteAddress: "127.0.0.1" });
    expect(disabled.status).toBe(503);
    await runtime.dispose();

    runtime = await createServerRuntime({ databasePath: database, publicDir, config, logger: () => undefined });
    await runtime.ready;
    try {
      const session = await runtime.fetch(new Request("http://127.0.0.1/admin/session", { headers: { Cookie: cookie } }), { remoteAddress: "::1" });
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({ authenticated: true, provider: "session" });
    } finally {
      await runtime.dispose();
    }
  });

  it("propagates response cancellation to the real outbound request and releases its lease", async () => {
    const { database, publicDir } = await tempPath("cancel.sqlite");
    const storage = new SqliteAccountStorage(database);
    const credentials = {
      idToken: "synthetic", accessToken: "synthetic-access", refreshToken: "synthetic-refresh", accountId: "synthetic-account",
      expiresAt: Date.now() + 60 * 60 * 1000, lastRefreshAt: Date.now(), version: 1
    };
    await storage.importEntries({
      credentials: await encryptJson(credentials, encryptionKey, "oneapi:credentials:v1"),
      "credential-version": 1, generation: 1
    }, []);
    await storage.close();
    const signals: AbortSignal[] = [];
    const fetchImpl = async (request: Request): Promise<Response> => {
      signals.push(request.signal);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("event: response.created\\ndata: {}\\n\\n")); },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const runtime = await createServerRuntime({ databasePath: database, publicDir, config, fetchImpl, logger: () => undefined });
    await runtime.ready;
    try {
      const invoke = () => runtime.fetch(new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.GATEWAY_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true })
      }), { remoteAddress: "127.0.0.1" });
      const first = await within(invoke(), "first fetch");
      expect(first.status).toBe(200);
      await within(first.body!.cancel("client disconnected"), "first cancel");
      expect(signals[0]?.aborted).toBe(true);
      const second = await within(invoke(), "second fetch");
      expect(second.status).toBe(200);
      await within(second.body!.cancel("done"), "second cancel");
      expect(signals[1]?.aborted).toBe(true);
    } finally {
      await within(runtime.dispose(), "cancel runtime dispose");
    }
  });
});

  it("runs overdue request-log retention through the runtime alarm and rearms safely", async () => {
    const { database, publicDir } = await tempPath("alarm.sqlite");
    const storage = new SqliteAccountStorage(database);
    await storage.importEntries({}, [{
      id: "00000000-0000-4000-8000-000000000002", request_id: "old", key_id: "legacy", key_name: "Legacy",
      protocol: "responses", model: "gpt-5.5", started_at: 1, completed_at: 2, duration_ms: 1, http_status: 200,
      outcome: "completed", input_tokens: 1, output_tokens: 1, total_tokens: 2, body_captured: 0,
      request_truncated: 0, response_truncated: 0, request_body: null, response_body: null, body_expires_at: null
    }]);
    await storage.close();
    const runtime = await createServerRuntime({ databasePath: database, publicDir, config, logger: () => undefined });
    await runtime.ready;
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    await runtime.dispose();
    const inspected = new SqliteAccountStorage(database);
    try {
      expect(inspected.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM request_logs").toArray()[0]?.count).toBe(0);
    } finally {
      await inspected.close();
    }
  });
  it("runs OAuth, model/key policy, usage, reasoning, both protocols, logs and restart through native Node", async () => {
    resetMockUpstream();
    const { database, publicDir } = await tempPath("features.sqlite");
    const fastMock = async (request: Request): Promise<Response> => {
      if (new URL(request.url).pathname === "/api/accounts/deviceauth/usercode") {
        return Response.json({ device_auth_id: "mock-device-auth-id", user_code: "MOCK-CODE", interval: "1" });
      }
      return mockUpstreamFetch(request);
    };
    let runtime = await createServerRuntime({ databasePath: database, publicDir, config, fetchImpl: fastMock, logger: () => undefined });
    await runtime.ready;
    const request = (path: string, init: RequestInit = {}) => runtime.fetch(new Request("http://127.0.0.1" + path, init), { remoteAddress: "127.0.0.1" });
    const started = await request("/admin/device/start", { method: "POST", headers: auth(config.ADMIN_API_KEY), body: "{}" });
    expect(started.status).toBe(200);
    const login = await started.json() as { id: string; nextPollAt: number };
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, login.nextPollAt - Date.now() + 5)));
    const polled = await request("/admin/device/poll", {
      method: "POST", headers: auth(config.ADMIN_API_KEY), body: JSON.stringify({ login_id: login.id })
    });
    expect(polled.status).toBe(200);
    expect(await polled.json()).toMatchObject({ status: "connected" });

    const createdResponse = await request("/admin/api-keys", {
      method: "POST", headers: auth(config.ADMIN_API_KEY),
      body: JSON.stringify({ name: "node restricted", modelAccess: { mode: "allowlist", models: ["gpt-mock"] } })
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string; key: string };
    const models = await request("/v1/models", { headers: auth(created.key) });
    expect(models.status).toBe(200);
    expect((await models.json() as { data: Array<{ id: string }> }).data.map((entry) => entry.id)).toEqual(["gpt-mock"]);
    const denied = await request("/v1/responses", {
      method: "POST", headers: auth(created.key), body: JSON.stringify({ model: "gpt-other", input: "denied" })
    });
    expect(denied.status).toBe(403);

    const response = await request("/v1/responses", {
      method: "POST", headers: auth(created.key),
      body: JSON.stringify({ model: "gpt-mock", input: "hello", reasoning: { effort: "high" } })
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { output_text: string }).output_text).toBe("你好，mock");
    expect(mockUpstreamStats().lastReasoningEffort).toBe("high");
    const chat = await request("/v1/chat/completions", {
      method: "POST", headers: auth(created.key),
      body: JSON.stringify({ model: "gpt-mock", messages: [{ role: "user", content: "hello" }], stream: true, stream_options: { include_usage: true } })
    });
    expect(chat.status).toBe(200);
    const chatText = await chat.text();
    expect(chatText).toContain("chat.completion.chunk");
    expect(chatText).toContain("[DONE]");
    expect(chatText).toContain("prompt_tokens");
    const usage = await request("/admin/usage", { headers: auth(config.ADMIN_API_KEY) });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({ available: true, windows: { fiveHour: { usedPercent: 40 }, sevenDay: { usedPercent: 25 } } });
    const logs = await request(`/admin/logs?keyId=${encodeURIComponent(created.id)}`, { headers: auth(config.ADMIN_API_KEY) });
    const beforeRestart = await logs.json() as { data: Array<{ model: string; outcome: string }> };
    expect(beforeRestart.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "gpt-other", outcome: "error" }),
      expect.objectContaining({ model: "gpt-mock", outcome: "completed" })
    ]));
    await runtime.dispose();

    runtime = await createServerRuntime({ databasePath: database, publicDir, config, fetchImpl: fastMock, logger: () => undefined });
    await runtime.ready;
    try {
      const afterRestart = await runtime.fetch(new Request(`http://127.0.0.1/admin/logs?keyId=${encodeURIComponent(created.id)}`, { headers: auth(config.ADMIN_API_KEY) }), { remoteAddress: "127.0.0.1" });
      expect(afterRestart.status).toBe(200);
      expect((await afterRestart.json() as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(beforeRestart.data.length);
      const status = await runtime.fetch(new Request("http://127.0.0.1/admin/status", { headers: auth(config.ADMIN_API_KEY) }), { remoteAddress: "127.0.0.1" });
      expect(await status.json()).toMatchObject({ connected: true });
    } finally {
      await runtime.dispose();
    }
  });

  it("serves models, Responses, and Chat SSE usage through native HTTP and the OpenAI SDK", async () => {
    resetMockUpstream();
    const { database, publicDir } = await tempPath("http-sdk.sqlite");
    const storage = new SqliteAccountStorage(database);
    const credentials = {
      idToken: "synthetic", accessToken: "synthetic-access", refreshToken: "synthetic-refresh", accountId: "synthetic-account",
      expiresAt: Date.now() + 60 * 60 * 1000, lastRefreshAt: Date.now(), version: 1
    };
    await storage.importEntries({
      credentials: await encryptJson(credentials, encryptionKey, "oneapi:credentials:v1"),
      "credential-version": 1, generation: 1
    }, []);
    await storage.close();

    const runtime = await createServerRuntime({
      databasePath: database, publicDir, config, fetchImpl: mockUpstreamFetch, logger: () => undefined
    });
    await runtime.ready;
    const server = await startHttpServer({ runtime, host: "127.0.0.1", port: 0 });
    const client = new OpenAI({ apiKey: config.GATEWAY_API_KEY, baseURL: new URL("v1", server.url).href, maxRetries: 0 });
    try {
      const models = await client.models.list();
      expect(models.data.map((model) => model.id)).toContain("gpt-mock");

      const response = await client.responses.create({ model: "gpt-mock", input: "native HTTP SDK" });
      expect(response.output_text).toBe("你好，mock");
      expect(response.usage).toMatchObject({ input_tokens: 4, output_tokens: 3, total_tokens: 7 });

      const stream = await client.chat.completions.create({
        model: "gpt-mock",
        messages: [{ role: "user", content: "native HTTP SDK stream" }],
        stream: true,
        stream_options: { include_usage: true }
      });
      let text = "";
      let usage;
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta.content ?? "";
        usage = chunk.usage ?? usage;
      }
      expect(text).toBe("你好，mock");
      expect(usage).toMatchObject({ prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
    } finally {
      await server.close();
      await runtime.dispose();
    }
  });
  it("accepts a valid synthetic Cloudflare Access JWT through the Node JWKS path", async () => {
    resetMockUpstream();
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    ) as CryptoKeyPair;
    const kid = "node-access-key";
    configureMockAccessJwks({ keys: [{ ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" }] });
    const base64Url = (value: string | Uint8Array): string => {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      return Buffer.from(bytes).toString("base64url");
    };
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const payload = base64Url(JSON.stringify({
      iss: "https://node-test.cloudflareaccess.com", aud: ["node_aud"], nbf: now - 1, exp: now + 3600
    }));
    const signed = new TextEncoder().encode(header + "." + payload);
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, signed));
    const jwt = header + "." + payload + "." + base64Url(signature);
    const { database, publicDir } = await tempPath("access.sqlite");
    const runtime = await createServerRuntime({ databasePath: database, publicDir, config, fetchImpl: mockUpstreamFetch, logger: () => undefined });
    await runtime.ready;
    const server = await startHttpServer({ runtime, host: "127.0.0.1", port: 0 });
    try {
      const patch = await runtime.fetch(new Request("http://127.0.0.1/admin/access", {
        method: "PATCH", headers: auth(config.ADMIN_API_KEY),
        body: JSON.stringify({ enabled: true, teamDomain: "node-test.cloudflareaccess.com", applicationAud: "node_aud" })
      }), { remoteAddress: "127.0.0.1" });
      expect(patch.status).toBe(200);
      const session = await runtime.fetch(new Request("http://127.0.0.1/admin/session", {
        headers: { "Cf-Access-Jwt-Assertion": jwt }
      }), { remoteAddress: "127.0.0.1" });
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({ authenticated: true, provider: "access" });
      const callback = await new Promise<{ status: number | undefined; location: string | undefined; setCookie: string[] | undefined }>((resolve, reject) => {
        const request = httpRequest(new URL("admin/access/login", server.url), {
          headers: {
            "Cf-Access-Jwt-Assertion": jwt,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document"
          }
        }, (response) => {
          response.resume();
          response.once("end", () => resolve({
            status: response.statusCode,
            location: response.headers.location,
            setCookie: response.headers["set-cookie"]
          }));
        });
        request.once("error", reject);
        request.end();
      });
      expect(callback).toEqual({ status: 303, location: server.url.href, setCookie: undefined });
    } finally {
      await server.close();
      await runtime.dispose();
      configureMockAccessJwks(null);
    }
  });
describe("direct Node outbound", () => {
  it("allows only fixed targets, preserves AbortSignal, rejects redirects, and strips decoded wire headers", async () => {
    const controller = new AbortController();
    let observed: Request | undefined;
    const outbound = createDirectOutbound(async (request) => {
      observed = request;
      return new Response("decoded", { headers: { "Content-Encoding": "gzip", "Content-Length": "7" } });
    });
    const response = await outbound(new Request("https://chatgpt.com/backend-api/codex/models?client_version=0.153.4", { signal: controller.signal }));
    controller.abort(new Error("test abort"));
    expect(observed?.signal.aborted).toBe(true);
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    await expect(outbound(new Request("https://example.com/"))).rejects.toThrow("unauthorized target");
    const redirects = createDirectOutbound(async () => new Response(null, { status: 302, headers: { Location: "https://example.com/" } }));
    await expect(redirects(new Request("https://chatgpt.com/backend-api/wham/usage"))).rejects.toThrow("redirect");
  });
});