/**
 * Shared agent resolution helpers.
 *
 * DRY consolidation of patterns duplicated across detail.ts, read.ts,
 * clone.ts, export.ts, list.ts, similar.ts.
 */

import { AgentEntry, AgentKind } from "../../config/types";
import { AGENT_ORDER, isAgentKind as isAgentKindCore } from "../../core/constants";
import type { ParseResult } from "./config";

// ============================================================================
// Agent Kind Validation
// ============================================================================

export function isAgentKind(agent: string): agent is AgentKind {
  return isAgentKindCore(agent);
}

// ============================================================================
// Agent Listing & Comparison
// ============================================================================



/**
 * Compare two agent kinds for deterministic ordering.
 *
 * Previously duplicated in detail.ts, read.ts, list.ts.
 */
export function compareAgents(a: AgentKind, b: AgentKind): number {
  return AGENT_ORDER[a] - AGENT_ORDER[b];
}

/**
 * List unique agent kinds from enabled entries, sorted by canonical order.
 *
 * Previously duplicated in detail.ts, read.ts, list.ts.
 */
export function listAgents(entries: AgentEntry[]): AgentKind[] {
  const seen = new Set<AgentKind>();
  for (const entry of entries) {
    seen.add(entry.agent);
  }
  return Array.from(seen).sort(compareAgents);
}

/**
 * List unique aliases from enabled entries, sorted alphabetically.
 *
 * Previously duplicated in list.ts (as `listAliases`).
 */
export function listAliases(entries: AgentEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    seen.add(entry.alias);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

// ============================================================================
// Alias Helpers
// ============================================================================

/**
 * Get all aliases for a specific agent, sorted alphabetically.
 *
 * Previously duplicated in detail.ts, read.ts, clone.ts, export.ts.
 */
export function aliasesForAgent(agent: AgentKind, entries: AgentEntry[]): string[] {
  return entries
    .filter((entry) => entry.agent === agent)
    .map((entry) => entry.alias)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Validate that an alias exists for a given agent.
 *
 * Previously duplicated in detail.ts, read.ts, clone.ts, export.ts.
 */
export function validateAlias(
  agent: AgentKind,
  alias: string,
  entries: AgentEntry[],
): ParseResult<string> {
  const aliases = aliasesForAgent(agent, entries);
  if (!aliases.includes(alias)) {
    return {
      ok: false,
      error: `Unknown alias "${alias}" for ${agent}. Available aliases: ${formatList(aliases)}`,
    };
  }
  return { ok: true, value: alias };
}

/**
 * Infer the alias when only the agent is known.
 * Returns the alias if exactly one exists, otherwise an error.
 *
 * Previously duplicated in detail.ts, read.ts, clone.ts.
 */
export function inferAlias(agent: AgentKind, entries: AgentEntry[]): ParseResult<string> {
  const aliases = aliasesForAgent(agent, entries);
  if (aliases.length === 1) {
    return { ok: true, value: aliases[0] };
  }
  return {
    ok: false,
    error: `Alias required for ${agent}. Available aliases: ${formatList(aliases)}`,
  };
}

// ============================================================================
// Error Message Helpers
// ============================================================================

/**
 * Build an "unknown agent" error message.
 *
 * Previously duplicated in detail.ts, read.ts, clone.ts, export.ts.
 */
export function unknownAgentError(agent: string, entries: AgentEntry[]): string {
  const available = listAgents(entries);
  return `Unknown agent "${agent}". Available agents: ${formatList(available)}`;
}

/**
 * Build a label like `[agent:alias]` and prepend it to a message if not
 * already present.
 *
 * Previously duplicated in detail.ts, read.ts, export.ts, similar.ts.
 */
export function withLabel(
  target: { agent: string; alias: string },
  message: string,
): string {
  const label = `[${target.agent}:${target.alias}]`;
  return message.includes(label) ? message : `${label} ${message}`;
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format a list of strings for display in error messages.
 *
 * Previously duplicated in detail.ts, read.ts, clone.ts, export.ts, list.ts.
 */
export function formatList(values: string[]): string {
  if (values.length === 0) {
    return "(none)";
  }
  return values.join(", ");
}

// ============================================================================
// Spec Parsing
// ============================================================================

/**
 * Split a colon-separated session spec into parts, filtering empty segments.
 *
 * Previously duplicated in clone.ts, export.ts (without empty filtering),
 * and detail.ts, read.ts (with empty check returning errors).
 *
 * NOTE: This is the lenient version (filters empty segments).
 * detail.ts and read.ts use a stricter version that returns an error
 * if any empty parts exist. Those files keep their own `splitSpec`.
 */
export function splitSpec(spec: string): string[] {
  return spec.split(":").filter((part) => part.length > 0);
}

// ============================================================================
// Title Helpers
// ============================================================================

/**
 * Normalize title — return ID if title is empty/whitespace.
 *
 * Previously duplicated in detail.ts, read.ts, formatters/text.ts.
 */
export function normalizeTitle(title: string, id: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : id;
}
