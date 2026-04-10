// Canonical SDK entry point
// Usage: import { createRegistry, createAdapter, SessionSummary } from "open-agent-sessions/sdk"
//
// Export surface:
//   - Registry factory: createAdapterRegistry, createRegistry, createAdapter
//   - Workspace: createWorkspaceSession, WorkspaceSession, WorkspaceConfig
//   - Config: loadConfig, Config
//   - Types: Adapter, SessionSummary, SessionDetail, SearchQuery, TimeRangeOptions,
//            SessionReadOptions, AdapterFactory, SessionRef
//   - Adapters: createOpenCodeAdapter, createCodexAdapter, createClaudeAdapter
//   - Normalization: normalizeSessionSummary

export { createAdapterRegistry, createRegistry, createAdapter } from "../core/registry";

// Workspace session factory
export {
  createWorkspaceSession,
  setWorkspaceFactories,
  resolveScope,
  findGitRoot,
  buildCanonicalAlias,
  type WorkspaceConfig,
  type WorkspaceSession,
  type SessionRef,
} from "./workspace";

// Config
export { loadConfigFromFile, parseConfigText } from "../config/load";
export type {
  AgentEntry,
  AgentKind,
  Config,
  OpenCodeAgentEntry,
  OpenCodeStorageConfig,
  OpenCodeStorageMode,
  OpenCodeStorageDefaults,
  OtherAgentEntry,
  ResolvedOpenCodeStorage,
} from "../config/types";

// Types — full SDK surface
export type {
  Adapter,
  AdapterFactory,
  AdapterFactories,
  AdapterHandle,
  AdapterRegistry,
  SessionCloneMetadata,
  SessionDetail,
  SessionKey,
  SessionMessage,
  SessionPart,
  SessionReadMode,
  MessageSelectionMode,
  MessageSelectionOptions,
  SessionReadOptions,
  SessionStorageKind,
  SessionSummary,
  SessionRef,
  SearchQuery,
  TimeRangeOptions,
} from "../core/types";

export type {
  WorkspaceConfig,
  WorkspaceSession,
  SessionRef as WorkspaceSessionRef,
} from "./workspace";

// Adapters — barrel re-export
export {
  createOpenCodeAdapter,
  createOpenCodeCloneDestinationAdapter,
  createCodexAdapter,
  createCodexCloneSourceAdapter,
  createClaudeAdapter,
} from "../adapters";
export type { SessionSummary, SessionDetail } from "../adapters";

// Normalization
export { normalizeSessionSummary } from "../core/normalize";

// Session fork (R-39)
export { forkSession } from "./session";
export type { ForkResult, SessionRef } from "./session";
