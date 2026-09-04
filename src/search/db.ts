/**
 * src/search/db.ts
 *
 * SQLite FTS5 database connection and schema initialization for open-agent-sessions search.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

import type { SearchDbOptions } from "./types";

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
 */
export function openSearchDb(options?: SearchDbOptions): Database {
  const dbPath = options?.dbPath || getSearchDbPath();
  const parentDir = dirname(dbPath);
  mkdirSync(parentDir, { recursive: true });

  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");

  return db;
}

/**
 * Initialize search schema idempotently.
 * Creates the contentless FTS5 virtual table, file watermarks, and byte-offset pointers tables with indices.
 */
export function initSearchSchema(db: Database): void {
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
