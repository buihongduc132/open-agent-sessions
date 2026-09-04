/**
 * src/search/engine.ts
 *
 * Full-text search query execution engine using SQLite FTS5 contentless tables,
 * BM25 relevance ranking, and direct byte-offset pointer resolution.
 *
 * Fulfills Milestone 5 (Tasks 18-22):
 * - query-fts-bm25 (Task 18): Query execution using BM25 ranking and safe FTS5 escaping.
 * - query-pointer-join (Task 19): Joining msg_pointers and file_watermarks to fetch turns via readTurnByPointer.
 * - query-agent-scope (Task 20): Agent and alias filtering via SQL constraints on file_watermarks.
 * - query-memory-cap (Task 21): Result capping and bounded memory allocations under high candidate counts.
 * - defer-vec-safe-fallback (Task 22): Clean fallback to BM25 when vector extensions are absent.
 * - Context Window: Optional retrieval of surrounding turns via readTurnContext.
 */

import type { Database } from "bun:sqlite";
import {
  readTurnByPointer,
  readTurnContext,
  type ContextWindowResult,
  type RawTurnRecord,
} from "./reader";
import type { MsgPointer, SearchQueryOptions } from "./types";

/**
 * Options for search engine query execution.
 */
export interface SearchEngineQueryOptions extends SearchQueryOptions {
  contextN?: number;
  hybrid?: boolean;
  useVector?: boolean;
}

/**
 * Structured search hit item returned by the query engine.
 */
export interface SearchEngineHit {
  rowid: number;
  sessionId: string;
  shortId: string;
  turnIndex: number;
  role: number | string;
  timestamp: number;
  agent: string;
  alias: string;
  filePath: string;
  score: number;
  hitTurn: RawTurnRecord | null;
  context?: ContextWindowResult;
  snippet?: string;
}

/**
 * Result structure returned by querySearch.
 */
export interface SearchQueryResult {
  query: string;
  totalHits: number;
  hits: SearchEngineHit[];
  executionTimeMs: number;
}

/**
 * Escapes user input for safe execution in SQLite FTS5 queries.
 *
 * Sanitizes quotes, colons, parentheses, boolean keywords (AND, OR, NOT, NEAR),
 * punctuation, and prefix tokens (*) to prevent FTS5 syntax errors.
 *
 * @param query Raw user query string.
 * @returns Sanitized FTS5 MATCH query string.
 */
