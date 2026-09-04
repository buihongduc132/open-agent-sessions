/**
 * src/search/index.ts
 *
 * Unified barrel export facade for the SQLite FTS5 contentless search subsystem.
 *
 * Re-exports public interfaces, database operations, extraction logic,
 * incremental sync routines, random file seeks, and BM25 search queries.
 */

import type { Database } from "bun:sqlite";
import { openSearchDb, initSearchSchema } from "./db";
import type { SearchDbOptions } from "./types";

// Core domain types and interfaces
export * from "./types";

// SQLite database connection and schema lifecycle
export * from "./db";

// Selective payload extraction
export * from "./extractor";

// Incremental watermark synchronization
export * from "./sync";

// Direct byte-offset file reader and context window
export * from "./reader";

// Search query execution engine and escaping
export * from "./engine";

// Query planner and boolean predicates
export * from "./planner";

// Public API aliases and convenience initializers
export { getSearchDbPath as getDbPath } from "./db";

/**
 * Convenience helper to open the search database and ensure its schema is initialized.
 */
export function initSearchDb(options?: SearchDbOptions): Database {
  const db = openSearchDb(options);
  initSearchSchema(db);
  return db;
}
