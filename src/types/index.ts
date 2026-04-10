// Pure TypeScript types — no runtime dependencies
// Usage: import type { Adapter, SessionSummary, SessionDetail } from "open-agent-sessions/types"
//
// This module intentionally has no imports from config/load.ts or any Node/Bun runtime.
// It allows consumers to use OAS type definitions without installing the full package.

export type { AgentKind } from "../config/types";
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
  SessionRef,
  SessionStorageKind,
  SessionSummary,
  SearchQuery,
  TimeRangeOptions,
} from "../core/types";

export type {
  AgentEntry,
  Config,
  OpenCodeAgentEntry,
  OpenCodeStorageConfig,
  OpenCodeStorageDefaults,
  OpenCodeStorageMode,
  OtherAgentEntry,
  ResolvedOpenCodeStorage,
} from "../config/types";
