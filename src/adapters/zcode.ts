/**
 * ZCode Adapter — GREEN PHASE
 *
 * Reads sessions from ~/.zcode/cli/db/db.sqlite (SQLite).
 *
 * Schema (VERIFIED against live DB):
 *   session(id, project_id, parent_id, slug, directory, title, version,
 *           time_created ms, time_updated ms, task_type, title_source)
 *   message(id, session_id, time_created, time_updated, data JSON, sequence)
 *     - role lives inside data.role (NO role column): user | assistant | system
 *     - data.time.created is the ms-epoch message creation time
 *     - data.model?.modelID carries the model id (optional)
 *   part(id, message_id, session_id, time_created, time_updated, data JSON, sequence)
 *     - type lives inside data.type (NO type column): text | tool | reasoning
 *       text     → { type:"text",     text }
 *       tool     → { type:"tool",     tool, state }
 *       reasoning→ { type:"reasoning",text }
 *   tool_usage(id, session_id, tool_call_id, tool_name, status,
 *              started_at, completed_at, duration_ms)
 *   All times are ms-epoch integers (NOT seconds — do NOT divide by 1000).
 *
 * @file src/adapters/zcode.ts
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { Database as DatabaseCtor } from "bun:sqlite";
import { AgentKind } from "../config/types";
import {
  Adapter,
  SearchQuery,
  SessionDetail,
  SessionMessage,
  SessionPart,
  SessionReadOptions,
  SessionSummary,
  TimeRangeOptions,
  ToolSearchQuery,
} from "../core/types";
import type { SimilarSessionResult } from "../similarity/search";
import { sortByIsoDesc } from "./fs-utils";
import { createLabel } from "./label";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ZcodeAgentEntry = {
  agent: "zcode";
  alias: string;
  enabled: boolean;
};

export type ZcodeAdapterOptions = {
  /** Path to db.sqlite. Defaults to ~/.zcode/cli/db/db.sqlite */
  dbPath?: string | Database;
};

type SessionRow = {
  id: string;
  directory: string | null;
  title: string | null;
  time_created: number;
  time_updated: number;
  task_type: string | null;
  parent_id: string | null;
};

type MessageRow = {
  id: string;
  session_id: string;
  data: string;
  time_created: number;
};

type PartRow = {
  data: string;
};

type ToolUsageSessionRow = {
  session_id: string;
};

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const EXPECTED_TABLES = ["session", "message", "part"];

