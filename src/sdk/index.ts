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

export {
  createAdapterRegistry,
  createRegistry,
  createAdapter,
  clearDetailCache,
  invalidateDetailCache,
} from "../core/registry";

// Workspace session factory
export {
  createWorkspaceSession,
  setWorkspaceFactories,
  resolveScope,
  findGitRoot,
  buildCanonicalAlias,
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

// Types — full SDK surface (core)
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
  ToolSearchQuery,
  TimeRangeOptions,
} from "../core/types";

// Types — workspace module
export type {
  WorkspaceConfig,
  WorkspaceSession,
  SessionRef as WorkspaceSessionRef,
} from "./workspace";

// Adapters — barrel re-export (types already re-exported from core/types above)
export {
  createOpenCodeAdapter,
  createOpenCodeCloneDestinationAdapter,
  createCodexAdapter,
  createCodexCloneSourceAdapter,
  createClaudeAdapter,
  createAcpxAdapter,
} from "../adapters";

// Normalization
export { normalizeSessionSummary, normalizeTimestamp } from "../core/normalize";

// Session fork (R-39) — SessionRef is re-exported from core/types above
export { forkSession } from "./session";
export type { ForkResult } from "./session";