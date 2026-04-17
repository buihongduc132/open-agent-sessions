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

import type { SessionDetail, SessionMessage, SessionPart } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  roles: { user: number; assistant: number; system: number };
  /** Time range: earliest message ISO timestamp */
  startedAt?: string;
  /** Time range: latest message ISO timestamp */
  endedAt?: string;
}

// ---------------------------------------------------------------------------
// Tool → Sub-Agent Category mapping
// ---------------------------------------------------------------------------

/** Mapping from tool name prefixes/patterns to inferred sub-agent labels. */
const TOOL_CATEGORY_MAP: Record<string, string> = {
  // File operations
  "Bash": "Shell/CLI",
  "bash": "Shell/CLI",
  "Terminal": "Shell/CLI",
  "RunCommand": "Shell/CLI",
  "npm": "Shell/CLI",
  "pip": "Shell/CLI",
  "cargo": "Shell/CLI",
  "go": "Shell/CLI",
  // File system
  "Read": "FileSystem",
  "Write": "FileSystem",
  "Edit": "FileSystem",
  "create": "FileSystem",
  "delete": "FileSystem",
  "mkdir": "FileSystem",
  "move": "FileSystem",
  "copy": "FileSystem",
  "Glob": "FileSystem",
  "Grep": "FileSystem",
  // Git operations
  "git_add": "GitOperator",
  "git_commit": "GitOperator",
  "git_push": "GitOperator",
  "git_pull": "GitOperator",
  "git_branch": "GitOperator",
  "git_status": "GitOperator",
  "git_checkout": "GitOperator",
  "git_merge": "GitOperator",
  "git_rebase": "GitOperator",
  "git_log": "GitOperator",
  "git_diff": "GitOperator",
  "GitOperator": "GitOperator",
  "Git": "GitOperator",
  // Web / research
  "WebFetch": "WebSearch",
  "web_fetch": "WebSearch",
  "Browser": "WebSearch",
  "WebSearch": "WebSearch",
  "fetch": "WebSearch",
  "http": "WebSearch",
  "curl": "WebSearch",
  "wget": "WebSearch",
  // Code search
  "SearchCode": "CodeSearch",
  "search_code": "CodeSearch",
  "SearchInDirectory": "CodeSearch",
  "find": "CodeSearch",
  "grep": "CodeSearch",
  "rg": "CodeSearch",
  "Search": "CodeSearch",
  // Linting / fixes
  "ESLintFix": "CodeQuality",
  "eslint": "CodeQuality",
  "Prettier": "CodeQuality",
  "prettier": "CodeQuality",
  "format": "CodeQuality",
  "lint": "CodeQuality",
  "typecheck": "CodeQuality",
  // Database
  "sql_query": "Database",
  "run_sql": "Database",
  "sqlite": "Database",
  "mongo": "Database",
  "postgres": "Database",
  // Testing
  "run_test": "TestRunner",
  "jest": "TestRunner",
  "vitest": "TestRunner",
  "pytest": "TestRunner",
  "test": "TestRunner",
  // Documentation
  "ReadDocs": "Documentation",
  "docs": "Documentation",
  "readme": "Documentation",
};

// ---------------------------------------------------------------------------
// Inference engine
// ---------------------------------------------------------------------------

/**
 * Infer sub-agent summary from a fully-loaded SessionDetail.
 * This is a pure function — no side effects, no I/O.
 */
