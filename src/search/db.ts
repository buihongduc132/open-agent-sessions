/**
 * src/search/db.ts
 *
 * SQLite FTS5 database connection and schema initialization for open-agent-sessions search.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

import type { SearchDbOptions } from "./types";

/**
 * Remove database file and any active SQLite sidecar files (-wal, -shm, -journal).
 */
function cleanCorruptedDbFiles(dbPath: string): void {
  const sidecars = [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    `${dbPath}-journal`,
  ];
  for (const file of sidecars) {
    try {
      if (existsSync(file)) {
        rmSync(file, { force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

/**
 * Resolve the SQLite search database file path.
 * Honors $XDG_CACHE_HOME with fallback to ~/.cache/oas/search.sqlite.
 */
export function getSearchDbPath(): string {
  const xdgCache = process.env.XDG_CACHE_HOME;
  if (xdgCache && xdgCache.trim().length > 0) {
    return join(xdgCache, "oas", "search.sqlite");
  }
  return join(homedir(), ".cache", "oas", "search.sqlite");
}

/**
 * Open or create the SQLite search database.
 * Ensures the parent directory exists and sets WAL journal mode.
 * Auto-recovers from truncated or corrupt SQLite database files.
 */
export function openSearchDb(options?: SearchDbOptions): Database {
  const dbPath = options?.dbPath || getSearchDbPath();
  const parentDir = dirname(dbPath);
  mkdirSync(parentDir, { recursive: true });

  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA synchronous = NORMAL;");
    // Verify database readability to catch early corruption
    db.query("SELECT 1").get();
    return db;
  } catch (error) {
    // Corrupt or truncated database detected (e.g. SQLITE_NOTADB, SQLITE_CORRUPT)
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close error on broken handle
      }
    }
    cleanCorruptedDbFiles(dbPath);

    // Reopen fresh database, apply PRAGMAs, and initialize schema
    const freshDb = new Database(dbPath);
    freshDb.run("PRAGMA journal_mode = WAL;");
    freshDb.run("PRAGMA synchronous = NORMAL;");
    initSearchSchema(freshDb);
    return freshDb;
  }
}

function applySchemaStatements(db: Database): void {
  // 1. Contentless FTS5 virtual table
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
      user_text,
      assistant_text,
      tool_name,
      tool_args,
      content="",
      contentless_delete=1
    );
  `);

  // 2. Watermarks table tracking file scan status
  db.run(`
    CREATE TABLE IF NOT EXISTS file_watermarks (
      file_id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      last_scanned_bytes INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL,
      agent TEXT NOT NULL,
      alias TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    );
  `);

  // 3. Pointer table storing byte offsets into raw session logs
  db.run(`
    CREATE TABLE IF NOT EXISTS msg_pointers (
      rowid INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      file_id INTEGER NOT NULL,
      byte_offset INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      role INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      root_session_id TEXT
    );
  `);

  // 4. Indices on pointers for efficient lookup
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_msg_pointers_session_turn ON msg_pointers (session_id, turn_index);
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_msg_pointers_file_offset ON msg_pointers (file_id, byte_offset);
  `);
}

/**
 * Initialize search schema idempotently.
 * Creates the contentless FTS5 virtual table, file watermarks, and byte-offset pointers tables with indices.
 * If schema creation fails due to corruption, removes the database file and re-creates cleanly.
 */
export function initSearchSchema(db: Database): void {
  try {
    applySchemaStatements(db);
  } catch (error) {
    const dbPath = (db as any)?.filename;
    if (dbPath && typeof dbPath === "string" && dbPath !== ":memory:") {
      try {
        db.close();
      } catch {
        // Ignore close error on corrupt handle
      }
      cleanCorruptedDbFiles(dbPath);

      // Re-create cleanly on disk
      try {
        const freshDb = new Database(dbPath);
        freshDb.run("PRAGMA journal_mode = WAL;");
        freshDb.run("PRAGMA synchronous = NORMAL;");
        applySchemaStatements(freshDb);
        freshDb.close();
      } catch {
        // Ignore secondary error
      }
    }
  }
}

/**
 * Safely close the SQLite search database connection.
 * Tolerates double close without throwing.
 */
export function closeSearchDb(db: Database): void {
  try {
    db.close();
  } catch {
    // Tolerates already-closed database
  }
}
