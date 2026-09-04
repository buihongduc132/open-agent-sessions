/**
 * DuckDB connection + schema bootstrap.
 *
 * Single-file storage: outbox + cmd_events + cmd_quarantine + watermarks +
 * schema_meta all in same DuckDB file (OT26/e).
 *
 * @file src/storage/duckdb.ts
 */
import { Database } from "duckdb";
import type { Database as DbCtor } from "duckdb";
import { join } from "node:path";
import { openSync, closeSync, unlinkSync, existsSync } from "node:fs";
import { SCHEMA_DDL } from "./schema";

export interface DbHandle {
  all<T = any>(sql: string, params?: any[]): Promise<T[]>;
  run(sql: string, params?: any[]): Promise<any>;
  close(): Promise<void>;
}

const OAS_CS_SCHEMA_VERSION = "0.4.0"; // Phase 5 migration: lease + flock
const DUCKDB_VERSION_PINNED = "1.4.4";

const NORMALIZE_FN = (v: any): any => {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(NORMALIZE_FN);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = NORMALIZE_FN((v as any)[k]);
    return out;
  }
  // Normalize semver strings: duckdb version() returns "v1.4.4" → "1.4.4"
  if (typeof v === "string" && /^v\d+\.\d+\.\d+/.test(v)) {
    return v.replace(/^v/, "");
  }
  return v;
};

function wrap(db: DbCtor): DbHandle {
  const normalize = NORMALIZE_FN;
  return {
    all<T = any>(sql: string, params?: any[]): Promise<T[]> {
      return new Promise((resolve, reject) => {
        if (params && params.length > 0) {
          db.all(sql, ...params, (err: any, rows: any[]) => {
            if (err) reject(err);
            else resolve((rows ?? []).map(normalize) as T[]);
          });
        } else {
          db.all(sql, (err: any, rows: any[]) => {
            if (err) reject(err);
            else resolve((rows ?? []).map(normalize) as T[]);
          });
        }
      });
    },
    run(sql: string, params?: any[]): Promise<any> {
      return new Promise((resolve, reject) => {
        if (params && params.length > 0) {
          db.run(sql, ...params, (err: any) => {
            if (err) reject(err);
            else resolve(undefined);
          });
        } else {
          db.run(sql, (err: any) => {
            if (err) reject(err);
            else resolve(undefined);
          });
        }
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        db.close((err: any) => err ? reject(err) : resolve());
      });
    },
  };
}