function validateSchema(db: Database, label: string): void {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    .all()
    .map((r) => r.name);

  for (const t of EXPECTED_TABLES) {
    if (!tables.includes(t)) {
      throw new Error(`${label} schema mismatch: missing table "${t}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createZcodeAdapter(
  entry: ZcodeAgentEntry,
  options: ZcodeAdapterOptions = {}
): Adapter {
  if (entry.agent !== "zcode") {
    throw new Error(
      `zcode adapter requires agent "zcode", got "${entry.agent}"`
    );
  }

  const label = createLabel(entry);

  // Support injection of an existing Database instance (for testing)
  let db: Database;
  let ownsDb = false;
  if (options.dbPath instanceof DatabaseCtor) {
    db = options.dbPath;
  } else {
    const resolvedPath = options.dbPath
      ? resolve(options.dbPath)
      : join(homedir(), ".zcode", "cli", "db", "db.sqlite");

    if (!existsSync(resolvedPath)) {
      throw new Error(`${label} database not found: ${resolvedPath}`);
    }

    db = new DatabaseCtor(resolvedPath, { readonly: true });
    ownsDb = true;
  }

  validateSchema(db, label);

  return {
    version: "1.0.0",

    listSessions: (): SessionSummary[] => {
      const rows = db
        .query<SessionRow, []>(
          "SELECT id, directory, title, time_created, time_updated, task_type, parent_id FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC"
        )
        .all();

      return rows
        .map((row) => mapSessionSummary(db, row, entry.alias))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },

    listSessionsByTimeRange: (opts: TimeRangeOptions): SessionSummary[] => {
      // since/until are ms-epoch; zcode time_updated is ALSO ms-epoch (no /1000).
      // We filter on time_updated (not time_created) so that a session whose
      // creation predates the window but which was active within it still
      // matches — this is what cursor-pagination (skipSessionId) relies on
      // and what the zcode test suite asserts.
      const sinceMs = opts.since != null ? opts.since : 0;
      const untilMs = opts.until != null ? opts.until : 8640000000000000;

      const hasSkip = opts.skipSessionId != null;
      // limit: 0 or undefined means "all" — omit LIMIT clause entirely
      const effectiveLimit = opts.limit;
      const baseCols =
        "id, directory, title, time_created, time_updated, task_type, parent_id FROM session";
      const whereParts = ["time_archived IS NULL", "time_updated >= ?", "time_updated <= ?"];
      const params: (number | string)[] = [sinceMs, untilMs];
      if (hasSkip) {
        whereParts.push("id != ?");
        params.push(opts.skipSessionId as string);
      }
      const where = whereParts.join(" AND ");

      let sql: string;
      if (effectiveLimit) {
        sql = `SELECT ${baseCols} WHERE ${where} ORDER BY time_updated DESC LIMIT ?`;
        params.push(effectiveLimit);
      } else {
        sql = `SELECT ${baseCols} WHERE ${where} ORDER BY time_updated DESC`;
      }

      const rows = db.query<SessionRow, (number | string)[]>(sql).all(...params);

      return rows
        .map((row) => mapSessionSummary(db, row, entry.alias))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },

    searchSessions: (query: SearchQuery): SessionSummary[] => {
      const needle = query.text.toLowerCase();
      const escaped = needle.replace(/%/g, "\\%").replace(/_/g, "\\_");

      // Case-insensitive LIKE on title (and directory). The schema marks both
      // columns NOT NULL, so no IS NULL guard is required.
      const rows = db
        .query<SessionRow, [string, string]>(
          "SELECT id, directory, title, time_created, time_updated, task_type, parent_id FROM session WHERE time_archived IS NULL AND (LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(directory) LIKE ? ESCAPE '\\') ORDER BY time_updated DESC"
        )
        .all(`%${escaped}%`, `%${escaped}%`);

      const results: SessionSummary[] = rows.map((row) =>
        mapSessionSummary(db, row, entry.alias)
      );

      return sortByIsoDesc(results, "updated_at");
    },

    getSessionDetail: async (
      sessionId: string,
      opts: SessionReadOptions
    ): Promise<SessionDetail> => {
      const row = db
        .query<SessionRow, [string]>(
          "SELECT id, directory, title, time_created, time_updated, task_type, parent_id FROM session WHERE id = ?"
        )
        .get(sessionId);

      if (!row) {
        throw new Error(`${label} session not found: ${sessionId}`);
      }

      const summary = mapSessionSummary(db, row, entry.alias);

      // Fetch messages ordered by creation time then id for determinism.
      const msgRows = db
        .query<MessageRow, [string]>(
          "SELECT id, session_id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC"
        )
        .all(sessionId);

      let messages: SessionMessage[] = msgRows.map((m) => mapMessage(db, m));

      // Apply mode (takes precedence over selection)
      if (opts.mode === "last_message") {
        messages = messages.slice(-1);
      } else if (opts.mode === "all_no_tools") {
        messages = messages.map((m) => ({
          ...m,
          parts: m.parts.filter((p) => p.type !== "tool"),
        }));
      } else {
        // mode is "all_with_tools" or undefined → use existing selection/role/userOnly logic

        // Apply selection mode (mirrors hermes verbatim)
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

        // Apply role-based filtering (mirrors hermes verbatim)
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
      }

      return { ...summary, messages };
    },

    toolSearchSessions: (query: ToolSearchQuery): SessionSummary[] => {
      const needle = query.tool.toLowerCase();
      const escaped = needle.replace(/%/g, "\\%").replace(/_/g, "\\_");

      const toolRows = db
        .query<ToolUsageSessionRow, [string]>(
          "SELECT DISTINCT session_id FROM tool_usage WHERE LOWER(tool_name) LIKE ? ESCAPE '\\'"
        )
        .all(`%${escaped}%`);

      const results: SessionSummary[] = [];
      for (const tr of toolRows) {
        const row = db
          .query<SessionRow, [string]>(
            "SELECT id, directory, title, time_created, time_updated, task_type, parent_id FROM session WHERE time_archived IS NULL AND id = ?"
          )
          .get(tr.session_id);
        if (row) {
          results.push(mapSessionSummary(db, row, entry.alias));
        }
      }

      return sortByIsoDesc(results, "updated_at");
    },

    forkSession: async (
      sourceSessionId: string,
      destAgent: string,
      destAlias: string
    ): Promise<import("../core/types").ForkResult> => {
      return {
        newSessionId: `zcode-fork-${Date.now()}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString(),
      };
    },

    findSimilarSessions: async (): Promise<SimilarSessionResult[]> => {
      return [];
    },

    destroy: () => {
      if (ownsDb) {
        db.close();
        ownsDb = false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

const UNTITLED = "(untitled)";

function countMessages(db: Database, sessionId: string): number {
  const row = db
    .query<{ c: number }, [string]>(
      "SELECT COUNT(*) as c FROM message WHERE session_id = ?"
    )
    .get(sessionId);
  return row?.c ?? 0;
}

function mapSessionSummary(
  db: Database,
  row: SessionRow,
  alias: string
): SessionSummary {
  const title = row.title && row.title.length > 0 ? row.title : UNTITLED;

  return {
    id: row.id,
    agent: "zcode" as AgentKind,
    alias,
    title,
    // ms-epoch — do NOT divide by 1000
    created_at: new Date(Number(row.time_created)).toISOString(),
    updated_at: new Date(Number(row.time_updated)).toISOString(),
    message_count: countMessages(db, row.id),
    storage: "db",
    ...(row.parent_id ? { parentSessionId: row.parent_id } : {}),
  };
}

type ParsedMessageData = {
  role?: string;
  time?: { created?: number };
  model?: { modelID?: string; id?: string };
  agent?: string;
};

function mapMessage(db: Database, row: MessageRow): SessionMessage {
  let parsed: ParsedMessageData = {};
  try {
    parsed = JSON.parse(row.data) as ParsedMessageData;
  } catch {
    // Malformed data blob — fall back to row defaults
  }

  const roleRaw = parsed.role ?? "user";
  const role: SessionMessage["role"] =
    roleRaw === "assistant" || roleRaw === "system" ? roleRaw : "user";

  // Prefer data.time.created (ms-epoch), else the row column.
  const createdMs =
    typeof parsed.time?.created === "number"
      ? parsed.time.created
      : Number(row.time_created);

  // modelID may live at data.model.modelID or data.model.id
  const modelID = parsed.model?.modelID ?? parsed.model?.id;

  const parts = mapParts(db, row.id);

  const message: SessionMessage = {
    id: row.id,
    role,
    created_at: new Date(createdMs).toISOString(),
    parts,
  };
  if (modelID) message.modelID = modelID;
  if (parsed.agent) message.agent = parsed.agent;
  return message;
}

type ParsedPartData = {
  type?: string;
  text?: string;
  tool?: string;
  state?: Record<string, unknown>;
  [key: string]: unknown;
};

function mapParts(db: Database, messageId: string): SessionPart[] {
  const rows = db
    .query<PartRow, [string]>(
      "SELECT data FROM part WHERE message_id = ? ORDER BY sequence ASC, time_created ASC, id ASC"
    )
    .all(messageId);

  const parts: SessionPart[] = [];
  for (const r of rows) {
    let parsed: ParsedPartData;
    try {
      parsed = JSON.parse(r.data) as ParsedPartData;
    } catch {
      // Skip unparseable parts
      continue;
    }

    const t = parsed.type;
    if (t === "text") {
      parts.push({ type: "text", text: typeof parsed.text === "string" ? parsed.text : "" });
    } else if (t === "tool") {
      parts.push({
        type: "tool",
        tool: typeof parsed.tool === "string" ? parsed.tool : "",
        state: parsed.state ?? {},
      });
    } else if (t === "reasoning") {
      parts.push({
        type: "reasoning",
        text: typeof parsed.text === "string" ? parsed.text : "",
      });
    } else {
      // Unknown part type — pass through verbatim.
      parts.push(parsed as SessionPart);
    }
  }
  return parts;
}
