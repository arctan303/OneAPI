import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AccountStorage, SqlCursor, SqlStorage, StorageDeleteResult, StorageTransaction } from "../contracts";

const MIGRATABLE_KEYS = new Set([
  "credentials", "credential-version", "generation", "reauth-required",
  "api-keys", "legacy-key-policy", "access-config", "log-settings"
]);
const REQUEST_LOG_COLUMNS = [
  "id", "request_id", "key_id", "key_name", "protocol", "model", "started_at", "completed_at",
  "duration_ms", "http_status", "outcome", "input_tokens", "output_tokens", "total_tokens",
  "body_captured", "request_truncated", "response_truncated", "request_body", "response_body", "body_expires_at", "ignored_parameters"
] as const;
const REQUEST_LOG_SCHEMA = `CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, key_id TEXT NOT NULL, key_name TEXT NOT NULL,
  protocol TEXT NOT NULL, model TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
  duration_ms INTEGER, http_status INTEGER, outcome TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
  total_tokens INTEGER, body_captured INTEGER NOT NULL, request_truncated INTEGER NOT NULL,
  response_truncated INTEGER NOT NULL, request_body TEXT, response_body TEXT, body_expires_at INTEGER,
  ignored_parameters TEXT NOT NULL DEFAULT '[]'
)`;
const DELETE = Symbol("delete");
type OverlayValue = unknown | typeof DELETE;

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class Rows<T extends Record<string, unknown>> implements SqlCursor<T> {
  constructor(private readonly rows: T[]) {}
  toArray(): T[] { return this.rows.slice(); }
  [Symbol.iterator](): Iterator<T> { return this.rows[Symbol.iterator](); }
}

function sqlBindings(values: unknown[]): SQLInputValue[] {
  return values.map((value) => {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
    if (value instanceof Uint8Array) return value;
    throw new TypeError("Unsupported SQLite binding value");
  });
}

function encode(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Persistent values must be JSON serializable");
  return encoded;
}

function decode<T>(value: string): T { return JSON.parse(value) as T; }

export class SqliteAccountStorage implements AccountStorage {
  readonly sql: SqlStorage;
  private readonly database: DatabaseSync;
  private readonly lockDatabase: DatabaseSync;
  private readonly mutex = new AsyncMutex();
  private closed = false;
  private alarmAt: number | null = null;
  private alarmChanged: (() => void) | null = null;

