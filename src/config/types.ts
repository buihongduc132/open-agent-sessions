export type AgentKind = "opencode" | "codex" | "claude";

export type OpenCodeStorageMode = "auto" | "db" | "jsonl";

export interface OpenCodeStorageConfig {
  mode: OpenCodeStorageMode;
  db_path?: string;
  jsonl_path?: string;
}

export interface BaseAgentEntry {
  agent: AgentKind;
  alias: string;
  enabled: boolean;
}

export interface OpenCodeAgentEntry extends BaseAgentEntry {
  agent: "opencode";
  storage: OpenCodeStorageConfig;
  [key: string]: unknown;
}

export interface OtherAgentEntry extends BaseAgentEntry {
  agent: "codex" | "claude";
  [key: string]: unknown;
}

export type AgentEntry = OpenCodeAgentEntry | OtherAgentEntry;

export interface Config {
  agents: AgentEntry[];
}

export interface OpenCodeStorageDefaults {
  dbPath: string;
  jsonlPath: string;
}

export interface ResolvedOpenCodeStorage {
  mode: "db" | "jsonl";
  path: string;
  dbPath: string;
  jsonlPath: string;
}
