import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { resolveOpenCodeStorage } from "../config/opencode";
import { OpenCodeAgentEntry, OpenCodeStorageDefaults } from "../config/types";
import {
  Adapter,
  MessageSelectionOptions,
  SearchQuery,
  SessionDetail,
  SessionMessage,
  SessionPart,
  SessionReadOptions,
  SessionSummary,
  TimeRangeOptions,
} from "../core/types";

// Expected schema for validation
const EXPECTED_SCHEMA = {
  tables: {
    project: ["id", "worktree"],
    session: ["id", "project_id", "directory", "title", "time_created", "time_updated"],
    message: ["id", "session_id", "time_created", "data"],
    part: ["id", "message_id", "session_id", "data"],
  },
};

// Default retry delays for DB lock (total <= 500ms)
const DEFAULT_LOCK_RETRIES = [50, 100, 200];

type OpenCodeAdapterOptions = {
  cwd?: string;
  lockRetries?: number[];
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

type JsonlSessionRow = {
  id: string;
  projectID: string;
  directory: string;
  title?: string | null;
  timeCreated: number;
  timeUpdated: number;
};

type JsonlMessageRow = {
  id: string;
  sessionID: string;
  timeCreated: number;
  role?: string;
};

type JsonlPartRow = {
  id: string;
  messageID: string;
  sessionID: string;
  type?: string;
  text?: string;
  tool?: string;
  state?: Record<string, unknown>;
  [key: string]: unknown;
};

export function createOpenCodeAdapter(
  entry: OpenCodeAgentEntry,
  options: OpenCodeAdapterOptions = {}
): Adapter {
  if (entry.agent !== "opencode") {
    throw new Error(`[opencode:${entry.alias}] OpenCode adapter requires agent "opencode", got "${entry.agent}"`);
  }

  const label = `[${entry.agent}:${entry.alias}]`;
  const cwd = options.cwd ?? process.cwd();

  // Get defaults for path resolution
  const defaults = getOpenCodeDefaults();

  // Resolve storage with centralized helper
  const storageInfo = resolveOpenCodeStorage(entry, defaults, { context: label });

  // Branch based on storage mode
  if (storageInfo.mode === "db") {
    return createDbAdapter(entry, storageInfo.path, cwd, label, options);
  } else {
    return createJsonlAdapter(entry, storageInfo.path, cwd, label);
  }
}

function getOpenCodeDefaults(): OpenCodeStorageDefaults {
  const home = homedir();
  return {
    dbPath: join(home, ".local", "share", "opencode", "opencode.db"),
    jsonlPath: join(home, ".local", "share", "opencode", "opencode.jsonl"),
  };
}

function createDbAdapter(
  entry: OpenCodeAgentEntry,
  dbPath: string,
  cwd: string,
  label: string,
  options: OpenCodeAdapterOptions
): Adapter {
  const db = openDatabaseWithRetry(dbPath, label, options.lockRetries ?? DEFAULT_LOCK_RETRIES);
  validateSchema(db, label);

  return {
    listSessions: () => listSessionsFromDb(db, entry, cwd, label),
    listSessionsByTimeRange: (options: TimeRangeOptions) =>
      listSessionsByTimeRangeFromDb(db, entry, cwd, options, label),
    searchSessions: (query: SearchQuery) => searchSessionsFromDb(db, entry, query, label),
    getSessionDetail: (sessionId: string, opts: SessionReadOptions) =>
      getSessionDetailFromDb(db, entry, sessionId, opts, label),
  };
}

function createJsonlAdapter(
  entry: OpenCodeAgentEntry,
  jsonlPath: string,
  cwd: string,
  label: string
): Adapter {
  // Validate path is a file
  try {
    const stat = statSync(jsonlPath);
    if (!stat.isFile()) {
      throw new Error(`${label} JSONL path is not a file: ${jsonlPath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes(label)) {
      throw error;
    }
    throw new Error(`${label} failed to access JSONL path: ${jsonlPath}`);
  }

  return {
    listSessions: () => listSessionsFromJsonl(jsonlPath, entry, cwd, label),
    listSessionsByTimeRange: (options: TimeRangeOptions) =>
      listSessionsByTimeRangeFromJsonl(jsonlPath, entry, cwd, options, label),
    searchSessions: (query: SearchQuery) => searchSessionsFromJsonl(jsonlPath, entry, query, label),
    getSessionDetail: (sessionId: string, opts: SessionReadOptions) =>
      getSessionDetailFromJsonl(jsonlPath, entry, sessionId, opts, label),
  };
}

// ============================================================================
// DB Adapter Implementation
// ============================================================================

function openDatabaseWithRetry(
  path: string,
  label: string,
  retries: number[]
): Database {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries.length; attempt++) {
    try {
      const stat = statSync(path);
      if (!stat.isFile()) {
        throw new Error(`${label} db_path is not a file: ${path}`);
      }
      return new Database(path, { readonly: true });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Check if this is a lock error
      const isLockError = lastError.message.toLowerCase().includes("locked") || 
                          lastError.message.toLowerCase().includes("busy") ||
                          lastError.message.includes("SQLITE_BUSY");
      
      // If this is the last attempt
      if (attempt === retries.length - 1) {
        // Re-throw errors that already have the label (like "db_path is not a file")
        if (lastError.message.includes(label)) {
          throw lastError;
        }
        // Throw lock-specific error for lock issues
        if (isLockError) {
          throw new Error(`${label} database locked after ${retries.length} attempts (delays: ${retries.join(',')}ms) - path: ${path}`);
        }
        // Throw generic error for other issues
        throw new Error(`${label} failed to open database after ${retries.length} attempt(s): ${path} - ${lastError.message}`);
      }
      
      // Not the last attempt - only retry if it's a lock error
      if (isLockError) {
        // Wait before retry (synchronous sleep)
        const start = Date.now();
        while (Date.now() - start < retries[attempt]) {
          // Busy wait
        }
      } else {
        // Non-lock errors should be thrown immediately
        if (lastError.message.includes(label)) {
          throw lastError;
        }
        throw new Error(`${label} failed to open database: ${path} - ${lastError.message}`);
      }
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new Error(`${label} unexpected state in openDatabaseWithRetry`);
}

function validateSchema(db: Database, label: string): void {
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: { name: string }) => r.name);

  const missingTables: string[] = [];
  const missingColumns: { table: string; columns: string[] }[] = [];

  for (const [table, requiredColumns] of Object.entries(EXPECTED_SCHEMA.tables)) {
    if (!tables.includes(table)) {
      missingTables.push(table);
      continue;
    }

    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((r: { name: string }) => r.name);

    const missing = requiredColumns.filter((c) => !columns.includes(c));
    if (missing.length > 0) {
      missingColumns.push({ table, columns: missing });
    }
  }

  if (missingTables.length > 0 || missingColumns.length > 0) {
    const parts: string[] = [];
    
    if (missingTables.length > 0) {
      parts.push(`missing tables: ${missingTables.join(", ")}`);
    }
    
    if (missingColumns.length > 0) {
      const colParts = missingColumns.map(
        (mc) => `${mc.table}(${mc.columns.join(", ")})`
      );
      parts.push(`missing columns: ${colParts.join("; ")}`);
    }

    throw new Error(
      `${label} schema mismatch: ${parts.join("; ")}. Expected schema: project(id, worktree), session(id, project_id, directory, title, time_created, time_updated), message(id, session_id, time_created, data), part(id, message_id, session_id, data)`
    );
  }
}

function listSessionsFromDb(
  db: Database,
  entry: OpenCodeAgentEntry,
  cwd: string,
  label: string
): SessionSummary[] {
  const projectId = findProjectId(db, cwd, label);
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

  return sessions.map((row: SessionRow) => {
    const messageCount = countMessages(db, row.id, label);
    return {
      id: row.id,
      agent: "opencode",
      alias: entry.alias,
      title: row.title || row.id, // Fallback to id if title empty
      created_at: formatTimestamp(row.time_created),
      updated_at: formatTimestamp(row.time_updated),
      message_count: messageCount,
      storage: "db",
    };
  });
}

function listSessionsByTimeRangeFromDb(
  db: Database,
  entry: OpenCodeAgentEntry,
  cwd: string,
  options: TimeRangeOptions,
  label: string
): SessionSummary[] {
  const projectId = findProjectId(db, cwd, label);
  if (!projectId) {
    return [];
  }

  // Build query with optional filters
  const conditions: string[] = ["project_id = ?"];
  const params: (string | number)[] = [projectId];

  // Add time filters
  if (options.since !== undefined) {
    conditions.push("time_created >= ?");
    params.push(options.since);
  }

  if (options.until !== undefined) {
    conditions.push("time_updated <= ?");
    params.push(options.until);
  }

  // Add limit (default 50, 0 = all)
  const limit = options.limit !== undefined ? options.limit : 50;
  const limitClause = limit > 0 ? ` LIMIT ${limit}` : "";

  const query = `
    SELECT id, project_id, directory, title, time_created, time_updated
    FROM session
    WHERE ${conditions.join(" AND ")}
    ORDER BY time_updated DESC
    ${limitClause}
  `;

  let sessions: SessionRow[];
  try {
    sessions = db.query<SessionRow, (string | number)[]>(query).all(...params);
  } catch (error) {
    throw new Error(
      `${label} failed to query sessions by time range: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return sessions.map((row: SessionRow) => {
    const messageCount = countMessages(db, row.id, label);
    return {
      id: row.id,
      agent: "opencode",
      alias: entry.alias,
      title: row.title || row.id, // Fallback to id if title empty
      created_at: formatTimestamp(row.time_created),
      updated_at: formatTimestamp(row.time_updated),
      message_count: messageCount,
      storage: "db",
    };
  });
}

function searchSessionsFromDb(
  db: Database,
  entry: OpenCodeAgentEntry,
  query: SearchQuery,
  label: string
): SessionSummary[] {
  const cwd = query.cwd ?? process.cwd();
  const projectId = findProjectId(db, cwd, label);
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

  const seen = new Set(sessionsByTitle.map((s: SessionRow) => s.id));
  const combined = [...sessionsByTitle];
  for (const row of sessionsByContent) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      combined.push(row);
    }
  }

  combined.sort((a, b) => b.time_updated - a.time_updated);

  return combined.map((row) => {
    const messageCount = countMessages(db, row.id, label);
    return {
      id: row.id,
      agent: "opencode",
      alias: entry.alias,
      title: row.title || row.id, // Fallback to id if title empty
      created_at: formatTimestamp(row.time_created),
      updated_at: formatTimestamp(row.time_updated),
      message_count: messageCount,
      storage: "db",
    };
  });
}

async function getSessionDetailFromDb(
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

  const messageCount = countMessages(db, sessionId, label);
  const baseSummary: SessionSummary = {
    id: session.id,
    agent: "opencode",
    alias: entry.alias,
    title: session.title || session.id, // Fallback to id if title empty
    created_at: formatTimestamp(session.time_created),
    updated_at: formatTimestamp(session.time_updated),
    message_count: messageCount,
    storage: "db",
  };

  // Determine tool filtering options
  const toolOptions: {
    lastOnly?: boolean;
    excludeTools?: boolean;
    includeAll?: boolean;
  } = {};

  if (options.mode === "last_message") {
    toolOptions.lastOnly = true;
  } else if (options.mode === "all_with_tools") {
    toolOptions.includeAll = true;
  } else {
    // Default: exclude tools
    toolOptions.excludeTools = true;
  }

  // Handle message selection options
  const selection = options.selection;
  if (selection) {
    const { messages, warning } = getMessagesWithSelection(db, sessionId, selection, toolOptions, label, options.role);
    return { ...baseSummary, messages, ...(warning && { warning }) };
  }

  // Legacy behavior without selection options
  const messages = getMessagesFromDb(db, sessionId, toolOptions, label, options.role);
  return { ...baseSummary, messages };
}

function findProjectId(db: Database, cwd: string, label: string): string | null {
  try {
    const normalizedCwd = resolve(cwd);

    const project = db
      .query<ProjectRow, []>("SELECT id, worktree FROM project")
      .all()
      .find((p: ProjectRow) => resolve(p.worktree) === normalizedCwd);

    return project?.id ?? null;
  } catch (error) {
    throw new Error(`${label} failed to query project: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function countMessages(db: Database, sessionId: string, label: string): number {
  try {
    const result = db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) as count FROM message WHERE session_id = ?`
      )
      .get(sessionId);
    return result?.count ?? 0;
  } catch (error) {
    throw new Error(`${label} failed to count messages: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getMessagesFromDb(
  db: Database,
  sessionId: string,
  options: { lastOnly?: boolean; excludeTools?: boolean; includeAll?: boolean },
  label: string,
  roleFilter?: "user" | "assistant" | "system"
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

  let messages: MessageRow[];
  try {
    messages = db.query<MessageRow, [string]>(query).all(sessionId);
  } catch (error) {
    throw new Error(`${label} failed to query messages: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (options.lastOnly && messages.length > 0) {
    messages.reverse();
  }

  const result = messages.map((row) => {
    let data: { 
      role?: string; 
      agent?: string; 
      modelID?: string;
      model?: { modelID?: string };
    };
    try {
      data = JSON.parse(row.data) as { 
        role?: string; 
        agent?: string; 
        modelID?: string;
        model?: { modelID?: string };
      };
    } catch (error) {
      throw new Error(`${label} failed to parse message data for ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parts = getPartsFromDb(db, row.id, options, label);

    // Extract modelID with fallback: nested model.modelID takes precedence
    const modelID = data.model?.modelID || data.modelID;

    return {
      id: row.id,
      role: normalizeRole(data.role),
      created_at: formatTimestamp(row.time_created),
      parts,
      agent: data.agent,
      modelID: modelID,
    };
  });

  // Apply role filter if specified
  if (roleFilter) {
    return result.filter((msg) => msg.role === roleFilter);
  }

  return result;
}

// Message selection options type
type MessageSelectionOpts = {
  mode: "first" | "last" | "all" | "range" | "user-only";
  count?: number;
  start?: number;
  end?: number;
};

type ToolFilterOpts = {
  lastOnly?: boolean;
  excludeTools?: boolean;
  includeAll?: boolean;
};

/**
 * Get messages with selection options (first, last, all, range, user-only).
 * Uses 1-indexed ranges for start/end parameters.
 * Returns messages and optional warning.
 */
function getMessagesWithSelection(
  db: Database,
  sessionId: string,
  selection: MessageSelectionOpts,
  toolOptions: ToolFilterOpts,
  label: string,
  roleFilter?: "user" | "assistant" | "system"
): { messages: SessionMessage[]; warning?: string } {
  // First, fetch all messages for the session (ordered by time_created ASC)
  let messages: MessageRow[];
  try {
    messages = db
      .query<MessageRow, [string]>(
        `SELECT id, session_id, time_created, data
         FROM message
         WHERE session_id = ?
         ORDER BY time_created ASC`
      )
      .all(sessionId);
  } catch (error) {
    throw new Error(`${label} failed to query messages: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Parse roles for filtering
  const messagesWithRoles = messages.map((row) => {
    let data: { 
      role?: string; 
      agent?: string; 
      modelID?: string;
      model?: { modelID?: string };
    };
    try {
      data = JSON.parse(row.data) as { 
        role?: string; 
        agent?: string; 
        modelID?: string;
        model?: { modelID?: string };
      };
    } catch (error) {
      throw new Error(`${label} failed to parse message data for ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Extract modelID with fallback: nested model.modelID takes precedence
    const modelID = data.model?.modelID || data.modelID;
    return { row, role: normalizeRole(data.role), agent: data.agent, modelID };
  });

  // Apply selection mode
  let selectedRows: typeof messagesWithRoles;
  let warning: string | undefined;

  switch (selection.mode) {
    case "first": {
      const count = selection.count ?? 10;
      selectedRows = messagesWithRoles.slice(0, count);
      break;
    }

    case "last": {
      const count = selection.count ?? 10;
      selectedRows = messagesWithRoles.slice(-count);
      break;
    }

    case "all": {
      selectedRows = messagesWithRoles;
      // Warn if more than 100 messages
      if (messagesWithRoles.length > 100) {
        warning = `Large message count (${messagesWithRoles.length}): consider using --first, --last, or --range for better performance`;
      }
      break;
    }

    case "range": {
      // 1-indexed, inclusive range
      const start = selection.start ?? 1;
      const end = selection.end ?? messagesWithRoles.length;

      // Validate range
      if (start < 1) {
        throw new Error(`${label} invalid range: start (${start}) must be >= 1`);
      }
      if (end < 1) {
        throw new Error(`${label} invalid range: end (${end}) must be >= 1`);
      }
      if (start > end) {
        throw new Error(`${label} invalid range: start (${start}) > end (${end})`);
      }

      // Convert to 0-indexed slice (start-1 to end, since slice end is exclusive)
      const startIndex = start - 1;
      const endIndex = end; // slice end is exclusive, so we use end directly

      selectedRows = messagesWithRoles.slice(startIndex, endIndex);
      break;
    }

    case "user-only": {
      selectedRows = messagesWithRoles.filter((m) => m.role === "user");
      break;
    }

    default:
      throw new Error(`${label} unsupported selection mode: ${(selection as { mode: string }).mode}`);
  }

  // Apply role filter if specified
  if (roleFilter) {
    selectedRows = selectedRows.filter((m) => m.role === roleFilter);
  }

  // Map selected rows to SessionMessage with parts
  const selectedMessages = selectedRows.map(({ row }) => {
    const parts = getPartsFromDb(db, row.id, toolOptions, label);
    const msgData = messagesWithRoles.find((m) => m.row.id === row.id)!;

    return {
      id: row.id,
      role: msgData.role,
      created_at: formatTimestamp(row.time_created),
      parts,
      agent: msgData.agent,
      modelID: msgData.modelID,
    };
  });

  return { messages: selectedMessages, warning };
}

function getPartsFromDb(
  db: Database,
  messageId: string,
  options: { excludeTools?: boolean; includeAll?: boolean },
  label: string
): SessionPart[] {
  let parts: PartRow[];
  try {
    parts = db
      .query<PartRow, [string]>(
        `SELECT id, message_id, session_id, data
         FROM part
         WHERE message_id = ?
         ORDER BY time_created ASC`
      )
      .all(messageId);
  } catch (error) {
    throw new Error(`${label} failed to query parts: ${error instanceof Error ? error.message : String(error)}`);
  }

  return parts
    .map((row) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(row.data) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`${label} failed to parse part data for ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
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

// ============================================================================
// JSONL Adapter Implementation
// ============================================================================

function parseJsonlFile(jsonlPath: string, label: string): JsonlSessionRow[] {
  let content: string;
  try {
    content = readFileSync(jsonlPath, "utf-8");
  } catch (error) {
    throw new Error(`${label} failed to read JSONL file: ${jsonlPath} - ${error instanceof Error ? error.message : String(error)}`);
  }

  // Handle empty file
  if (!content.trim()) {
    return [];
  }

  const lines = content.split("\n");
  const sessions: JsonlSessionRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Skip blank lines and lines with only whitespace
    if (!line || !line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as JsonlSessionRow;
      sessions.push(parsed);
    } catch (error) {
      throw new Error(
        `${label} malformed JSONL at line ${lineNum}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return sessions;
}

function listSessionsFromJsonl(
  jsonlPath: string,
  entry: OpenCodeAgentEntry,
  cwd: string,
  label: string
): SessionSummary[] {
  const sessions = parseJsonlFile(jsonlPath, label);
  const normalizedCwd = resolve(cwd);

  // Filter sessions by CWD (directory match)
  const filtered = sessions.filter((s) => {
    try {
      return s.directory && resolve(s.directory) === normalizedCwd;
    } catch {
      return false;
    }
  });

  // Sort by timeUpdated descending
  filtered.sort((a, b) => b.timeUpdated - a.timeUpdated);

  return filtered.map((row) => ({
    id: row.id,
    agent: "opencode",
    alias: entry.alias,
    title: row.title || row.id, // Fallback to id if title empty
    created_at: formatTimestamp(row.timeCreated),
    updated_at: formatTimestamp(row.timeUpdated),
    message_count: 0, // JSONL doesn't have message counts in session rows
    storage: "jsonl",
  }));
}

function listSessionsByTimeRangeFromJsonl(
  jsonlPath: string,
  entry: OpenCodeAgentEntry,
  cwd: string,
  options: TimeRangeOptions,
  label: string
): SessionSummary[] {
  const sessions = parseJsonlFile(jsonlPath, label);
  const normalizedCwd = resolve(cwd);

  // Filter sessions by CWD (directory match) and time range
  const filtered = sessions.filter((s) => {
    // Check CWD match
    try {
      if (!s.directory || resolve(s.directory) !== normalizedCwd) {
        return false;
      }
    } catch {
      return false;
    }

    // Check time range filters
    if (options.since !== undefined && s.timeCreated < options.since) {
      return false;
    }

    if (options.until !== undefined && s.timeUpdated > options.until) {
      return false;
    }

    return true;
  });

  // Sort by timeUpdated descending
  filtered.sort((a, b) => b.timeUpdated - a.timeUpdated);

  // Apply limit (default 50, 0 = all)
  const limit = options.limit !== undefined ? options.limit : 50;
  const limited = limit > 0 ? filtered.slice(0, limit) : filtered;

  return limited.map((row) => ({
    id: row.id,
    agent: "opencode",
    alias: entry.alias,
    title: row.title || row.id, // Fallback to id if title empty
    created_at: formatTimestamp(row.timeCreated),
    updated_at: formatTimestamp(row.timeUpdated),
    message_count: 0, // JSONL doesn't have message counts in session rows
    storage: "jsonl",
  }));
}

function searchSessionsFromJsonl(
  jsonlPath: string,
  entry: OpenCodeAgentEntry,
  query: SearchQuery,
  label: string
): SessionSummary[] {
  const sessions = parseJsonlFile(jsonlPath, label);
  const cwd = query.cwd ?? process.cwd();
  const normalizedCwd = resolve(cwd);
  const searchLower = query.text.toLowerCase();

  // Filter sessions by CWD and search text
  const filtered = sessions.filter((s) => {
    // Check CWD match
    try {
      if (!s.directory || resolve(s.directory) !== normalizedCwd) {
        return false;
      }
    } catch {
      return false;
    }

    // Check title match
    if (s.title && s.title.toLowerCase().includes(searchLower)) {
      return true;
    }

    // For JSONL, we can't search parts without loading full session data
    // So we only search by title for now
    return false;
  });

  // Sort by timeUpdated descending
  filtered.sort((a, b) => b.timeUpdated - a.timeUpdated);

  return filtered.map((row) => ({
    id: row.id,
    agent: "opencode",
    alias: entry.alias,
    title: row.title || row.id, // Fallback to id if title empty
    created_at: formatTimestamp(row.timeCreated),
    updated_at: formatTimestamp(row.timeUpdated),
    message_count: 0,
    storage: "jsonl",
  }));
}

async function getSessionDetailFromJsonl(
  jsonlPath: string,
  entry: OpenCodeAgentEntry,
  sessionId: string,
  options: SessionReadOptions,
  label: string
): Promise<SessionDetail> {
  // For JSONL, we need to find the session by ID
  // Note: Full JSONL implementation would require parsing message/part data
  // For now, we return basic session info
  
  const sessions = parseJsonlFile(jsonlPath, label);
  const session = sessions.find((s) => s.id === sessionId);

  if (!session) {
    throw new Error(`${label} session not found in JSONL: ${sessionId}`);
  }

  const baseSummary: SessionSummary = {
    id: session.id,
    agent: "opencode",
    alias: entry.alias,
    title: session.title || session.id, // Fallback to id if title empty
    created_at: formatTimestamp(session.timeCreated),
    updated_at: formatTimestamp(session.timeUpdated),
    message_count: 0,
    storage: "jsonl",
  };

  // JSONL adapter doesn't support full message retrieval in basic implementation
  // Return empty messages for now
  return { ...baseSummary, messages: [] };
}

// ============================================================================
// Shared Utilities
// ============================================================================

function normalizeRole(role?: string): "user" | "assistant" | "system" {
  if (role === "user" || role === "assistant" || role === "system") {
    return role;
  }
  return "user";
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}
