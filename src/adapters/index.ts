// Re-export all adapters as composable modules
// Usage: import { createOpenCodeAdapter, createCodexAdapter } from "open-agent-sessions/adapters"

export { createOpenCodeAdapter, createOpenCodeCloneDestinationAdapter } from "./opencode";
export { createCodexAdapter, createCodexCloneSourceAdapter } from "./codex";
export { createClaudeAdapter } from "./claude";
export { createAcpxAdapter } from "./acpx"; // R-31
export { createHermesAdapter } from "./hermes"; // R-43
export { createGeminiAdapter } from "./gemini";
export { createAntigravityAdapter } from "./antigravity";
export { createPiAdapter } from "./pi";
export { createZcodeAdapter } from "./zcode";
export { createGrokAdapter } from "./grok";

// Re-export types for convenience so consumers can import from a single place
export type {
  AcpxAdapterOptions,
} from "./acpx";
export type {
  HermesAdapterOptions,
} from "./hermes";
export type {
  GeminiAdapterOptions,
} from "./gemini";
export type {
  AntigravityAdapterOptions,
} from "./antigravity";
export type {
  PiAdapterOptions,
} from "./pi";
export type {
  ZcodeAdapterOptions,
} from "./zcode";
export type {
  GrokAdapterOptions,
} from "./grok";
