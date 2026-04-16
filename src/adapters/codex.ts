import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { OtherAgentEntry } from "../config/types";
import {
  Adapter,
  SearchQuery,
  SessionDetail,
  SessionMessage,
  SessionReadOptions,
  SessionSummary,
  TimeRangeOptions,
} from "../core/types";
import { normalizeTimestamp } from "../core/normalize";
import type { CloneSourceAdapter, CloneSession, CloneMessage } from "../core/clone";
import type { SimilarSessionResult } from "../similarity/search";

type CodexAdapterOptions = {
  defaultPath?: string;
  configDir?: string;
};

type CodexRecord = {
  type?: string;
  timestamp?: unknown;
  payload?: Record<string, unknown>;
};

export function createCodexAdapter(
  entry: OtherAgentEntry,
  options: CodexAdapterOptions = {}
): Adapter {
  if (entry.agent !== "codex") {
    throw new Error(`Codex adapter requires agent "codex", got "${entry.agent}"`);
  }

  return {
    version: "1.0.0", // TODO: Replace with actual version from package.json or similar
    listSessions: () => {
      const label = `[${entry.agent}:${entry.alias}]`;
      try {
        const rootPath = resolveCodexPath(entry, options);

        // F2: For SQLite backends, listSessionsByTimeRange uses an indexed query.
        // Delegate to it to get O(log n) indexed access instead of O(n) JSONL scans.
        if (rootPath.endsWith(".sqlite")) {
          const results = listSessionsByTimeRangeFromSqlite(
            rootPath,
            entry,
            { since: 0, limit: 0 }, // 0 limit = no ceiling
            label
          );
          return results;
        }

        const files = collectJsonlFiles(rootPath);
        const sessions: SessionSummary[] = [];
        for (const filePath of files) {
          // Skip sentinel entries returned when file has JSON parse errors.
          // Semantic errors (invalid timestamps, missing session_meta, etc.)
          // propagate and will fail the whole listing as before.
          const session = parseCodexSession(filePath, entry);
          if (session.id) {
            sessions.push(session);
          }
        }
        return sessions;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    // F2: Time-range based listing — avoids loading all sessions into memory.
    // Two backends:
    //   1. SQLite  — for ~/.codex/state_5.sqlite: single indexed query, O(log n)
    //   2. JSONL   — for file/directory paths: file-based scan + sort + slice
    listSessionsByTimeRange: (rangeOpts: TimeRangeOptions): SessionSummary[] => {
      const label = `[${entry.agent}:${entry.alias}]`;
      const since = rangeOpts.since ?? 0; // 0 = no lower bound
      const limit = rangeOpts.limit ?? 50;
      const skipId = rangeOpts.skipSessionId;

      try {
        const rootPath = resolveCodexPath(entry, options);

        // ── F2: SQLite backend ───────────────────────────────────────────────
        // Codex's native state_5.sqlite has an indexed updated_at column.
        // Query it directly for O(log n) indexed access instead of O(n) file scans.
        if (rootPath.endsWith(".sqlite")) {
          return listSessionsByTimeRangeFromSqlite(
            rootPath,
            entry,
            { since, limit, skipSessionId: skipId },
            label
          );
        }

        // ── JSONL backend ────────────────────────────────────────────────────
        const files = collectJsonlFiles(rootPath);
        const summaries: SessionSummary[] = [];

        for (const filePath of files) {
          try {
            // parseCodexSession reads all lines but bails early on JSON parse errors.
            // We parse every file to extract timestamps — unavoidable for time filtering.
            const summary = parseCodexSessionForTimeRange(filePath, entry);
            if (!summary.id) continue;

            // Skip the cursor session so it doesn't reappear on the next page
            if (skipId !== undefined && summary.id === skipId) continue;

            // Filter: only sessions with last activity >= since
            const updatedAtMs = Date.parse(summary.updated_at);
            if (updatedAtMs < since) continue;

            summaries.push(summary);
          } catch {
            // Skip files that fail to parse — they can't contribute valid sessions
          }
        }

        // Sort by last activity DESC (most recent first), then by id ASC for ties
        summaries.sort((a, b) => {
          const timeDelta = Date.parse(b.updated_at) - Date.parse(a.updated_at);
          if (timeDelta !== 0) return timeDelta;
          return a.id.localeCompare(b.id);
        });

        return summaries.slice(0, limit);
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    // R-21: searchSessions — full Codex adapter
    searchSessions: (query: SearchQuery): SessionSummary[] => {
      const label = `[${entry.agent}:${entry.alias}]`;
      try {
        const rootPath = resolveCodexPath(entry, options);
        const files = collectJsonlFiles(rootPath);
        const needle = query.text.toLowerCase();
        const results: SessionSummary[] = [];

        for (const filePath of files) {
          try {
            const session = parseCodexSession(filePath, entry);
            // Match title or first user message preview
            const titleMatch = session.title.toLowerCase().includes(needle);
            const contentMatch = contentContains(filePath, needle);
            if (titleMatch || contentMatch) {
              results.push(session);
            }
          } catch {
            // Skip files that fail to parse — they won't match search anyway
          }
        }

        results.sort(
          (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
        );
        return results;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    // R-21: getSessionDetail — full Codex adapter
    getSessionDetail: async (
      sessionId: string,
      _options: SessionReadOptions
    ): Promise<SessionDetail> => {
      const label = `[${entry.agent}:${entry.alias}]`;
      const rootPath = resolveCodexPath(entry, options);
      const files = collectJsonlFiles(rootPath);

      for (const filePath of files) {
        try {
          const summary = parseCodexSession(filePath, entry);
          if (summary.id === sessionId) {
            const messages = parseCodexMessages(filePath, sessionId, label);
            return {
              ...summary,
              messages,
            };
          }
        } catch {
          // Skip files that fail to parse
        }
      }

      throw new Error(`${label} session not found: ${sessionId}`);
    },
    // REQ-SIM-03: Similarity search not yet supported for Codex adapter
    findSimilarSessions: async (): Promise<SimilarSessionResult[]> => [
      {
        sessionId: "",
        title: "",
        score: 0,
        rank: 0,
        matchType: "none",
        matchedChunks: 0,
        note: "Not yet supported",
      },
    ],
  };
}

function resolveCodexPath(entry: OtherAgentEntry, options: CodexAdapterOptions): string {
  const rawPath = (entry as Record<string, unknown>).path;
  if (rawPath !== undefined && typeof rawPath !== "string") {
    throw new Error(`Codex path must be a non-empty string`);
  }
  if (typeof rawPath === "string" && rawPath.trim().length === 0) {
    throw new Error(`Codex path must be a non-empty string`);
  }

  const configured = typeof rawPath === "string" ? rawPath : undefined;
  const fallback = options.defaultPath ?? join(homedir(), ".codex", "sessions");
  const resolved = resolvePath(configured ?? fallback, options.configDir);

  const stat = safeStat(resolved);
  if (!stat) {
    throw new Error(`Codex path not found: ${resolved}`);
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`Codex path is not a file or directory: ${resolved}`);
  }
  return resolved;
}

function collectJsonlFiles(rootPath: string): string[] {
  const stat = statSync(rootPath);
  if (stat.isFile()) {
    return [rootPath];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const files: string[] = [];
  walkDir(rootPath, files);
  return files.sort((a, b) => a.localeCompare(b));
}

function walkDir(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
}

function parseCodexSession(filePath: string, entry: OtherAgentEntry): SessionSummary {
  try {
    return parseCodexSessionInner(filePath, entry);
  } catch (error) {
    // Only skip files with JSON parse errors (corrupt lines).
    // Semantic errors (invalid timestamps, missing session_meta, etc.)
    // must still propagate so the caller knows the session data is bad.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("JSONL parse error")) {
      return { id: "", agent: "codex", alias: "", title: "", created_at: "", updated_at: "", message_count: 0, storage: "other" };
    }
    throw error;
  }
}

// F2: Lightweight session summary extractor for time-range listing.
// Reads all lines to extract timestamps (for time filtering) and session_meta
// (for id/title/created_at), but skips message content parsing for performance.
// Handles multi-session files by pairing each session_meta with its own timestamps.
function parseCodexSessionForTimeRange(filePath: string, entry: OtherAgentEntry): SessionSummary {
  try {
    return parseCodexSessionForTimeRangeInner(filePath, entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("JSONL parse error")) {
      // Return empty sentinel — listSessionsByTimeRange will skip empty ids
      return { id: "", agent: "codex", alias: "", title: "", created_at: "", updated_at: "", message_count: 0, storage: "other" };
    }
    throw error;
  }
}

function parseCodexSessionForTimeRangeInner(filePath: string, entry: OtherAgentEntry): SessionSummary {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  // Codex files can contain multiple sessions. We collect ALL session_meta records
  // and their associated timestamps, then pair them: each session_meta's id is
  // matched with the latest timestamp from records AFTER that session_meta
  // but BEFORE the next session_meta with a different id.
  type SessionRecord = { id: string; timestamp: string; maxTimestamp: string };
  const sessions: SessionRecord[] = [];

  let currentId: string | undefined;
  let currentCreatedAt: string | undefined;
  let currentMaxTs: string | undefined;

  for (const raw of lines) {
    if (raw.trim().length === 0) continue;

    let record: CodexRecord;
    try {
      record = JSON.parse(raw) as CodexRecord;
    } catch {
      throw new Error(`Codex JSONL parse error in ${filePath}`);
    }

    if (record.type === "session_meta") {
      // Flush the previous session if complete
      if (currentId !== undefined && currentCreatedAt !== undefined && currentMaxTs !== undefined) {
        sessions.push({ id: currentId, timestamp: currentCreatedAt, maxTimestamp: currentMaxTs });
      }
      // Start a new session
      currentId = readString(record.payload?.id, `Codex session id missing in ${filePath}`);
      currentCreatedAt = normalizeTimestamp(
        record.payload?.timestamp,
        `Codex created_at invalid for ${currentId} in ${filePath}`
      );
      currentMaxTs = currentCreatedAt; // initialize to created_at
      continue;
    }

    if (currentId === undefined) continue; // no session_meta seen yet

    // Accumulate timestamps for the current session
    if (record.timestamp !== undefined && record.timestamp !== null) {
      const ctx = `Codex timestamp invalid for ${currentId} in ${filePath}`;
      const ts = normalizeTimestamp(record.timestamp, ctx);
      currentMaxTs = currentMaxTs ? maxIso(currentMaxTs, ts) : ts;
    }
  }

  // Flush the final session
  if (currentId !== undefined && currentCreatedAt !== undefined && currentMaxTs !== undefined) {
    sessions.push({ id: currentId, timestamp: currentCreatedAt, maxTimestamp: currentMaxTs });
  }

  if (sessions.length === 0) {
    throw new Error(`Codex session missing session_meta: ${filePath}`);
  }

  // For a single-session file, return that session
  if (sessions.length === 1) {
    const s = sessions[0];
    return {
      id: s.id,
      agent: "codex",
      alias: entry.alias,
      title: s.id,
      created_at: s.timestamp,
      updated_at: s.maxTimestamp,
      message_count: 0,
      storage: "other",
    };
  }

  // Multi-session file: return the session with the LATEST last-activity
  // (most recently updated session in this file — matches Codex behavior)
  let best: SessionRecord = sessions[0];
  for (let i = 1; i < sessions.length; i++) {
    if (Date.parse(sessions[i].maxTimestamp) > Date.parse(best.maxTimestamp)) {
      best = sessions[i];
    }
  }
  return {
    id: best.id,
    agent: "codex",
    alias: entry.alias,
    title: best.id,
    created_at: best.timestamp,
    updated_at: best.maxTimestamp,
    message_count: 0,
    storage: "other",
  };
}

function parseCodexSessionInner(filePath: string, entry: OtherAgentEntry): SessionSummary {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  let sessionMeta: CodexRecord | undefined;
  let title: string | undefined;
  let messageCount = 0;
  let maxTimestamp: string | undefined;

  let sessionId: string | undefined;
  const entries: Array<{ record: CodexRecord; lineNumber: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.length === 0) {
      continue;
    }

    const record = parseJsonLine(raw, filePath, i + 1);
    if (record.type === "session_meta") {
      sessionId = readOptionalString(record.payload?.id) ?? sessionId;
    }
    entries.push({ record, lineNumber: i + 1 });
  }

  for (const entryInfo of entries) {
    const record = entryInfo.record;
    if (record.timestamp !== undefined && record.timestamp !== null) {
      const timestampContext = sessionId
        ? `Codex timestamp invalid for ${sessionId} at ${filePath}:${entryInfo.lineNumber}`
        : `Codex timestamp invalid at ${filePath}:${entryInfo.lineNumber}`;
      const timestampIso = normalizeTimestamp(record.timestamp, timestampContext);
      maxTimestamp = maxTimestamp ? maxIso(maxTimestamp, timestampIso) : timestampIso;
    }

    if (record.type === "session_meta") {
      sessionMeta = record;
      continue;
    }

    if (record.type === "response_item") {
      const payload = record.payload ?? {};
      const role = payload.role;
      if (role === "user" || role === "assistant") {
        messageCount += 1;
      }
      if (!title && role === "user") {
        const extracted = extractResponseText(payload);
        if (extracted) {
          title = extracted;
        }
      }
    }
  }

  if (!sessionMeta) {
    throw new Error(`Codex session missing session_meta: ${filePath}`);
  }

  const resolvedSessionId = readString(
    sessionMeta.payload?.id,
    `Codex session id missing in ${filePath}`
  );
  const createdAt = normalizeTimestamp(
    sessionMeta.payload?.timestamp,
    `Codex created_at invalid for ${resolvedSessionId} in ${filePath}`
  );
  if (!maxTimestamp) {
    throw new Error(`Codex updated_at missing for ${resolvedSessionId} in ${filePath}`);
  }

  const metaTitle = readOptionalString(sessionMeta.payload?.title);
  const resolvedTitle = preferTitle(metaTitle, title, resolvedSessionId);

  return {
    id: resolvedSessionId,
    agent: "codex",
    alias: entry.alias,
    title: resolvedTitle,
    created_at: createdAt,
    updated_at: maxTimestamp,
    message_count: messageCount,
    storage: "other",
  };
}

function parseJsonLine(line: string, filePath: string, lineNumber: number): CodexRecord {
  try {
    return JSON.parse(line) as CodexRecord;
  } catch (error) {
    throw new Error(`Codex JSONL parse error in ${filePath} at line ${lineNumber}`);
  }
}

function extractResponseText(payload: Record<string, unknown>): string | undefined {
  const content = payload.content;
  const text = extractContentText(content);
  if (!text) return undefined;
  const line = text.split(/\r?\n/)[0]?.trim();
  return line && line.length > 0 ? line : undefined;
}

function extractContentText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const pieces = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          if (typeof record.input_text === "string") return record.input_text;
          if (typeof record.text === "string") return record.text;
          if (typeof record.output_text === "string") return record.output_text;
        }
        return "";
      })
      .filter((part) => part.length > 0);
    return pieces.length > 0 ? pieces.join("") : undefined;
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
  }
  return undefined;
}

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function readString(value: unknown, context: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(context);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function preferTitle(
  metaTitle: string | undefined,
  fallbackTitle: string | undefined,
  sessionId: string
): string {
  if (metaTitle && metaTitle.length > 0) return metaTitle;
  if (fallbackTitle && fallbackTitle.length > 0) return fallbackTitle;
  return sessionId;
}

function resolvePath(pathValue: string, baseDir?: string): string {
  const expanded = expandTilde(pathValue);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  const base = baseDir ?? process.cwd();
  return resolve(base, expanded);
}

function expandTilde(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function safeStat(pathValue: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(pathValue);
  } catch (error) {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

/**
 * Search file content for a case-insensitive text match.
 * Used by searchSessions to avoid fully parsing every file twice.
 */
function contentContains(filePath: string, needle: string): boolean {
  try {
    const content = readFileSync(filePath, "utf8");
    return content.toLowerCase().includes(needle);
  } catch {
    return false;
  }
}

/**
 * Parse all messages from a Codex JSONL session file.
 * Returns SessionMessage[] for getSessionDetail.
 */
function parseCodexMessages(
  filePath: string,
  _sessionId: string,
  label: string
): SessionMessage[] {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const messages: SessionMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw.length === 0) continue;

    let record: CodexRecord;
    try {
      record = JSON.parse(raw) as CodexRecord;
    } catch {
      throw new Error(
        `Codex JSONL parse error in ${filePath} at line ${i + 1}`
      );
    }

    if (record.type !== "response_item") continue;

    const payload = record.payload ?? {};
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;

    const timestampContext = `${label} timestamp invalid in ${filePath}:${i + 1}`;
    const created_at = normalizeTimestamp(record.timestamp, timestampContext);

    // Extract text parts from content
    const content = payload.content;
    const textParts = extractContentParts(content);

    const parts: import("../core/types").SessionPart[] = textParts.map((text) => ({
      type: "text",
      text,
    }));

    // Extract model ID if present
    const modelID =
      typeof payload.modelID === "string"
        ? payload.modelID
        : undefined;

    messages.push({
      id: `${filePath}:${i + 1}`,
      role: role as "user" | "assistant",
      created_at,
      parts,
      modelID,
    });
  }

  return messages;
}

/**
 * Extract text content from Codex response_item content field.
 */
function extractContentParts(content: unknown): string[] {
  const parts: string[] = [];

  if (typeof content === "string") {
    parts.push(content);
    return parts;
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const text =
          (typeof record.input_text === "string" ? record.input_text : null) ??
          (typeof record.text === "string" ? record.text : null) ??
          (typeof record.output_text === "string" ? record.output_text : null);
        if (text) parts.push(text);
      }
    }
  } else if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    const text =
      (typeof record.input_text === "string" ? record.input_text : null) ??
      (typeof record.text === "string" ? record.text : null) ??
      (typeof record.output_text === "string" ? record.output_text : null);
    if (text) parts.push(text);
  }

  return parts;
}