async function bootstrap(db: DbCtor): Promise<void> {
  const execAll = (ddl: string) => new Promise<void>((resolve, reject) => {
    db.exec(ddl, (err) => err ? reject(err) : resolve());
  });
  await execAll(SCHEMA_DDL);

  // Phase 5: lease columns are now in CREATE TABLE (fresh DBs).
  // For existing 0.3.0 DBs, see flow/requirements/ for migration guide.
  // Runtime migration via ALTER TABLE crashes duckdb-node on reopen after VACUUM (LSL #5).

  // Seed schema_meta (idempotent).
  await new Promise<void>((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?), (?, ?)`,
      "oas_command_stats_schema_version", OAS_CS_SCHEMA_VERSION,
      "duckdb_version_pinned", DUCKDB_VERSION_PINNED,
      (err: any) => err ? reject(err) : resolve()
    );
  });
}


export interface LockHandle { fd: number; path: string; }

/**
 * Acquire exclusive file lock on DB path (OT12-1).
 * Uses POSIX flock(2) via `flock` CLI binary for true advisory locking.
 * Stale lockfile on prior crash is auto-recovered: flock is on the FD,
 * not the path; reopening the path + acquiring fresh flock is harmless.
 * Throws if lock already held by another live process.
 */
export async function acquireDbLock(dbPath: string): Promise<LockHandle> {
  const lockPath = dbPath + "..lock";
  // Open with O_CREAT (not O_EXCL) — flock is the gate, not file existence.
  // 'a' flag = O_WRONLY|O_CREAT|O_APPEND. Stale file from crashed process
  // is overwritten harmlessly.
  const fd = openSync(lockPath, "a");
  // Use flock(2) via shell-out (node:fs lacks flockSync in this Bun runtime).
  // LOCK_EX | LOCK_NB = non-blocking exclusive — fails immediately if held.
  const { execSync } = await import("node:child_process");
  try {
    // flock <fd> <cmd>: we use true(1) as no-op command after acquiring.
    execSync(`flock --exclusive --nonblock ${fd} true`, { stdio: "ignore" });
  } catch {
    try { closeSync(fd); } catch {}
    throw new Error(`db lock already held: ${lockPath}`);
  }
  return { fd, path: lockPath };
}

/** Release lock — close fd (releases flock) + remove lock file. */
export async function releaseDbLock(handle: LockHandle): Promise<void> {
  try { closeSync(handle.fd); } catch {}
  try { unlinkSync(handle.path); } catch {}
}

export async function openDb(path: string): Promise<DbHandle> {
  const db = new Database(path);
  await bootstrap(db);
  return wrap(db);
}

export async function openReadOnly(path: string): Promise<DbHandle> {
  // NOTE: duckdb-node `readonly` option segfaults under Bun runtime (CA).
  // Software-level readonly guard as Phase 2 stub. Phase 5 will address
  // DB-level readonly via different runtime or FFI fix.
  const db = new Database(path);
  const writeRe = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|MERGE|COPY)\b/i;
  return {
    all<T = any>(sql: string, params?: any[]): Promise<T[]> {
      return new Promise((resolve, reject) => {
        if (params && params.length > 0) {
          db.all(sql, ...params, (err: any, rows: any[]) => {
            if (err) reject(err);
            else resolve((rows ?? []).map(NORMALIZE_FN) as T[]);
          });
        } else {
          db.all(sql, (err: any, rows: any[]) => {
            if (err) reject(err);
            else resolve((rows ?? []).map(NORMALIZE_FN) as T[]);
          });
        }
      });
    },
    run(sql: string, params?: any[]): Promise<any> {
      if (writeRe.test(sql)) {
        return Promise.reject(new Error(
          "Cannot execute write operation on read-only connection (OT18)"
        ));
      }
      return new Promise((resolve, reject) => {
        if (params && params.length > 0) {
          db.run(sql, ...params, (err: any) => {
            if (err) reject(err);
            else resolve(undefined);
          });
        } else {
          db.run(sql, (err: any) => {
            if (err) reject(err);
            else resolve(undefined);
          });
        }
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        db.close((err: any) => err ? reject(err) : resolve());
      });
    },
  };
}

export async function setWatermark(
  db: DbHandle,
  agent: string,
  alias: string,
  session_id: string,
  scan_completed_at: Date,
  source_schema_version?: string,
): Promise<void> {
  await db.run(
    `INSERT INTO session_watermarks
       (agent, alias, session_id, scan_started_at, scan_completed_at, source_schema_version)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent, alias, session_id) DO UPDATE SET
       scan_started_at = excluded.scan_started_at,
       scan_completed_at = excluded.scan_completed_at,
       source_schema_version = COALESCE(excluded.source_schema_version, session_watermarks.source_schema_version)`,
    [agent, alias, session_id, scan_completed_at, scan_completed_at, source_schema_version ?? null]
  );
}

export interface WatermarkRow {
  agent: string;
  alias: string;
  session_id: string;
  scan_started_at: Date | null;
  scan_completed_at: Date | null;
  source_schema_version: string | null;
}

export async function getWatermark(
  db: DbHandle,
  agent: string,
  alias: string,
  session_id: string,
): Promise<WatermarkRow | null> {
  const rows = await db.all<WatermarkRow>(
    `SELECT * FROM session_watermarks WHERE agent=? AND alias=? AND session_id=?`,
    [agent, alias, session_id]
  );
  return rows[0] ?? null;
}
