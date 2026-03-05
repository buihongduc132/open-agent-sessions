import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { OpenCodeAgentEntry } from "../config/types";
import {
  Adapter,
  SearchQuery,
  SessionDetail,
  SessionMessage,
  SessionPart,
  SessionReadOptions,
  SessionSummary,
} from "../core/types";

type OpenCodeAdapterOptions = {
  cwd?: string;
};

type SessionRow = {
  id: string;
  project_id: string;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
};

type MessageRow = {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
};

type PartRow = {
  id: string;
  message_id: string;
  session_id: string;
  data: string;
};

type ProjectRow = {
  id: string;
  worktree: string;
};

export function createOpenCodeAdapter(
  entry: OpenCodeAgentEntry,
  options: OpenCodeAdapterOptions = {}
): Adapter {
  if (entry.agent !== "opencode") {
    throw new Error(`OpenCode adapter requires agent "opencode", got "${entry.agent}"`);
  }

  const label = `[${entry.agent}:${entry.alias}]`;
  const dbPath = resolveDbPath(entry, options);
  const cwd = options.cwd ?? process.cwd();

  const db = openDatabase(dbPath, label);

  return {
    listSessions: () => listSessions(db, entry, cwd, label),
    searchSessions: (query: SearchQuery) => searchSessions(db, entry, query, label),
    getSessionDetail: (sessionId: string, opts: SessionReadOptions) =>
      getSessionDetail(db, entry, sessionId, opts, label),
  };
}

function resolveDbPath(entry: OpenCodeAgentEntry, options: OpenCodeAdapterOptions): string {
  const configured = entry.storage.db_path;
  if (configured) {
    const expanded = expandTilde(configured);
    const resolved = isAbsolute(expanded) ? expanded : resolve(options.cwd ?? process.cwd(), expanded);
    if (!existsSync(resolved)) {
      throw new Error(`OpenCode db_path not found: ${resolved}`);
    }
    return resolved;
  }

  const defaultPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(defaultPath)) {
    throw new Error(`OpenCode db_path not found: ${defaultPath}`);
  }
  return defaultPath;
}

function openDatabase(path: string, label: string): Database {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      throw new Error(`${label} db_path is not a file: ${path}`);
    }
    return new Database(path, { readonly: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes(label)) {
      throw error;
    }
    throw new Error(`${label} failed to open database: ${path}`);
  }
}

function listSessions(
  db: Database,
  entry: OpenCodeAgentEntry,
  cwd: string,
  label: string
): SessionSummary[] {
  const projectId = findProjectId(db, cwd);
  if (!projectId) {
    return [];
  }

  const sessions = db
    .query<SessionRow, [string]>(
      `SELECT id, project_id, directory, title, time_created, time_updated
       FROM session
       WHERE project_id = ?
       ORDER BY time_updated DESC`
    )
    .all(projectId);

  return sessions.map((row) => {
    const messageCount = countMessages(db, row.id);
    return {
      id: row.id,
      agent: "opencode",
      alias: entry.alias,
      title: row.title,
      created_at: formatTimestamp(row.time_created),
      updated_at: formatTimestamp(row.time_updated),
      message_count: messageCount,
      storage: "db",
    };
  });
}

function searchSessions(
  db: Database,
  entry: OpenCodeAgentEntry,
  query: SearchQuery,
  label: string
): SessionSummary[] {
  const cwd = query.cwd ?? process.cwd();
  const projectId = findProjectId(db, cwd);
  if (!projectId) {
    return [];
  }

  const searchPattern = `%${query.text.toLowerCase()}%`;

  const sessionsByTitle = db
    .query<SessionRow, [string, string]>(
      `SELECT id, project_id, directory, title, time_created, time_updated
       FROM session
       WHERE project_id = ? AND LOWER(title) LIKE ?
       ORDER BY time_updated DESC`
    )
    .all(projectId, searchPattern);

  const sessionsByContent = db
    .query<SessionRow, [string, string]>(
      `SELECT DISTINCT s.id, s.project_id, s.directory, s.title, s.time_created, s.time_updated
       FROM session s
       JOIN part p ON p.session_id = s.id
       WHERE s.project_id = ? AND LOWER(p.data) LIKE ?
       ORDER BY s.time_updated DESC`
    )
    .all(projectId, searchPattern);

  const seen = new Set(sessionsByTitle.map((s) => s.id));
  const combined = [...sessionsByTitle];
  for (const row of sessionsByContent) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      combined.push(row);
    }
  }

  combined.sort((a, b) => b.time_updated - a.time_updated);

  return combined.map((row) => {
    const messageCount = countMessages(db, row.id);
    return {
      id: row.id,
      agent: "opencode",
      alias: entry.alias,
      title: row.title,
      created_at: formatTimestamp(row.time_created),
      updated_at: formatTimestamp(row.time_updated),
      message_count: messageCount,
      storage: "db",
    };
  });
}

