import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { Database } from "bun:sqlite";
import { createLabel } from "./label";
import { createBrokenAdapter } from "./broken";
import { splitJsonlLines } from "./fs-utils";
import {
  extractContentPartsCodex,
  extractContentTextCodex,
} from "./content-utils";
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
import { errorMessage } from "../core/utils";
import type { CloneSourceAdapter, CloneSession, CloneMessage } from "../core/clone";
import {
  collectJsonlFiles,
  contentContainsStreaming,
  maxIso,
  resolvePath,
  safeStat,
} from "./fs-utils";

type CodexAdapterOptions = {
  defaultPath?: string;
  configDir?: string;
};

type CodexRecord = {
  type?: string;
  timestamp?: unknown;
  payload?: Record<string, unknown>;
};

/**
 * Codex adapter factory. Construction errors deferred to query time (OT4).
 */
export function createCodexAdapter(
  entry: OtherAgentEntry,
  options: CodexAdapterOptions = {}
): Adapter {
  try {
    return buildCodexAdapter(entry, options);
  } catch (error) {
    return createBrokenAdapter(createLabel(entry), error);
  }
}

function buildCodexAdapter(
  entry: OtherAgentEntry,
  options: CodexAdapterOptions = {}
): Adapter {
  if (entry.agent !== "codex") {
    throw new Error(`Codex adapter requires agent "codex", got "${entry.agent}"`);
  }

  return {
    version: "1.0.0", // TODO: Replace with actual version from package.json or similar
    listSessions: () => {
      const label = createLabel(entry);
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
      const label = createLabel(entry);
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
            { since, until: rangeOpts.until, limit, skipSessionId: skipId },
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
            if (rangeOpts.until !== undefined && updatedAtMs > rangeOpts.until) continue;

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

        // Explicit --limit 0 means all matches, consistent with the SQLite backend.
        return limit > 0 ? summaries.slice(0, limit) : summaries;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    // R-21: searchSessions — full Codex adapter.
    // BUG-2: two backends mirroring listSessionsByTimeRange:
    //   1. SQLite — pre-filter candidate threads via indexed fields
    //      (title/cwd/first_user_message/id), then stream ONLY those rollout
    //      JSONL files for content. Avoids parsing/scanning all ~2.7k files.
    //      Falls back to a full JSONL scan when the needle appears in NO
    //      indexed field (sqlite row count is cheap; content still streams
    //      per-file with early exit).
    //   2. JSONL — stream files line-by-line, never full-file readFileSync
    //      parse; early-exit per session on first content match.
    searchSessions: (query: SearchQuery): SessionSummary[] => {
      const label = createLabel(entry);
      try {
        const rootPath = resolveCodexPath(entry, options);
        const needle = query.text.toLowerCase();

        if (rootPath.endsWith(".sqlite")) {
          return searchSessionsFromSqlite(rootPath, entry, needle, label);
        }

        const files = collectJsonlFiles(rootPath);
        const results: SessionSummary[] = [];

        for (const filePath of files) {
          // BUG-2: never fully parse a file just to test content — stream the
          // raw bytes first (cheap, early-exit), and only build the summary
          // when the raw file actually contains the needle (title or content).
          if (!contentContainsStreaming(filePath, needle)) continue;
          try {
            const session = parseCodexSession(filePath, entry);
            if (session.id !== "") {
              results.push(session);
            }
          } catch {
            // Skip files that fail to parse — content streaming already ran.
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
      readOptions: SessionReadOptions
    ): Promise<SessionDetail> => {
      const label = createLabel(entry);
      const rootPath = resolveCodexPath(entry, options);

      // ── SQLite backend: use DB to resolve JSONL path, then parse messages ──
      if (rootPath.endsWith(".sqlite")) {
        return getSessionDetailFromSqlite(rootPath, sessionId, entry, readOptions, label);
      }

      // ── JSONL backend: scan files directly ──
      const files = collectJsonlFiles(rootPath);

      for (const filePath of files) {
        try {
          const summary = parseCodexSession(filePath, entry);
          if (summary.id === sessionId) {
            const messages = applyCodexReadOptions(
              parseCodexMessages(filePath, sessionId, label),
              readOptions
            );
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

  };
}

/**
 * BUG-2: SQLite-backed content search.
 *
 * Strategy: the sqlite threads index covers id/title/cwd/first_user_message.
 * Pre-filter candidate threads with those indexed fields first and stream only
 * their rollout JSONL files. If the needle matches NO indexed row, fall back
 * to streaming every rollout_path (bounded) — still avoiding full JSONL
 * parses of non-candidates. Rows whose rollout file is missing (e.g. pruned
 * or from another machine) still match on the indexed fields themselves.
 */
function searchSessionsFromSqlite(
  dbPath: string,
  entry: OtherAgentEntry,
  needleLower: string,
  label: string
): SessionSummary[] {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    throw new Error(
      `${label} failed to open SQLite DB ${dbPath}: ${errorMessage(error)}`
    );
  }

  try {
    const { projection, join: parentJoin } = codexParentQuery(db);
    // ESCAPE '\' so literal % / _ in the needle don't act as wildcards.
    const like = `%${needleLower.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const sql = `
      SELECT t.id, t.title, t.created_at, t.updated_at, t.cwd, t.rollout_path, ${projection}
      FROM threads t ${parentJoin}
      WHERE lower(t.title) LIKE ? ESCAPE '\\'
         OR lower(t.cwd) LIKE ? ESCAPE '\\'
         OR lower(t.id) LIKE ? ESCAPE '\\'
         OR lower(coalesce(t.first_user_message, '')) LIKE ? ESCAPE '\\'
      ORDER BY t.updated_at DESC, t.id DESC
    `;

    let rows: SqliteThreadRow[];
    try {
      rows = db.query<SqliteThreadRow, string[]>(sql).all(like, like, like, like);
    } catch (error) {
      throw new Error(`${label} SQLite query failed: ${errorMessage(error)}`);
    }

    // Verify content matches by streaming each candidate's rollout file.
    // A row matches if the needle hits an indexed field OR its rollout JSONL
    // (first_user_message is a preview — content can match beyond it).
    const results: SessionSummary[] = [];
    for (const row of rows) {
      const indexedMatch =
        row.title.toLowerCase().includes(needleLower) ||
        row.cwd.toLowerCase().includes(needleLower) ||
        row.id.toLowerCase().includes(needleLower);
      const rolloutPath = row.rollout_path?.trim();
      const contentMatch = !indexedMatch && rolloutPath
        ? contentContainsStreaming(rolloutPath, needleLower)
        : false;
      if (!indexedMatch && !contentMatch) continue;

      results.push({
        id: row.id,
        agent: "codex",
        alias: entry.alias,
        title: cleanCodexTitle(row.title) || row.id,
        created_at: formatUnixSeconds(row.created_at),
        updated_at: formatUnixSeconds(row.updated_at),
        message_count: rolloutPath ? countCodexRolloutMessagesCached(rolloutPath) : 0,
        storage: "other",
        ...(typeof row.parent_id === "string" && row.parent_id !== row.id && row.parent_id.length > 0
          ? { parentSessionId: row.parent_id } : {}),
      });
    }

    // Fall back to a full JSONL scan ONLY when no indexed field matched and
    // no rollout content matched (needle may live deeper in unindexed content).
    if (results.length === 0) {
      // Scan the sessions dir that belongs to this DB (dirname(state.sqlite)/sessions)
      // — for the real ~/.codex/state_5.sqlite this is ~/.codex/sessions.
      const fallbackRoot = join(dirname(dbPath), "sessions");
      try {
        if (safeStat(fallbackRoot)) {
          const files = collectJsonlFiles(fallbackRoot);
          for (const filePath of files) {
            if (!contentContainsStreaming(filePath, needleLower)) continue;
            try {
              const session = parseCodexSession(filePath, entry);
              if (session.id !== "") results.push(session);
            } catch {
              // Skip files that fail to parse
            }
          }
        }
      } catch {
        // Fallback scan failed — return whatever we have (possibly nothing).
      }
    }

    results.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    return results;
  } finally {
    db.close();
  }
}

function resolveCodexPath(entry: OtherAgentEntry, options: CodexAdapterOptions): string {  const rawPath = entry.path;
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

function parseCodexSession(filePath: string, entry: OtherAgentEntry): SessionSummary {
  try {
    return parseCodexSessionInner(filePath, entry);
  } catch (error) {
    // Only skip files with JSON parse errors (corrupt lines).
    // Semantic errors (invalid timestamps, missing session_meta, etc.)
    // must still propagate so the caller knows the session data is bad.
    const message = errorMessage(error);
    if (message.includes("JSONL parse error")) {
      return { ...EMPTY_CODEX_SESSION };
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
    const message = errorMessage(error);
    if (message.includes("JSONL parse error")) {
      // Return empty sentinel — listSessionsByTimeRange will skip empty ids
      return { ...EMPTY_CODEX_SESSION };
    }
    throw error;
  }
}

function parseCodexSessionForTimeRangeInner(filePath: string, entry: OtherAgentEntry): SessionSummary {
  const lines = splitJsonlLines(readFileSync(filePath, "utf8"));

  // Codex files can contain multiple sessions. We collect ALL session_meta records
  // and their associated timestamps, then pair them: each session_meta's id is
  // matched with the latest timestamp from records AFTER that session_meta
  // but BEFORE the next session_meta with a different id.
  type SessionRecord = { id: string; timestamp: string; maxTimestamp: string; parentId?: string; messageCount: number };
  const sessions: SessionRecord[] = [];

  let currentId: string | undefined;
  let currentCreatedAt: string | undefined;
  let currentMaxTs: string | undefined;
  let currentParentId: string | undefined;
  let currentMessageCount = 0;

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
        sessions.push({ id: currentId, timestamp: currentCreatedAt, maxTimestamp: currentMaxTs, parentId: currentParentId, messageCount: currentMessageCount });
      }
      // Start a new session
      currentId = readString(record.payload?.id, `Codex session id missing in ${filePath}`);
      currentCreatedAt = normalizeTimestamp(
        record.payload?.timestamp,
        `Codex created_at invalid for ${currentId} in ${filePath}`
      );
      currentMaxTs = currentCreatedAt; // initialize to created_at
      currentParentId = readCodexParentId(record.payload);
      currentMessageCount = 0;
      continue;
    }

    if (currentId === undefined) continue; // no session_meta seen yet

    // Accumulate timestamps for the current session
    if (record.timestamp !== undefined && record.timestamp !== null) {
      const ctx = `Codex timestamp invalid for ${currentId} in ${filePath}`;
      const ts = normalizeTimestamp(record.timestamp, ctx);
      currentMaxTs = currentMaxTs ? maxIso(currentMaxTs, ts) : ts;
    }

    // BUG-9: count user/assistant response_items so list message_count
    // agrees with the detail view (same rule as parseCodexSessionInner).
    if (record.type === "response_item") {
      const role = record.payload?.role;
      if (role === "user" || role === "assistant") {
        currentMessageCount += 1;
      }
    }
  }

  // Flush the final session
  if (currentId !== undefined && currentCreatedAt !== undefined && currentMaxTs !== undefined) {
    sessions.push({ id: currentId, timestamp: currentCreatedAt, maxTimestamp: currentMaxTs, parentId: currentParentId, messageCount: currentMessageCount });
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
      message_count: s.messageCount,
      storage: "other",
      parentSessionId: s.parentId,
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
    message_count: best.messageCount,
    storage: "other",
    parentSessionId: best.parentId,
  };
}

function parseCodexSessionInner(filePath: string, entry: OtherAgentEntry): SessionSummary {
  const lines = splitJsonlLines(readFileSync(filePath, "utf8"));
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
        // BUG-8: clean the full text (strip fences/backticks) BEFORE taking
        // the first line, so a leading markdown fence is not picked as title.
        const text = extractContentTextCodex(payload.content);
        if (text) {
          const cleaned = cleanCodexTitle(text);
          if (cleaned) {
            title = cleaned;
          }
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
  const parentId = readCodexParentId(sessionMeta.payload);

  return {
    id: resolvedSessionId,
    agent: "codex",
    alias: entry.alias,
    title: resolvedTitle,
    created_at: createdAt,
    updated_at: maxTimestamp,
    message_count: messageCount,
    storage: "other",
    parentSessionId: parentId,
  };
}

function parseJsonLine(line: string, filePath: string, lineNumber: number): CodexRecord {
  try {
    return JSON.parse(line) as CodexRecord;
  } catch (error) {
    throw new Error(`Codex JSONL parse error in ${filePath} at line ${lineNumber}`);
  }
}

function extractContentText(content: unknown): string | undefined {
  return extractContentTextCodex(content);
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

/** Codex uses parent_thread_id in current rollout headers; parent_id is legacy. */
function readCodexParentId(payload: Record<string, unknown> | undefined): string | undefined {
  const source = payload?.source;
  const subagent = source && typeof source === "object" && !Array.isArray(source)
    ? (source as Record<string, unknown>).subagent : undefined;
  const spawn = subagent && typeof subagent === "object" && !Array.isArray(subagent)
    ? (subagent as Record<string, unknown>).thread_spawn : undefined;
  const nested = spawn && typeof spawn === "object" && !Array.isArray(spawn)
    ? (spawn as Record<string, unknown>).parent_thread_id : undefined;
  const parent = readOptionalString(payload?.parent_thread_id)
    ?? readOptionalString(nested)
    ?? readOptionalString(payload?.parent_id);
  return parent && parent !== readOptionalString(payload?.id) ? parent : undefined;
}

/** Empty sentinel returned when a JSONL file has parse errors — callers skip empty ids. */
const EMPTY_CODEX_SESSION: SessionSummary = Object.freeze({
  id: "",
  agent: "codex",
  alias: "",
  title: "",
  created_at: "",
  updated_at: "",
  message_count: 0,
  storage: "other",
});

function preferTitle(
  metaTitle: string | undefined,
  fallbackTitle: string | undefined,
  sessionId: string
): string {
  if (metaTitle && metaTitle.length > 0) return metaTitle;
  if (fallbackTitle && fallbackTitle.length > 0) {
    return cleanCodexTitle(fallbackTitle) || sessionId;
  }
  return sessionId;
}

/**
 * BUG-8: sanitize an extracted title — take the first non-empty line,
 * strip markdown fences/backticks, and cap the length at 120 chars.
 * Applied to BOTH JSONL-extracted titles and SQLite threads.title
 * (live DBs contain multi-KB fenced blobs in title).
 */
function cleanCodexTitle(text: string, max = 120): string {
  const stripped = text.replace(/`{3,}/g, "").replace(/`+/g, "").trim();
  const first = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first ? first.slice(0, max) : "";
}

/**
 * Apply SessionReadOptions to parsed messages — mirrors claude.ts verbatim
 * (BUG-1/4/5/6: codex previously ignored read options entirely).
 * Order: (a) last_message slice; (b) all_no_tools strip; (c) selection
 * first/last/range slices; (d) userOnly + role filtering.
 */
function applyCodexReadOptions(
  messages: SessionMessage[],
  opts: SessionReadOptions
): SessionMessage[] {
  // Only last_message overrides selection; tool visibility is independent.
  if (opts.mode === "last_message") {
    return messages.slice(-1);
  }
  if (opts.mode === "all_no_tools") {
    messages = messages.map((m) => ({
      ...m,
      parts: m.parts.filter((p) => p.type !== "tool"),
    }));
  }
  // Always apply selection and role filters, even when tools are hidden.

  // Apply selection mode (mirrors claude/zcode/hermes/pi verbatim)
  const selection = opts.selection;
  if (selection) {
    switch (selection.mode) {
      case "first":
        messages = messages.slice(0, selection.count);
        break;
      case "last":
        messages =
          selection.count === 0
            ? messages
            : messages.slice(-(selection.count ?? 10));
        break;
      case "range": {
        const start = (selection.start ?? 1) - 1;
        const end = selection.end ?? messages.length;
        messages = messages.slice(start, end);
        break;
      }
      case "all":
      default:
        break;
    }
  }

  // Apply role-based filtering (mirrors claude/zcode/hermes/pi verbatim)
  const effectiveUserOnly = opts.userOnly || opts.selection?.userOnly;
  if (effectiveUserOnly) {
    if (opts.role && opts.role !== "user") {
      messages = [];
    } else {
      messages = messages.filter((m) => m.role === "user");
    }
  } else if (opts.role) {
    messages = messages.filter((m) => m.role === opts.role);
  }
  return messages;
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
  const lines = splitJsonlLines(readFileSync(filePath, "utf8"));
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
    const textParts = extractContentPartsCodex(content);

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

export { extractContentPartsCodex };

interface SqliteThreadRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  model: string | null;
  cwd: string;
  parent_id: string | null;
  rollout_path?: string | null;
}

/**
 * Codex schema varies between versions: some SQLite databases do not have
 * threads.source or thread_spawn_edges. Inspect once per opened connection.
 * When both are present, source JSON takes priority because edge coverage
 * is incomplete on real Codex stores.
 */
function codexParentQuery(db: Database): { projection: string; join: string } {
  const hasSource = db.query<{ name: string }, []>("PRAGMA table_info(threads)").all()
    .some((column) => column.name === "source");
  const hasEdges = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_spawn_edges'"
  ).get() !== null;
  const sourceParent = hasSource
    ? "CASE WHEN json_valid(t.source) THEN CASE WHEN json_type(t.source, '$.subagent.thread_spawn.parent_thread_id') = 'text' THEN json_extract(t.source, '$.subagent.thread_spawn.parent_thread_id') END END"
    : "NULL";
  const edgeParent = hasEdges ? "e.parent_thread_id" : "NULL";
  return {
    projection: `COALESCE(${sourceParent}, ${edgeParent}) AS parent_id`,
    join: hasEdges ? "LEFT JOIN thread_spawn_edges e ON e.child_thread_id = t.id" : "",
  };
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
/**
 * BUG-9: Count user/assistant response_items for a rollout JSONL file in a
 * single streaming pass. Returns 0 for missing/unreadable/corrupt files
 * (list must never throw on per-row failures).
 */
function countCodexRolloutMessages(rolloutPath: string): number {
  try {
    let count = 0;
    const lines = splitJsonlLines(readFileSync(rolloutPath, "utf8"));
    for (const raw of lines) {
      if (raw.trim().length === 0) continue;
      let record: CodexRecord;
      try {
        record = JSON.parse(raw) as CodexRecord;
      } catch {
        continue; // corrupt line — skip, keep counting the rest
      }
      if (record.type !== "response_item") continue;
      const role = record.payload?.role;
      if (role === "user" || role === "assistant") count += 1;
    }
    return count;
  } catch {
    return 0; // missing/unreadable file — keep 0, do not throw
  }
}

/**
 * BUG-9: Per-file count cache. Keyed by file path + size + mtime so unchanged
 * files are not re-read across repeated list calls. Bounded to 4096 entries.
 */
const rolloutCountCache = new Map<string, { size: number; mtimeMs: number; count: number }>();

function countCodexRolloutMessagesCached(rolloutPath: string): number {
  const stat = safeStat(rolloutPath);
  if (!stat || !stat.isFile()) return 0;
  const cached = rolloutCountCache.get(rolloutPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.count;
  }
  const count = countCodexRolloutMessages(rolloutPath);
  if (rolloutCountCache.size >= 4096) {
    // Drop the oldest entry (insertion order) to keep the map bounded.
    const oldest = rolloutCountCache.keys().next().value;
    if (oldest !== undefined) rolloutCountCache.delete(oldest);
  }
  rolloutCountCache.set(rolloutPath, {
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    count,
  });
  return count;
}

/**
 * Codex schema varies between versions: older state_5.sqlite files may not
 * have threads.rollout_path. Probe once per connection so BUG-9 counting
 * degrades to "no rollout path" instead of failing the whole query.
 */
function codexRolloutColumn(db: Database): string {
  const hasRollout = db
    .query<{ name: string }, []>("PRAGMA table_info(threads)")
    .all()
    .some((column) => column.name === "rollout_path");
  return hasRollout ? "t.rollout_path" : "NULL AS rollout_path";
}

function listSessionsByTimeRangeFromSqlite(
  dbPath: string,
  entry: OtherAgentEntry,
  options: { since: number; until?: number; limit: number; skipSessionId?: string },
  label: string
): SessionSummary[] {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    throw new Error(
      `${label} failed to open SQLite DB ${dbPath}: ${errorMessage(error)}`
    );
  }

  try {
    // Build the WHERE clause with indexed columns.
    // idx_threads_updated_at covers (updated_at DESC, id DESC) — used for ORDER BY + range.
    const conditions: string[] = ["updated_at >= ?"];
    const params: (string | number)[] = [options.since / 1000]; // convert ms → Unix seconds
    if (options.until !== undefined) {
      conditions.push("updated_at <= ?");
      params.push(options.until / 1000);
    }

    // Exclude the cursor session so it doesn't reappear on the next page (F2/F6)
    if (options.skipSessionId !== undefined) {
      conditions.push("id != ?");
      params.push(options.skipSessionId);
    }

    const limitClause = options.limit > 0 ? ` LIMIT ${options.limit}` : ""; // 0 = no cap
    const { projection, join } = codexParentQuery(db);
    const rolloutColumn = codexRolloutColumn(db);
    const sql = `
      SELECT t.id, t.title, t.created_at, t.updated_at, t.model, t.cwd, ${rolloutColumn}, ${projection}
      FROM threads t ${join}
      WHERE ${conditions.join(" AND ")}
      ORDER BY t.updated_at DESC, t.id DESC
      ${limitClause}
    `;

    let rows: (SqliteThreadRow & { rollout_path: string | null })[];
    try {
      rows = db.query<
        SqliteThreadRow & { rollout_path: string | null },
        (string | number)[]
      >(sql).all(...params);
    } catch (error) {
      throw new Error(
        `${label} SQLite query failed: ${errorMessage(error)}`
      );
    }

    return rows.map((row) => {
      const rolloutPath = row.rollout_path?.trim();
      return {
        id: row.id,
        agent: "codex",
        alias: entry.alias,
        title: cleanCodexTitle(row.title) || row.id, // BUG-8: sanitize DB titles too
        created_at: formatUnixSeconds(row.created_at),
        updated_at: formatUnixSeconds(row.updated_at),
        // BUG-9: real counts derived from each row's rollout JSONL. Files that
        // are missing/unreadable (e.g. absolute paths from another machine)
        // keep 0 — no throw, no rescan-all.
        message_count: rolloutPath
          ? countCodexRolloutMessagesCached(rolloutPath)
          : 0,
        storage: "other",
        ...(typeof row.parent_id === "string" && row.parent_id !== row.id && row.parent_id.length > 0
          ? { parentSessionId: row.parent_id } : {}),
      };
    });
  } finally {
    db.close();
  }
}

/**
 * F2: SQLite-backed session detail.
 *
 * Codex's state_5.sqlite stores sessions in the `threads` table, but the actual
 * messages are in JSONL files referenced by the `rollout_path` column.
 * This function:
 *   1. Looks up the thread row by session ID to get title/timestamps/rollout_path
 *   2. Falls back to a JSONL search if rollout_path is unavailable or invalid
 *   3. Parses the JSONL for full message content
 */
async function getSessionDetailFromSqlite(
  dbPath: string,
  sessionId: string,
  entry: OtherAgentEntry,
  readOptions: SessionReadOptions,
  label: string
): Promise<SessionDetail> {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    throw new Error(
      `${label} failed to open SQLite DB ${dbPath}: ${errorMessage(error)}`
    );
  }

  try {
    const { projection, join } = codexParentQuery(db);
    const sql = `SELECT t.id, t.title, t.created_at, t.updated_at, t.rollout_path, ${projection}
                FROM threads t ${join} WHERE t.id = ?`;
    const rows = db.query<SqliteThreadRow & {
      rollout_path: string | null;
    }, [string]>(sql).all(sessionId);

    if (rows.length === 0) {
      throw new Error(`${label} session not found: ${sessionId}`);
    }

    const row = rows[0];
    const summary: SessionSummary = {
      id: row.id,
      agent: "codex",
      alias: entry.alias,
      title: cleanCodexTitle(row.title) || row.id, // BUG-8: sanitize DB titles too
      created_at: formatUnixSeconds(row.created_at),
      updated_at: formatUnixSeconds(row.updated_at),
      message_count: 0,
      storage: "other",
      ...(typeof row.parent_id === "string" && row.parent_id !== row.id && row.parent_id.length > 0
        ? { parentSessionId: row.parent_id } : {}),
    };

    // Try to load messages from the rollout_path JSONL file
    const rolloutPath = row.rollout_path?.trim();
    if (rolloutPath && rolloutPath.length > 0) {
      try {
        const messages = applyCodexReadOptions(
          parseCodexMessages(rolloutPath, sessionId, label),
          readOptions
        );
        return { ...summary, messages, message_count: messages.length };
      } catch {
        // Rollout path exists but unreadable/parseable — fall through
      }
    }

    // Fallback: search JSONL files if rollout_path is missing or failed
    const fallback = await getSessionDetailFromJsonlFallback(
      sessionId, entry, label
    );
    const fallbackMessages = applyCodexReadOptions(fallback.messages, readOptions);
    return { ...summary, message_count: fallbackMessages.length, messages: fallbackMessages };
  } finally {
    db.close();
  }
}

/**
 * Fallback JSONL search for SQLite-backed getSessionDetail.
 * Used when rollout_path is empty or the JSONL file can't be read.
 * Searches ~/.codex/sessions/ recursively for a matching session ID.
 */
async function getSessionDetailFromJsonlFallback(
  sessionId: string,
  entry: OtherAgentEntry,
  label: string
): Promise<{ messages: SessionMessage[] }> {
  const fallbackRoot = join(homedir(), ".codex", "sessions");
  const files = collectJsonlFiles(fallbackRoot);

  for (const filePath of files) {
    try {
      const summary = parseCodexSession(filePath, entry);
      if (summary.id === sessionId) {
        const messages = parseCodexMessages(filePath, sessionId, label);
        return { messages };
      }
    } catch {
      // Skip files that fail to parse
    }
  }

  // No messages found — return empty array (summary was built from DB)
  return { messages: [] };
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

  const label = createLabel(entry);

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
  const lines = splitJsonlLines(readFileSync(filePath, "utf8"));
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
          // BUG-8: clean before taking the first line (strip fences/backticks).
          const text = extractContentText(payload.content);
          if (text) {
            const cleaned = cleanCodexTitle(text);
            if (cleaned) {
              title = cleaned;
            }
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
