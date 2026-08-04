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

// SDK contract version — bump on any breaking change to the public adapter
// surface (Adapter / SessionSummary / SessionDetail / SessionReadOptions /
// SearchQuery / ToolSearchQuery). Consumers (oas-command-stats) pin against this
// to detect silent schema drift (OT49 / X4). Kept in lock-step with the package
// version while the surface is pre-1.0.
export const SDK_CONTRACT_VERSION = "0.1.0";

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
  createGeminiAdapter,
  createAntigravityAdapter,
  createPiAdapter,
  createZcodeAdapter,
} from "../adapters";

// Normalization
export {
  normalizeSessionSummary,
  normalizeTimestamp,
  searchSessions,
  searchSessionsWithErrors,
} from "../core";

// Session fork (R-39) — SessionRef is re-exported from core/types above
export { forkSession } from "./session";
export type { ForkResult } from "./session";