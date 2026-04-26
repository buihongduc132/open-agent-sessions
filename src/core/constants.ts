import { AgentKind } from "../config/types";

/**
 * Standardized display and sorting order for agents.
 * R-40: Deterministic ordering across all OAS modules.
 */
export const AGENT_ORDER: Record<AgentKind, number> = {
  opencode: 0,
  codex: 1,
  claude: 2,
  hermes: 3,
  gemini: 4,
  antigravity: 5,
};

/**
 * Helper to check if a string is a valid AgentKind.
 */
export function isAgentKind(kind: string): kind is AgentKind {
  return Object.keys(AGENT_ORDER).includes(kind as AgentKind);
}

/**
 * List of all supported agent kinds in preferred order.
 */
export const SUPPORTED_AGENTS = Object.keys(AGENT_ORDER) as AgentKind[];
