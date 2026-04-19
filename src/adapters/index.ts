// Re-export all adapters as composable modules
// Usage: import { createOpenCodeAdapter, createCodexAdapter } from "open-agent-sessions/adapters"

export { createOpenCodeAdapter, createOpenCodeCloneDestinationAdapter } from "./opencode";
export { createCodexAdapter, createCodexCloneSourceAdapter } from "./codex";
export { createClaudeAdapter } from "./claude";
export { createAcpxAdapter } from "./acpx"; // R-31
export { createHermesAdapter } from "./hermes"; // R-43

// Re-export types for convenience so consumers can import from a single place
export type {
  AcpxAdapterOptions,
} from "./acpx";
export type {
  HermesAdapterOptions,
} from "./hermes";
