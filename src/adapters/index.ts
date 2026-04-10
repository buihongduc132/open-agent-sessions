// Re-export all adapters as composable modules
// Usage: import { createOpenCodeAdapter, createCodexAdapter } from "open-agent-sessions/adapters"

export { createOpenCodeAdapter, createOpenCodeCloneDestinationAdapter } from "./opencode";
export { createCodexAdapter, createCodexCloneSourceAdapter } from "./codex";
export { createClaudeAdapter } from "./claude";

// Re-export types for convenience so consumers can import from a single place
export type {
  SessionSummary,
  SessionDetail,
} from "../core/types";
