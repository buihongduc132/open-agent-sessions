import { AgentKind } from "../config/types";
/**
 * Standardized display and sorting order for agents.
 * R-40: Deterministic ordering across all OAS modules.
 */
export declare const AGENT_ORDER: Record<AgentKind, number>;
/**
 * Helper to check if a string is a valid AgentKind.
 */
export declare function isAgentKind(kind: string): kind is AgentKind;
/**
 * List of all supported agent kinds in preferred order.
 */
export declare const SUPPORTED_AGENTS: AgentKind[];
