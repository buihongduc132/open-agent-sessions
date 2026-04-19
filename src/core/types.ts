import { AgentEntry, AgentKind } from "../config/types";
import type { SimilarSessionResult } from "../similarity/search";

export type SessionStorageKind = "db" | "jsonl" | "other";

export interface SessionSummary {
  id: string;
  agent: AgentKind;
  alias: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  storage: SessionStorageKind;
  /** Present when this session was forked from a parent session. */
  parentSessionId?: string;
}

export interface SessionCloneMetadata {
  src?: {
    agent?: AgentKind;
    session_id?: string;
    version?: string;
  };
  dst?: {
    agent?: AgentKind;
    session_id?: string;
    version?: string;
  };
}

export interface SessionDetail extends SessionSummary {
  clone?: SessionCloneMetadata;
  messages?: SessionMessage[];
  warning?: string;
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  created_at: string;
  parts: SessionPart[];
  modelID?: string;
  agent?: string;
}

export type SessionPart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; state: Record<string, unknown> }
  | { type: "reasoning"; text: string }
  | { type: string; [key: string]: unknown };

export interface SearchQuery {
  cwd?: string;
  text: string;
}

/** R-41: Query for fuzzy tool/MCP/skills usage search */
export interface ToolSearchQuery {
  /** Text to fuzzy-match against tool/MCP call names and arguments */
  tool: string;
  /** Optional cwd override for adapter-specific scope resolution */
  cwd?: string;
}

export type SessionReadMode = "last_message" | "all_no_tools" | "all_with_tools";

export type MessageSelectionMode = "first" | "last" | "all" | "range" | "user-only";

export interface MessageSelectionOptions {
  mode: MessageSelectionMode;
  count?: number; // for first/last (default 10 for last)
  start?: number; // for range (1-indexed)
  end?: number; // for range (1-indexed, inclusive)
  /** When true, filters messages to only user role after selection is applied. */
  userOnly?: boolean;
}

export interface SessionReadOptions {
  mode?: SessionReadMode; // tool filtering mode (defaults to all_no_tools)
  selection?: MessageSelectionOptions; // message selection options
  role?: "user" | "assistant" | "system"; // filter messages by role
  /** When true, filters messages to only user role (additive with selection mode). */
  userOnly?: boolean;
}

export interface TimeRangeOptions {
  since?: number; // Start timestamp (milliseconds since epoch)
  until?: number; // End timestamp (milliseconds since epoch)
  limit?: number; // Maximum number of results (default: 50, 0 = all)
  /**
   * Session ID to skip — used by cursor pagination to exclude the cursor
   * session itself so it doesn't reappear on the next page.
   * Adapters that implement listSessionsByTimeRange should honour this field.
   */
  skipSessionId?: string;
}

// Canonical session key is (agent, alias, session_id).
export interface SessionKey {
  agent: AgentKind;
  alias: string;
  session_id: string;
}

export interface Adapter {
  readonly version: string;
  listSessions(): SessionSummary[];
  listSessionsByTimeRange?(options: TimeRangeOptions): SessionSummary[];
  searchSessions?(query: SearchQuery): SessionSummary[];
  /** R-41: Fuzzy tool/MCP/skills usage search */
  toolSearchSessions?(query: ToolSearchQuery): SessionSummary[];
  getSessionDetail?(sessionId: string, options: SessionReadOptions): Promise<SessionDetail>;
  /**
   * Fork a session from this adapter to a destination agent/alias.
   * Called on the destination adapter to create a new session linked to the source.
   * DEFERRED (R-18): Write to native agent storage not yet implemented.
   * @param sourceSessionId The session ID of the source session to fork from.
   * @param destAgent The destination agent type (e.g. "opencode").
   * @param destAlias The destination agent alias.
   * @returns ForkResult with newSessionId, parentSessionId, destAgent, destAlias, forkedAt.
   */
  forkSession?(sourceSessionId: string, destAgent: string, destAlias: string): Promise<ForkResult>;
  /**
   * REQ-SIM-03: Find sessions similar to the given session, ranked by hybrid similarity score.
   * Uses sqlite-vec + FTS5 when available (OpenCode adapter).
   * @param sessionId Session to find similar sessions for.
   * @param topK Maximum results to return. Default: 5.
   */
  findSimilarSessions?(sessionId: string, topK?: number): Promise<SimilarSessionResult[]>;
}

export type AdapterFactory = (entry: AgentEntry) => Adapter;

export interface AdapterFactories {
  opencode: AdapterFactory;
  codex: AdapterFactory;
  claude: AdapterFactory;
  hermes: AdapterFactory;
}

export interface AdapterHandle {
  agent: AgentKind;
  alias: string;
  version: string;
  listSessions(): Promise<SessionSummary[]>;
  listSessionsByTimeRange?(options: TimeRangeOptions): SessionSummary[];
  /** Optional — only present when the adapter supports session detail retrieval. */
  getSessionDetail?(sessionId: string, options?: SessionReadOptions): Promise<SessionDetail>;
  /** Optional — only present when the adapter supports session forking (R-39). */
  forkSession?(sourceSessionId: string, destAgent: string, destAlias: string): Promise<ForkResult>;
  /** Optional — only present when the adapter supports similarity search (REQ-SIM-03). */
  findSimilarSessions?(sessionId: string, topK?: number): Promise<SimilarSessionResult[]>;
}

export interface AdapterRegistry {
  adapters: AdapterHandle[];
}

/**
 * Reference to a specific session, identified by agent + alias + sessionId.
 * Used by forkSession (R-39) and workspace SDK (R-38).
 */
export interface SessionRef {
  /** Agent kind: "opencode" | "codex" | "claude" */
  agent: AgentKind;
  /** Alias for the agent entry in config, e.g. "main" or "/home/user/repos/backend:api" */
  alias: string;
  /** The UUID of the session */
  sessionId: string;
}

/**
 * Result returned by forkSession.
 * DEFERRED (R-18): Write to native agent storage not yet implemented.
 *   The fork is prepared in CSF (R-16) format but not yet persisted to agent-native storage.
 */
export interface ForkResult {
  newSessionId: string;
  /** The session ID of the source session this was forked from */
  parentSessionId: string;
  destAgent: string;
  destAlias: string;
  /** ISO-8601 timestamp of when the fork was created */
  forkedAt: string;
}