export function inferSubAgents(detail: SessionDetail): SessionSubAgentSummary {
  const messages = detail.messages ?? [];

  const modelSet = new Set<string>();
  const toolCounts = new Map<string, number>();
  const roleCounts = { user: 0, assistant: 0, system: 0 };
  let reasoningUsed = false;
  let startedAt: string | undefined;
  let endedAt: string | undefined;

  for (const msg of messages) {
    // Role counts
    if (msg.role in roleCounts) {
      roleCounts[msg.role as keyof typeof roleCounts]++;
    }

    // Time range
    if (msg.created_at) {
      if (!startedAt || msg.created_at < startedAt) startedAt = msg.created_at;
      if (!endedAt || msg.created_at > endedAt) endedAt = msg.created_at;
    }

    // Model ID
    if (msg.modelID) modelSet.add(msg.modelID);

    // Parts — tools, reasoning
    for (const part of msg.parts ?? []) {
      if (part.type === "tool") {
        const toolName = (part as { tool: string }).tool ?? "(unknown)";
        toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
      }
      if (part.type === "reasoning") {
        reasoningUsed = true;
      }
    }
  }

  // Build tool list
  const tools: ToolUsage[] = [];
  const mcpPlugins: string[] = [];
  const customTools: string[] = [];

  for (const [name, callCount] of toolCounts.entries()) {
    const isMcp = name.startsWith("MCP_") || name.startsWith("mcp_");
    const isCustom = !isMcp && !categorise(name);

    if (isMcp) {
      mcpPlugins.push(name);
    } else if (isCustom) {
      customTools.push(name);
    }

    tools.push({ name, callCount, isMcp, isCustom });
  }

  // Sort by callCount descending
  tools.sort((a, b) => b.callCount - a.callCount);

  const totalToolCalls = Array.from(toolCounts.values()).reduce(
    (sum, c) => sum + c,
    0
  );

  return {
    models: Array.from(modelSet).sort(),
    tools,
    mcpPlugins: mcpPlugins.sort(),
    customTools: customTools.sort(),
    reasoningUsed,
    messageCount: messages.length,
    toolCallCount: totalToolCalls,
    roles: { ...roleCounts },
    startedAt,
    endedAt,
  };
}

/**
 * Categorise a tool name → inferred sub-agent label.
 * Returns undefined if no known category.
 */
export function categorise(toolName: string): string | undefined {
  return TOOL_CATEGORY_MAP[toolName];
}

/**
 * Build a human-readable summary string for display.
 */
export function formatSubAgentSummary(summary: SessionSubAgentSummary): string {
  const parts: string[] = [];

  if (summary.models.length > 0) {
    parts.push(`Models: ${summary.models.join(", ")}`);
  }

  // Group tools by inferred sub-agent
  const categoryGroups = new Map<string, number>();
  const uncategorised: ToolUsage[] = [];

  for (const tool of summary.tools) {
    const cat = categorise(tool.name);
    if (cat) {
      const prev = categoryGroups.get(cat) ?? 0;
      categoryGroups.set(cat, prev + tool.callCount);
    } else {
      uncategorised.push(tool);
    }
  }

  if (categoryGroups.size > 0) {
    const cats = Array.from(categoryGroups.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `${cat}(${count})`)
      .join(", ");
    parts.push(`Sub-agents: ${cats}`);
  }

  if (summary.tools.length > 0) {
    parts.push(
      `${summary.tools.length} tool types, ${summary.toolCallCount} calls`
    );
  }

  if (summary.mcpPlugins.length > 0) {
    parts.push(`MCP: ${summary.mcpPlugins.join(", ")}`);
  }

  if (summary.customTools.length > 0) {
    parts.push(
      `Custom: ${summary.customTools.map((t) => `CustomTool:${t}`).join(", ")}`
    );
  }

  if (summary.reasoningUsed) {
    parts.push("Reasoning: yes");
  }

  return parts.join(" | ");
}

/**
 * Get a one-line summary for the TUI status bar.
 */
export function formatStatusLine(summary: SessionSubAgentSummary): string {
  const parts: string[] = [];
  if (summary.models.length > 0) {
    parts.push(summary.models[0]);
  }
  parts.push(`${summary.messageCount} msgs`);
  if (summary.toolCallCount > 0) {
    parts.push(`${summary.toolCallCount} tools`);
  }
  if (summary.reasoningUsed) {
    parts.push("💭");
  }
  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// Fork chain utilities
// ---------------------------------------------------------------------------

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
 */
export function buildForkChain(
  session: { id: string; parentSessionId?: string; agent: string; alias: string; title?: string; forkedAt?: string },
  resolveParent: (sessionId: string) => typeof session | null
): ForkChainNode[] {
  const chain: ForkChainNode[] = [];
  let current: typeof session | null = session;
  let depth = 0;

  while (current) {
    chain.unshift({
      sessionId: current.id,
      title: current.title || current.id,
      agent: current.agent,
      alias: current.alias,
      forkedAt: current.forkedAt,
      parentSessionId: current.parentSessionId,
      depth,
    });
    depth++;
    current = current.parentSessionId
      ? resolveParent(current.parentSessionId)
      : null;
  }

  return chain;
}