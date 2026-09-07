import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AccountService } from "../../account-core";
import { configuredOrigin, handleGatewayRequest } from "../../gateway";
import type { GatewayRequestContext } from "../contracts";
import { createDirectOutbound, type NodeFetch } from "./outbound";
import { SqliteAccountStorage } from "./sqlite-storage";
import { createStaticHandler } from "./static";

const MAX_TIMER_MS = 2_147_483_647;

export interface ServerRuntimeConfig {
  ADMIN_API_KEY: string;
  GATEWAY_API_KEY: string;
  TOKEN_ENCRYPTION_KEY: string;
  PUBLIC_ORIGIN?: string;
}

export interface ServerRuntimeOptions {
  databasePath: string;
  publicDir: string;
  config: ServerRuntimeConfig;
  fetchImpl?: NodeFetch;
  logger?: (entry: Record<string, unknown>) => void;
}

export interface ServerRuntime {
  readonly ready: Promise<void>;
  fetch(request: Request, context?: GatewayRequestContext): Promise<Response>;
  dispose(): Promise<void>;
}

function validateConfig(config: ServerRuntimeConfig): void {
  const allowed = new Set(["ADMIN_API_KEY", "GATEWAY_API_KEY", "TOKEN_ENCRYPTION_KEY", "PUBLIC_ORIGIN"]);
  if (Object.keys(config).some((key) => !allowed.has(key))) throw new Error("Unsupported server runtime configuration");
  for (const key of ["ADMIN_API_KEY", "GATEWAY_API_KEY"] as const) {
    const value = config[key];
    if (typeof value !== "string" || value.length < 32 || value.length > 512 || /\s/.test(value)) {
      throw new Error(key + " must contain 32 to 512 non-whitespace characters");
    }
  }
  if (
    typeof config.TOKEN_ENCRYPTION_KEY !== "string" ||
    Buffer.from(config.TOKEN_ENCRYPTION_KEY, "base64").byteLength !== 32 ||
    Buffer.from(config.TOKEN_ENCRYPTION_KEY, "base64").toString("base64") !== config.TOKEN_ENCRYPTION_KEY
  ) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 random bytes encoded as canonical base64");
  }
  if (config.PUBLIC_ORIGIN !== undefined && configuredOrigin(config.PUBLIC_ORIGIN, "PUBLIC_ORIGIN") === null) {
    throw new Error("PUBLIC_ORIGIN must be an exact HTTPS origin");
  }
}

export async function createServerRuntime(options: ServerRuntimeOptions): Promise<ServerRuntime> {
  validateConfig(options.config);
  await mkdir(dirname(options.databasePath), { recursive: true });
  const storage = new SqliteAccountStorage(options.databasePath);
  const outbound = createDirectOutbound(options.fetchImpl);
  const account = new AccountService(storage, {
    ADMIN_API_KEY: options.config.ADMIN_API_KEY,
    GATEWAY_API_KEY: options.config.GATEWAY_API_KEY,
    TOKEN_ENCRYPTION_KEY: options.config.TOKEN_ENCRYPTION_KEY
  }, { outboundFetch: outbound });
  const staticHandlerPromise = createStaticHandler(options.publicDir);
  let staticHandler: (request: Request) => Promise<Response>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alarmRun: Promise<void> | undefined;
  let disposed = false;
  const logger = options.logger ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)));

  const armAlarm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (disposed) return;
    const scheduled = storage.scheduledAlarm();
    if (scheduled === null) return;
    const delay = Math.max(1, Math.min(MAX_TIMER_MS, scheduled - Date.now()));
    timer = setTimeout(() => {
      timer = undefined;
      storage.takeAlarm();
      const running = account.alarm()
        .catch(() => { logger({ event: "request_log_alarm_failed", stage: "runtime" }); })
        .finally(() => {
          if (alarmRun === running) alarmRun = undefined;
          armAlarm();
        });
      alarmRun = running;
    }, delay);
    timer.unref();
  };

  const ready = Promise.all([account.ready, staticHandlerPromise]).then(([, handler]) => {
    staticHandler = handler;
    storage.onAlarmChanged(armAlarm);
    armAlarm();
  });

  let disposePromise: Promise<void> | undefined;
  return {
    ready,
    async fetch(request: Request, context: GatewayRequestContext = {}): Promise<Response> {
      await ready;
      if (disposed) return Response.json({ error: { code: "runtime_disposed", type: "server_error", message: "Runtime is disposed" } }, { status: 503 });
      return handleGatewayRequest(request, options.config, {
        accountFetch: (forwarded) => account.fetch(forwarded),
        staticFetch: (forwarded) => staticHandler(forwarded),
        cancelLease: async (leaseId) => {
          await account.fetch(new Request(`https://oneapi.internal/__internal/cancel?lease_id=${encodeURIComponent(leaseId)}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${options.config.TOKEN_ENCRYPTION_KEY}` }
          }));
        },
        log: logger
      }, context);
    },
    dispose(): Promise<void> {
      disposePromise ??= (async () => {
        disposed = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        storage.onAlarmChanged(null);
        await ready.catch(() => undefined);
        await alarmRun;
        await account.dispose();
        await storage.close();
      })();
      return disposePromise;
    }
  };
}