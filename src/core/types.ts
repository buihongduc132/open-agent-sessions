import { AgentEntry, AgentKind } from "../config/types";

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

export type SessionReadMode = "last_message" | "all_no_tools" | "all_with_tools";

export type MessageSelectionMode = "first" | "last" | "all" | "range" | "user-only";

export interface MessageSelectionOptions {
  mode: MessageSelectionMode;
  count?: number; // for first/last (default 10 for last)
  start?: number; // for range (1-indexed)
  end?: number; // for range (1-indexed, inclusive)
}

export interface SessionReadOptions {
  mode?: SessionReadMode; // tool filtering mode (defaults to all_no_tools)
  selection?: MessageSelectionOptions; // message selection options
  role?: "user" | "assistant" | "system"; // filter messages by role
}

export interface TimeRangeOptions {
  since?: number; // Start timestamp (milliseconds since epoch)
  until?: number; // End timestamp (milliseconds since epoch)
  limit?: number; // Maximum number of results (default: 50, 0 = all)
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
  getSessionDetail?(sessionId: string, options: SessionReadOptions): Promise<SessionDetail>;
}

export type AdapterFactory = (entry: AgentEntry) => Adapter;

export interface AdapterFactories {
  opencode: AdapterFactory;
  codex: AdapterFactory;
  claude: AdapterFactory;
}

export interface AdapterHandle {
  agent: AgentKind;
  alias: string;
  version: string;
  listSessions(): Promise<SessionSummary[]>;
}

export interface AdapterRegistry {
  adapters: AdapterHandle[];
}