async function getSessionDetail(
  db: Database,
  entry: OpenCodeAgentEntry,
  sessionId: string,
  options: SessionReadOptions,
  label: string
): Promise<SessionDetail> {
  const session = db
    .query<SessionRow, [string]>(
      `SELECT id, project_id, directory, title, time_created, time_updated
       FROM session
       WHERE id = ?`
    )
    .get(sessionId);

  if (!session) {
    throw new Error(`${label} session not found: ${sessionId}`);
  }

  const messageCount = countMessages(db, sessionId);
  const baseSummary: SessionSummary = {
    id: session.id,
    agent: "opencode",
    alias: entry.alias,
    title: session.title,
    created_at: formatTimestamp(session.time_created),
    updated_at: formatTimestamp(session.time_updated),
    message_count: messageCount,
    storage: "db",
  };

  if (options.mode === "last_message") {
    const messages = getMessages(db, sessionId, { lastOnly: true });
    return { ...baseSummary, messages };
  }

  if (options.mode === "all_no_tools") {
    const messages = getMessages(db, sessionId, { excludeTools: true });
    return { ...baseSummary, messages };
  }

  const messages = getMessages(db, sessionId, { includeAll: true });
  return { ...baseSummary, messages };
}

function findProjectId(db: Database, cwd: string): string | null {
  const normalizedCwd = resolve(cwd);

  const project = db
    .query<ProjectRow, []>("SELECT id, worktree FROM project")
    .all()
    .find((p) => resolve(p.worktree) === normalizedCwd);

  return project?.id ?? null;
}

function countMessages(db: Database, sessionId: string): number {
  const result = db
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) as count FROM message WHERE session_id = ?`
    )
    .get(sessionId);
  return result?.count ?? 0;
}

function getMessages(
  db: Database,
  sessionId: string,
  options: { lastOnly?: boolean; excludeTools?: boolean; includeAll?: boolean }
): SessionMessage[] {
  let query = `
    SELECT id, session_id, time_created, data
    FROM message
    WHERE session_id = ?
    ORDER BY time_created ASC
  `;

  if (options.lastOnly) {
    query = `
      SELECT id, session_id, time_created, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created DESC
      LIMIT 1
    `;
  }

  const messages = db.query<MessageRow, [string]>(query).all(sessionId);

  if (options.lastOnly && messages.length > 0) {
    messages.reverse();
  }

  return messages.map((row) => {
    const data = JSON.parse(row.data) as { role?: string };
    const parts = getParts(db, row.id, options);

    return {
      id: row.id,
      role: normalizeRole(data.role),
      created_at: formatTimestamp(row.time_created),
      parts,
    };
  });
}

function getParts(
  db: Database,
  messageId: string,
  options: { excludeTools?: boolean; includeAll?: boolean }
): SessionPart[] {
  const parts = db
    .query<PartRow, [string]>(
      `SELECT id, message_id, session_id, data
       FROM part
       WHERE message_id = ?
       ORDER BY time_created ASC`
    )
    .all(messageId);

  return parts
    .map((row) => {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      const type = (data.type as string) ?? "unknown";

      if (type === "text") {
        return { type: "text", text: (data.text as string) ?? "" } as SessionPart;
      }

      if (type === "tool") {
        return {
          type: "tool",
          tool: (data.tool as string) ?? "unknown",
          state: (data.state as Record<string, unknown>) ?? {},
        } as SessionPart;
      }

      if (type === "reasoning") {
        return { type: "reasoning", text: (data.text as string) ?? "" } as SessionPart;
      }

      return { type, ...data } as SessionPart;
    })
    .filter((part) => {
      if (options.excludeTools && part.type === "tool") {
        return false;
      }
      if (options.excludeTools && part.type === "step-start") {
        return false;
      }
      if (options.excludeTools && part.type === "step-finish") {
        return false;
      }
      return true;
    });
}

function normalizeRole(role?: string): "user" | "assistant" | "system" {
  if (role === "user" || role === "assistant" || role === "system") {
    return role;
  }
  return "user";
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
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
