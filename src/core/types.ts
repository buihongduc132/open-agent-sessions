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
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  created_at: string;
  parts: SessionPart[];
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

export interface SessionReadOptions {
  mode: SessionReadMode;
}

// Canonical session key is (agent, alias, session_id).
export interface SessionKey {
  agent: AgentKind;
  alias: string;
  session_id: string;
}

export interface Adapter {
  listSessions(): Promise<SessionSummary[]> | SessionSummary[];
  searchSessions?(query: SearchQuery): Promise<SessionSummary[]> | SessionSummary[];
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
  listSessions(): Promise<SessionSummary[]>;
}

export interface AdapterRegistry {
  adapters: AdapterHandle[];
}