// ============================================================================
// F2: SQLite-backed time-range listing
// ============================================================================

interface SqliteThreadRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  model: string | null;
  cwd: string;
}

/**
 * F2: List Codex sessions from state_5.sqlite using an indexed time-range query.
 *
 * Schema (from ~/.codex/state_5.sqlite):
 *   CREATE TABLE threads (
 *     id              TEXT PRIMARY KEY,
 *     updated_at      INTEGER NOT NULL,  -- Unix seconds (indexed: idx_threads_updated_at)
 *     created_at      INTEGER NOT NULL,
 *     title           TEXT NOT NULL,
 *     model           TEXT,
 *     cwd             TEXT NOT NULL,
 *     ...
 *   );
 *
 * Benefits over JSONL scanning:
 *   - Indexed range scan: O(log n) instead of O(n) file reads
 *   - No parsing: raw SQL extraction of title + timestamps
 *   - Single round-trip: LIMIT applied at DB level, not in-process
 */
function listSessionsByTimeRangeFromSqlite(
  dbPath: string,
  entry: OtherAgentEntry,
  options: { since: number; limit: number; skipSessionId?: string },
  label: string
): SessionSummary[] {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    throw new Error(
      `${label} failed to open SQLite DB ${dbPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    // Build the WHERE clause with indexed columns.
    // idx_threads_updated_at covers (updated_at DESC, id DESC) — used for ORDER BY + range.
    const conditions: string[] = ["updated_at >= ?"];
    const params: (string | number)[] = [options.since / 1000]; // convert ms → Unix seconds

    // Exclude the cursor session so it doesn't reappear on the next page (F2/F6)
    if (options.skipSessionId !== undefined) {
      conditions.push("id != ?");
      params.push(options.skipSessionId);
    }

    const limitClause = options.limit > 0 ? ` LIMIT ${options.limit}` : ""; // 0 = no cap
    const sql = `
      SELECT id, title, created_at, updated_at, model, cwd
      FROM threads
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      ${limitClause}
    `;

    let rows: SqliteThreadRow[];
    try {
      rows = db.query<SqliteThreadRow, (string | number)[]>(sql).all(...params);
    } catch (error) {
      throw new Error(
        `${label} SQLite query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return rows.map((row) => ({
      id: row.id,
      agent: "codex",
      alias: entry.alias,
      title: row.title || row.id,
      created_at: formatUnixSeconds(row.created_at),
      updated_at: formatUnixSeconds(row.updated_at),
      message_count: 0, // not stored in threads table; counts deferred to detail view
      storage: "other",
    }));
  } finally {
    db.close();
  }
}

