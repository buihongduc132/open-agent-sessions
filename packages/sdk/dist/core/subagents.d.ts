/**
 * src/core/subagents.ts
 *
 * Sub-agent inference engine for SessionDetail.
 *
 * Given a SessionDetail, infers which sub-agents (LLMs, tool groups,
 * MCP plugins) participated by analysing modelID, tool calls, and
 * reasoning blocks per message.
 *
 * @file src/core/subagents.ts
 */
import type { SessionDetail } from "./types";
export interface ToolUsage {
    /** Normalised tool name, e.g. "Bash", "WebFetch", "git_commit" */
    name: string;
    /** Number of times this tool was called in the session */
    callCount: number;
    /** Whether this tool is an MCP/plugin tool */
    isMcp: boolean;
    /** Whether this tool is uncategorised (maps to CustomTool:) */
    isCustom: boolean;
}
export interface SessionSubAgentSummary {
    /** Unique model IDs seen across all assistant messages */
    models: string[];
    /** Tool usage stats, sorted by callCount descending */
    tools: ToolUsage[];
    /** MCP plugin tool names (tools with "MCP_" prefix or detected pattern) */
    mcpPlugins: string[];
    /** Tool names that don't match known categories */
    customTools: string[];
    /** Whether any message contained a reasoning/thinking block */
    reasoningUsed: boolean;
    /** Total message count */
    messageCount: number;
    /** Total tool call count */
    toolCallCount: number;
    /** Role breakdown */
    roles: {
        user: number;
        assistant: number;
        system: number;
    };
    /** Time range: earliest message ISO timestamp */
    startedAt?: string;
    /** Time range: latest message ISO timestamp */
    endedAt?: string;
}
/**
 * Infer sub-agent summary from a fully-loaded SessionDetail.
 * This is a pure function — no side effects, no I/O.
 */
export declare function inferSubAgents(detail: SessionDetail): SessionSubAgentSummary;
/**
 * Categorise a tool name → inferred sub-agent label.
 * Returns undefined if no known category.
 */
export declare function categorise(toolName: string): string | undefined;
/**
 * Build a human-readable summary string for display.
 */
export declare function formatSubAgentSummary(summary: SessionSubAgentSummary): string;
/**
 * Get a one-line summary for the TUI status bar.
 */
export declare function formatStatusLine(summary: SessionSubAgentSummary): string;
export interface ForkChainNode {
    sessionId: string;
    title: string;
    agent: string;
    alias: string;
    forkedAt?: string;
    parentSessionId?: string;
    depth: number;
}
/**
 * Build the fork chain from a session up to the root.
 * Returns array from newest (starting session) to oldest (root).
 *
 * Safety: Stops after `maxDepth` iterations even if no cycle is detected,
 * preventing runaway traversal in degenerate data.
 */
export declare function buildForkChain(session: {
    id: string;
    parentSessionId?: string;
    agent: string;
    alias: string;
    title?: string;
    forkedAt?: string;
}, resolveParent: (sessionId: string) => typeof session | null, maxDepth?: number): ForkChainNode[];