  constructor(databasePath: string) {
    const canonicalPath = resolve(databasePath);
    this.lockDatabase = new DatabaseSync(canonicalPath + ".lock.sqlite");
    this.lockDatabase.exec("PRAGMA busy_timeout = 0");
    try {
      this.lockDatabase.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      this.lockDatabase.close();
      throw new Error("Another OneAPI process is using this database", { cause: error });
    }
    let opened: DatabaseSync | undefined;
    try {
      opened = new DatabaseSync(canonicalPath);
      opened.exec("PRAGMA journal_mode = WAL");
      opened.exec("PRAGMA synchronous = NORMAL");
      opened.exec("PRAGMA busy_timeout = 5000");
      opened.exec("CREATE TABLE IF NOT EXISTS oneapi_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      opened.exec(REQUEST_LOG_SCHEMA);
      const requestLogColumns = opened.prepare("PRAGMA table_info(request_logs)").all() as Array<{ name: string }>;
      if (!requestLogColumns.some((column) => column.name === "ignored_parameters")) {
        opened.exec("ALTER TABLE request_logs ADD COLUMN ignored_parameters TEXT NOT NULL DEFAULT '[]'");
      }
      opened.exec("CREATE INDEX IF NOT EXISTS request_logs_started_idx ON request_logs(started_at DESC)");
      opened.exec("CREATE INDEX IF NOT EXISTS request_logs_key_idx ON request_logs(key_id, started_at DESC)");
    } catch (error) {
      try { opened?.close(); } catch {}
      try { this.lockDatabase.exec("ROLLBACK"); } catch {}
      this.lockDatabase.close();
      throw error;
    }
    this.database = opened;
    this.sql = {
      exec: <T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...values: unknown[]): SqlCursor<T> => {
        this.assertOpen();
        const statement = this.database.prepare(query);
        const inputs = sqlBindings(values);
        if (statement.columns().length > 0) return new Rows(statement.all(...inputs) as T[]);
        statement.run(...inputs);
        return new Rows<T>([]);
      }
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite account storage is closed");
  }

  private read<T>(key: string): T | undefined {
    const row = this.database.prepare("SELECT value FROM oneapi_kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? decode<T>(row.value) : undefined;
  }

  private commit(overlay: Map<string, OverlayValue>): void {
    if (overlay.size === 0) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const write = this.database.prepare("INSERT INTO oneapi_kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      const remove = this.database.prepare("DELETE FROM oneapi_kv WHERE key = ?");
      for (const [key, value] of overlay) {
        if (value === DELETE) remove.run(key);
        else write.run(key, encode(value));
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.mutex.run(() => { this.assertOpen(); return this.read<T>(key); });
  }

  put<T>(key: string, value: T): Promise<void>;
  put(values: Record<string, unknown>): Promise<void>;
  put<T>(keyOrValues: string | Record<string, unknown>, value?: T): Promise<void> {
    return this.mutex.run(() => {
      this.assertOpen();
      const overlay = new Map<string, OverlayValue>();
      if (typeof keyOrValues === "string") overlay.set(keyOrValues, structuredClone(value));
      else for (const [key, entry] of Object.entries(keyOrValues)) overlay.set(key, structuredClone(entry));
      this.commit(overlay);
    });
  }

  delete(keyOrKeys: string | string[]): Promise<StorageDeleteResult> {
    return this.mutex.run(() => {
      this.assertOpen();
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      if (keys.length === 0) return 0;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const remove = this.database.prepare("DELETE FROM oneapi_kv WHERE key = ?");
        let changes = 0;
        for (const key of keys) changes += Number(remove.run(key).changes);
        this.database.exec("COMMIT");
        return Array.isArray(keyOrKeys) ? changes : changes > 0;
      } catch (error) {
        try { this.database.exec("ROLLBACK"); } catch {}
        throw error;
      }
    });
  }

  transaction<T>(callback: (transaction: StorageTransaction) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      this.assertOpen();
      const overlay = new Map<string, OverlayValue>();
      const transaction: StorageTransaction = {
        get: async <V>(key: string): Promise<V | undefined> => {
          if (!overlay.has(key)) return this.read<V>(key);
          const current = overlay.get(key);
          return current === DELETE ? undefined : structuredClone(current) as V;
        },
        put: (async <V>(keyOrValues: string | Record<string, unknown>, value?: V): Promise<void> => {
          if (typeof keyOrValues === "string") overlay.set(keyOrValues, structuredClone(value));
          else for (const [key, entry] of Object.entries(keyOrValues)) overlay.set(key, structuredClone(entry));
        }) as StorageTransaction["put"],
        delete: async (keyOrKeys: string | string[]): Promise<StorageDeleteResult> => {
          const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
          let changes = 0;
          for (const key of keys) {
            const exists = overlay.has(key) ? overlay.get(key) !== DELETE : this.read(key) !== undefined;
            if (exists) changes += 1;
            overlay.set(key, DELETE);
          }
          return Array.isArray(keyOrKeys) ? changes : changes > 0;
        }
      };
      const result = await callback(transaction);
      this.commit(overlay);
      return result;
    });
  }

  importEntries(entries: Record<string, unknown>, completedLogs: Iterable<Record<string, unknown>>): Promise<void> {
    return this.mutex.run(() => {
      this.assertOpen();
      const keys = Object.keys(entries);
      if (keys.some((key) => !MIGRATABLE_KEYS.has(key))) throw new Error("Migration contains an unsupported key");
      for (const value of Object.values(entries)) encode(value);
      const kvCount = this.database.prepare("SELECT COUNT(*) AS count FROM oneapi_kv").get() as { count: number };
      const logCount = this.database.prepare("SELECT COUNT(*) AS count FROM request_logs").get() as { count: number };
      if (Number(kvCount.count) !== 0 || Number(logCount.count) !== 0) throw new Error("Migration target is not empty");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const write = this.database.prepare("INSERT INTO oneapi_kv(key, value) VALUES(?, ?)");
        for (const [key, value] of Object.entries(entries)) write.run(key, encode(value));
        const placeholders = REQUEST_LOG_COLUMNS.map(() => "?").join(", ");
        const insertLog = this.database.prepare(`INSERT INTO request_logs (${REQUEST_LOG_COLUMNS.join(", ")}) VALUES (${placeholders})`);
        for (const log of completedLogs) {
          if (Object.keys(log).some((key) => !(REQUEST_LOG_COLUMNS as readonly string[]).includes(key))) {
            throw new Error("Migration log contains an unsupported column");
          }
          if (typeof log.id !== "string" || log.id.length === 0 || log.completed_at === null || log.completed_at === undefined) {
            throw new Error("Migration accepts completed request logs only");
          }
          insertLog.run(...sqlBindings(REQUEST_LOG_COLUMNS.map((column) => column === "ignored_parameters" ? log[column] ?? "[]" : log[column] ?? null)));
        }
        this.database.exec("COMMIT");
      } catch (error) {
        try { this.database.exec("ROLLBACK"); } catch {}
        throw error;
      }
    });
  }
  setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    this.alarmChanged?.();
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = null;
    this.alarmChanged?.();
    return Promise.resolve();
  }

  scheduledAlarm(): number | null { return this.alarmAt; }
  takeAlarm(): number | null { const current = this.alarmAt; this.alarmAt = null; return current; }
  onAlarmChanged(listener: (() => void) | null): void { this.alarmChanged = listener; }

  async close(): Promise<void> {
    await this.mutex.run(() => {
      if (this.closed) return;
      this.closed = true;
      try {
        this.database.close();
      } finally {
        try { this.lockDatabase.exec("ROLLBACK"); } catch {}
        this.lockDatabase.close();
      }
    });
  }
}