/**
 * Convert Unix seconds (INTEGER from SQLite) to ISO-8601 string (milliseconds).
 * Codex stores all timestamps as Unix seconds; we normalise to the same
 * ISO-8601 format used by the JSONL path so session ordering is consistent.
 */
function formatUnixSeconds(unixSeconds: number): string {
  // unixSeconds is in seconds, Date expects milliseconds
  return new Date(unixSeconds * 1000).toISOString();
}

// ============================================================================
// Clone Source Adapter
// ============================================================================

export interface CodexCloneSourceOptions {
  defaultPath?: string;
  configDir?: string;
}

/**
 * Creates a CloneSourceAdapter for Codex that reads from JSONL files.
 */
export function createCodexCloneSourceAdapter(
  entry: OtherAgentEntry,
  options: CodexCloneSourceOptions = {}
): CloneSourceAdapter {
  if (entry.agent !== "codex") {
    throw new Error(`Codex source adapter requires agent "codex", got "${entry.agent}"`);
  }

  const label = `[${entry.agent}:${entry.alias}]`;

  return {
    agent: "codex",
    alias: entry.alias,
    version: "1.0.0",

    getSession: async (session_id: string): Promise<CloneSession | null> => {
      try {
        const rootPath = resolveCodexPath(entry, options);
        const files = collectJsonlFiles(rootPath);

        for (const filePath of files) {
          const session = parseCodexSessionForClone(filePath, session_id, label);
          if (session) {
            return session;
          }
        }

        return null;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
  };
}

function parseCodexSessionForClone(
  filePath: string,
  targetSessionId: string,
  label: string
): CloneSession | null {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  let sessionId: string | undefined;
  let sessionMeta: CodexRecord | undefined;
  let title: string | undefined;
  let createdAt: string | undefined;
  let maxTimestamp: string | undefined;
  const messages: CloneMessage[] = [];

  const entries: Array<{ record: CodexRecord; lineNumber: number }> = [];

  // First pass: collect all records
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.length === 0) {
      continue;
    }

    const record = parseJsonLine(raw, filePath, i + 1);
    if (record.type === "session_meta") {
      sessionId = readOptionalString(record.payload?.id) ?? sessionId;
    }
    entries.push({ record, lineNumber: i + 1 });
  }

  // Check if this is the target session
  if (!sessionId || sessionId !== targetSessionId) {
    return null;
  }

  // Second pass: extract data
  for (const entryInfo of entries) {
    const record = entryInfo.record;

    if (record.timestamp !== undefined && record.timestamp !== null) {
      const timestampContext = `Codex timestamp invalid for ${sessionId} at ${filePath}:${entryInfo.lineNumber}`;
      const timestampIso = normalizeTimestamp(record.timestamp, timestampContext);
      maxTimestamp = maxTimestamp ? maxIso(maxTimestamp, timestampIso) : timestampIso;
    }

    if (record.type === "session_meta") {
      sessionMeta = record;
      continue;
    }

    if (record.type === "response_item") {
      const payload = record.payload ?? {};
      const role = payload.role as string | undefined;

      if (role === "user" || role === "assistant") {
        const content = extractContentText(payload.content) ?? "";
        const timestamp = normalizeTimestamp(
          record.timestamp,
          `Codex message timestamp invalid for ${sessionId} at ${filePath}:${entryInfo.lineNumber}`
        );

        messages.push({
          role,
          content,
          created_at: timestamp,
        });

        if (!title && role === "user") {
          const extracted = extractResponseText(payload);
          if (extracted) {
            title = extracted;
          }
        }
      }
    }
  }

  if (!sessionMeta) {
    throw new Error(`${label} Codex session missing session_meta: ${filePath}`);
  }

  const metaTitle = readOptionalString(sessionMeta.payload?.title);
  const resolvedTitle = preferTitle(metaTitle, title, sessionId);

  createdAt = normalizeTimestamp(
    sessionMeta.payload?.timestamp,
    `Codex created_at invalid for ${sessionId} in ${filePath}`
  );

  if (!maxTimestamp) {
    throw new Error(`${label} Codex updated_at missing for ${sessionId} in ${filePath}`);
  }

  return {
    id: sessionId,
    title: resolvedTitle,
    created_at: createdAt,
    updated_at: maxTimestamp,
    messages,
  };
}