export function escapeFts5Query(query: string): string {
  if (!query || typeof query !== "string") {
    return "";
  }

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const tokens: string[] = [];
  // Match either double-quoted phrases or sequences of non-whitespace characters
  const regex = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(trimmed)) !== null) {
    if (match[1] !== undefined) {
      // Quoted phrase: escape any internal quotes by doubling them
      const phrase = match[1].replace(/"/g, '""').trim();
      if (phrase.length > 0) {
        tokens.push(`"${phrase}"`);
      }
    } else if (match[2] !== undefined) {
      const raw = match[2];
      // Check if the token represents a prefix query token (ends with '*' with preceding characters)
      const isPrefix = raw.endsWith("*") && raw.replace(/\*+/g, "").length > 0;

      // Strip leading and trailing quotes and asterisks
      let clean = raw.replace(/^[*"]+/, "").replace(/[*"]+$/, "");
      clean = clean.replace(/"/g, '""');

      if (clean.length > 0) {
        if (isPrefix) {
          tokens.push(`"${clean}"*`);
        } else {
          tokens.push(`"${clean}"`);
        }
      }
    }
  }

  return tokens.join(" ");
}

/**
 * Executes a full-text search query against the SQLite FTS5 index.
 *
 * Performs BM25 relevance ranking, joins msg_pointers and file_watermarks, applies
 * optional agent/alias filters, retrieves exact turn payloads via O(1) file seeks,
 * and optionally resolves surrounding context windows.
 *
 * @param db Active search SQLite database.
 * @param options Search query options including text, filters, limit, and context.
 * @returns SearchQueryResult containing query text, total hits count, hits array, and timing.
 */
export async function querySearch(
  db: Database,
  options: SearchEngineQueryOptions | SearchQueryOptions
): Promise<SearchQueryResult> {
  const startTime = performance.now();
  const rawText = options?.text ?? "";

  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return {
      query: rawText,
      totalHits: 0,
      hits: [],
      executionTimeMs: Math.max(0, performance.now() - startTime),
    };
  }

  const escapedQuery = escapeFts5Query(rawText);
  if (escapedQuery.length === 0) {
    return {
      query: rawText,
      totalHits: 0,
      hits: [],
      executionTimeMs: Math.max(0, performance.now() - startTime),
    };
  }

  const limit = options.limit !== undefined && options.limit > 0 ? options.limit : 20;

  let baseSql = `
    FROM msg_fts f
    JOIN msg_pointers p ON f.rowid = p.rowid
    JOIN file_watermarks w ON p.file_id = w.file_id
    WHERE msg_fts MATCH ?
  `;
  const params: any[] = [escapedQuery];

  if (options.agent) {
    baseSql += " AND w.agent = ?";
    params.push(options.agent);
  }

  if (options.alias) {
    baseSql += " AND w.alias = ?";
    params.push(options.alias);
  }

  const selectSql = `
    SELECT
      f.rowid AS rowid,
      f.rank AS rank,
      p.session_id,
      p.turn_index,
      p.role,
      p.timestamp,
      p.file_id,
      p.byte_offset,
      p.byte_length,
      p.root_session_id,
      w.agent,
      w.alias,
      w.path AS filePath
    ${baseSql}
    ORDER BY f.rank ASC
    LIMIT ?
  `;

  let rows: any[] = [];
  try {
    rows = db.query(selectSql).all(...params, limit) as any[];
  } catch {
    // Graceful fallback on SQLite syntax or unexpected query errors
    return {
      query: rawText,
      totalHits: 0,
      hits: [],
      executionTimeMs: Math.max(0, performance.now() - startTime),
    };
  }

  let totalHits = rows.length;
  if (rows.length === limit) {
    try {
      const countSql = `SELECT count(*) AS total ${baseSql}`;
      const countRow = db.query(countSql).get(...params) as { total: number } | null;
      if (countRow && typeof countRow.total === "number") {
        totalHits = countRow.total;
      }
    } catch {
      totalHits = rows.length;
    }
  }

  const contextN = (options as any).contextN ?? options.context ?? 0;
  const hits: SearchEngineHit[] = [];

  for (const row of rows) {
    const pointer: MsgPointer = {
      rowid: row.rowid,
      session_id: row.session_id,
      turn_index: row.turn_index,
      file_id: row.file_id,
      byte_offset: row.byte_offset,
      byte_length: row.byte_length,
      role: row.role,
      timestamp: row.timestamp,
      root_session_id: row.root_session_id ?? null,
    };

    let hitTurn: RawTurnRecord | null = null;
    let contextResult: ContextWindowResult | undefined = undefined;

    if (contextN > 0) {
      contextResult = readTurnContext(db, row.filePath, pointer, contextN);
      hitTurn = contextResult.hitTurn;
    } else {
      hitTurn = readTurnByPointer(row.filePath, pointer);
    }

    const shortId =
      row.session_id && row.session_id.length >= 7
        ? row.session_id.slice(0, 7)
        : (row.session_id ?? "");

    const snippet = hitTurn?.rawText ? hitTurn.rawText.slice(0, 300) : "";

    const hit: SearchEngineHit = {
      rowid: row.rowid,
      sessionId: row.session_id,
      shortId,
      turnIndex: row.turn_index,
      role: row.role,
      timestamp: row.timestamp,
      agent: row.agent,
      alias: row.alias,
      filePath: row.filePath,
      score: typeof row.rank === "number" ? row.rank : 0,
      hitTurn,
      snippet,
    };

    if (contextN > 0 && contextResult) {
      hit.context = contextResult;
    }

    hits.push(hit);
  }

  return {
    query: rawText,
    totalHits,
    hits,
    executionTimeMs: Math.max(0, performance.now() - startTime),
  };
}
