import { Database } from "bun:sqlite";
import { config } from "../config/config.ts";
import { ensureDataDir } from "../config/config.ts";

let db: Database | null = null;

export function getBufferDb(): Database {
  if (!db) {
    ensureDataDir();
    db = new Database(config.paths.bufferDb, { create: true, strict: true });
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA busy_timeout = 5000;");
    initSchema(db);
    // Ensure WAL is flushed on normal process exit
    process.once("exit", () => { if (db) { db.close(); db = null; } });
  }
  return db;
}

function initSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS buffer_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      operation TEXT NOT NULL DEFAULT 'insert',
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      synced_at INTEGER,
      retries INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_buffer_unsynced
    ON buffer_queue(synced_at) WHERE synced_at IS NULL
  `);
}

// ---- Queue Operations ----

export function enqueue(tableName: string, data: Record<string, unknown>, operation = "insert"): number {
  const db = getBufferDb();
  const stmt = db.prepare(
    "INSERT INTO buffer_queue (table_name, operation, data) VALUES (?, ?, ?)"
  );
  const result = stmt.run(tableName, operation, JSON.stringify(data));
  return Number(result.lastInsertRowid);
}

export function enqueueBatch(items: { tableName: string; data: Record<string, unknown>; operation?: string }[]): void {
  const db = getBufferDb();
  const stmt = db.prepare(
    "INSERT INTO buffer_queue (table_name, operation, data) VALUES (?, ?, ?)"
  );
  const insertMany = db.transaction((items: any[]) => {
    for (const item of items) {
      stmt.run(item.tableName, item.operation ?? "insert", JSON.stringify(item.data));
    }
  });
  insertMany(items);
}

export function getPendingItems(limit = 50): {
  id: number;
  tableName: string;
  operation: string;
  data: Record<string, unknown>;
  createdAt: number;
  retries: number;
}[] {
  const db = getBufferDb();
  const rows = db
    .prepare(
      `SELECT id, table_name, operation, data, created_at, retries
       FROM buffer_queue
       WHERE synced_at IS NULL AND retries < 10
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(limit) as any[];

  return rows.map((row) => ({
    id: row.id,
    tableName: row.table_name,
    operation: row.operation,
    data: JSON.parse(row.data),
    createdAt: row.created_at,
    retries: row.retries,
  }));
}

export function markSynced(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getBufferDb();
  const placeholders = ids.map(() => "?").join(",");
  db.run(
    `UPDATE buffer_queue SET synced_at = unixepoch() * 1000 WHERE id IN (${placeholders})`,
    ids
  );
}

export function markFailed(id: number, error: string): void {
  const db = getBufferDb();
  db.run(
    "UPDATE buffer_queue SET retries = retries + 1, last_error = ? WHERE id = ?",
    [error, id]
  );
}

export function getPendingCount(): number {
  const db = getBufferDb();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM buffer_queue WHERE synced_at IS NULL AND retries < 10")
    .get() as any;
  return row?.count ?? 0;
}

export function cleanSynced(olderThanMs = 24 * 60 * 60 * 1000): number {
  const db = getBufferDb();
  const cutoff = Date.now() - olderThanMs;
  const result = db.run(
    "DELETE FROM buffer_queue WHERE synced_at IS NOT NULL AND synced_at < ?",
    [cutoff]
  );
  return result.changes;
}

// ---- Sync State (track what we've already processed) ----

export function getSyncState(key: string): string | null {
  const db = getBufferDb();
  const row = db
    .prepare("SELECT value FROM sync_state WHERE key = ?")
    .get(key) as any;
  return row?.value ?? null;
}

export function setSyncState(key: string, value: string): void {
  const db = getBufferDb();
  db.run(
    `INSERT INTO sync_state (key, value, updated_at)
     VALUES (?, ?, unixepoch() * 1000)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value]
  );
}

export function closeBuffer(): void {
  if (db) {
    db.close();
    db = null;
  }
}
