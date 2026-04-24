/**
 * Hermes Adapter — R-43, R-44, R-45
 *
 * Reads sessions from ~/.hermes/state.db (SQLite WAL mode, schema v6).
 *
 * Schema:
 *   sessions: id, source, model, title (nullable), parent_session_id,
 *             started_at (unix sec), ended_at, message_count, tool_call_count, tokens...
 *   messages: id, session_id, role (user/assistant/tool), content, tool_calls (JSON),
 *             tool_name, timestamp, reasoning, reasoning_details (JSON)
 *   messages_fts: FTS5 on messages.content
 *
 * @file src/adapters/hermes.ts
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
import { containsIgnoreCase, sortByIsoDesc } from "./fs-utils";
import { createLabel } from "./label";
import { errorMessage } from "../core/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HermesAgentEntry = {
  agent: "hermes";
  alias: string;
  enabled: boolean;
};

export type HermesAdapterOptions = {
  /** Path to state.db. Defaults to ~/.hermes/state.db */
  dbPath?: string | Database;
};

type SessionRow = {
  id: string;
  source: string;
  model: string;
  title: string | null;
  parent_session_id: string | null;
  started_at: number;
  ended_at: number | null;
  message_count: number;
  tool_call_count: number;
};

type MessageRow = {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  tool_name: string | null;
  tool_calls: string | null;
  reasoning: string | null;
  timestamp: number;
};

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const EXPECTED_TABLES = ["sessions", "messages"];

function validateSchema(db: Database, label: string): void {
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%'")
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

export function createHermesAdapter(
  entry: HermesAgentEntry,
  options: HermesAdapterOptions = {}
): Adapter {
  if (entry.agent !== "hermes") {
    throw new Error(`[hermes:${entry.alias}] hermes adapter requires agent "hermes", got "${entry.agent}"`);
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
      : join(homedir(), ".hermes", "state.db");

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
          "SELECT id, source, model, title, parent_session_id, started_at, ended_at, message_count, tool_call_count FROM sessions ORDER BY started_at DESC"
        )
        .all();

      return rows.map((row) => mapSessionSummary(db, row, entry.alias, label)).sort((a, b) =>
        b.updated_at.localeCompare(a.updated_at)
      );
    },

    listSessionsByTimeRange: (opts: TimeRangeOptions): SessionSummary[] => {
      // since/until are in milliseconds; hermes started_at is unix seconds
      const sinceSec = opts.since != null ? opts.since / 1000 : 0;
      const untilSec = opts.until != null ? opts.until / 1000 : 4102444800;

      const rows = db
        .query<SessionRow, [number, number, number]>(
          "SELECT id, source, model, title, parent_session_id, started_at, ended_at, message_count, tool_call_count FROM sessions WHERE started_at >= ? AND started_at <= ? ORDER BY started_at DESC LIMIT ?",
        )
        .all(sinceSec, untilSec, opts.limit ?? 50);

      return rows.map((row) => mapSessionSummary(db, row, entry.alias, label)).sort((a, b) =>
        b.updated_at.localeCompare(a.updated_at)
      );
    },

    searchSessions: (query: SearchQuery): SessionSummary[] => {
      const needle = query.text.toLowerCase();
      const results: SessionSummary[] = [];

      // Search by title first (case-insensitive)
      const titleRows = db
        .query<SessionRow, []>(
          "SELECT id, source, model, title, parent_session_id, started_at, ended_at, message_count, tool_call_count FROM sessions WHERE title IS NOT NULL"
        )
        .all();

      for (const row of titleRows) {
        if (row.title && containsIgnoreCase(row.title, needle)) {
          results.push(mapSessionSummary(db, row, entry.alias, label));
        }
      }

      // Search by content via FTS5
      try {
        const ftsRows = db
          .query<{ session_id: string }, [string]>(
            "SELECT DISTINCT m.session_id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?"
          )
          .all(query.text);

        const ftsSessionIds = new Set<string>(ftsRows.map((r) => r.session_id));
        for (const sid of Array.from(ftsSessionIds)) {
          if (results.some((r) => r.id === sid)) continue;
          const row = db
            .query<SessionRow, [string]>(
              "SELECT id, source, model, title, parent_session_id, started_at, ended_at, message_count, tool_call_count FROM sessions WHERE id = ?"
            )
            .get(sid);
          if (row) {
            results.push(mapSessionSummary(db, row, entry.alias, label));
          }
        }
      } catch {
        // FTS5 query may fail on special chars — fall back to title-only results
      }

      return sortByIsoDesc(results, "updated_at");
    },

    getSessionDetail: async (
      sessionId: string,
      opts: SessionReadOptions
    ): Promise<SessionDetail> => {
      const row = db
        .query<SessionRow, [string]>(
          "SELECT id, source, model, title, parent_session_id, started_at, ended_at, message_count, tool_call_count FROM sessions WHERE id = ?"
        )
        .get(sessionId);

      if (!row) {
        throw new Error(`${label} session not found: ${sessionId}`);
      }

      const summary = mapSessionSummary(db, row, entry.alias, label);

      // Fetch messages ordered by timestamp
      const msgRows = db
        .query<MessageRow, [string]>(
          "SELECT id, session_id, role, content, tool_name, tool_calls, reasoning, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC"
        )
        .all(sessionId);

      let messages: SessionMessage[] = msgRows.map(mapMessage);

      // Apply selection mode
      const selection = opts.selection;
      if (selection) {
        switch (selection.mode) {
          case "first":
            messages = messages.slice(0, selection.count);
            break;
          case "last":
            messages = selection.count === 0 ? messages : messages.slice(-(selection.count ?? 10));
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

      // Apply role-based filtering
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

      return { ...summary, messages };
    },

    toolSearchSessions: (query: ToolSearchQuery): SessionSummary[] => {
      const needle = query.tool.toLowerCase();
      const results: SessionSummary[] = [];

      // Find sessions that have messages with tool_name matching
      const escaped = needle.replace(/%/g, "\\%").replace(/_/g, "\\_");
      const toolRows = db
        .query<{ session_id: string }, [string]>(
          "SELECT DISTINCT session_id FROM messages WHERE tool_name IS NOT NULL AND LOWER(tool_name) LIKE ? ESCAPE '\\'"
        )
        .all(`%${escaped}%`);

      for (const tr of toolRows) {
        const row = db
          .query<SessionRow, [string]>(
            "SELECT id, source, model, title, parent_session_id, started_at, ended_at, message_count, tool_call_count FROM sessions WHERE id = ?"
          )
          .get(tr.session_id);
        if (row) {
          results.push(mapSessionSummary(db, row, entry.alias, label));
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
        newSessionId: `hermes-fork-${Date.now()}`,
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

const MAX_TITLE_LENGTH = 80;

function mapSessionSummary(
  db: Database,
  row: SessionRow,
  alias: string,
  label: string
): SessionSummary {
  let title = row.title;
  if (!title) {
    title = deriveTitleFromFirstUserMessage(db, row.id, label);
  }

  // Compute updated_at
  let updatedAtMs: number;
  if (row.ended_at != null) {
    updatedAtMs = row.ended_at * 1000;
  } else {
    // Use latest message timestamp
    const latestMsg = db
      .query<{ ts: number }, [string]>(
        "SELECT MAX(timestamp) as ts FROM messages WHERE session_id = ?"
      )
      .get(row.id);
    updatedAtMs = latestMsg?.ts ? latestMsg.ts * 1000 : row.started_at * 1000;
  }

  return {
    id: row.id,
    agent: "hermes" as AgentKind,
    alias,
    title,
    created_at: new Date(row.started_at * 1000).toISOString(),
    updated_at: new Date(updatedAtMs).toISOString(),
    message_count: row.message_count,
    storage: "db",
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
  };
}

function deriveTitleFromFirstUserMessage(
  db: Database,
  sessionId: string,
  label: string
): string {
  try {
    const row = db
      .query<{ content: string }, [string]>(
        "SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND content IS NOT NULL ORDER BY timestamp ASC LIMIT 1"
      )
      .get(sessionId);

    if (row?.content) {
      const text = row.content.replace(/\n/g, " ").trim();
      if (text.length > MAX_TITLE_LENGTH) {
        return text.slice(0, MAX_TITLE_LENGTH - 3) + "...";
      }
      return text;
    }
  } catch {
    // Fall through to default
  }
  return `${label} session ${sessionId}`;
}

function mapMessage(row: MessageRow): SessionMessage {
  const parts: SessionPart[] = [];

  // Add reasoning part if present
  if (row.reasoning) {
    parts.push({ type: "reasoning", text: row.reasoning });
  }

  // Map content or tool
  if (row.role === "tool" && row.tool_name) {
    let state: Record<string, unknown> = {};
    if (row.content) {
      try {
        state = JSON.parse(row.content);
      } catch {
        state = { raw: row.content };
      }
    }
    parts.push({ type: "tool", tool: row.tool_name, state });
  } else if (row.content) {
    parts.push({ type: "text", text: row.content });
  }

  // Map hermes 'tool' role to 'assistant' for adapter contract compliance.
  // Tool metadata preserved in parts[].
  const role = row.role as SessionMessage["role"] | "tool";
  const mappedRole = role === "tool" ? "assistant" : role;

  return {
    id: String(row.id),
    role: mappedRole,
    created_at: new Date(row.timestamp * 1000).toISOString(),
    parts,
  };
}
