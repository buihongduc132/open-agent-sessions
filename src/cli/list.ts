import { AgentEntry, AgentKind } from "../config/types";
import { SessionListQuery, SessionListResult } from "../core/list";
import { SessionSummary } from "../core/types";
import { CliResult } from "./types";
import { type ConfigOptions, type ParseResult, resolveConfig, errorResult, errorMessage } from "./utils/config";
import { sanitizeTitle } from "./utils/format";
import { formatErrors } from "./formatters/text";
import { isAgentKind, formatList, listAgents, listAliases, compareAgents } from "./utils/agents";
import { formatSessionsJson } from "./formatters/json";

const USAGE = "Usage: oas list [--agent <agent>] [--alias <alias>] [--q <query>] [--limit <n>] [--after <cursor>] [--format text|json]";

export type ListService = (query: SessionListQuery) => Promise<SessionListResult>;

export type ListOptions = {
  agent?: string;
  alias?: string;
  q?: string;
  limit?: number;
  after?: string;
  /** Filter to only root sessions (sessions with no parent). */
  rootsOnly?: boolean;
  /** Filter to only sub-agent sessions (sessions with a parent). */
  subOnly?: boolean;
  /** Filter to only sessions that are direct children of this parent session ID. */
  childrenOf?: string;
  /** Include sub-agent sessions in output (overrides default hiding). */
  includeSubagents?: boolean;
  full?: boolean;
  showAlias?: boolean;
  format?: "text" | "json";
  list: ListService;
} & ConfigOptions;

export async function runListCommand(options: ListOptions): Promise<CliResult> {
  const configResult = resolveConfig(options, USAGE);
  if (!configResult.ok) {
    return errorResult(configResult.error);
  }

  // Validate mutually exclusive flags
  if (options.rootsOnly && options.childrenOf !== undefined) {
    return errorResult("Cannot use --roots-only and --children-of together: they are mutually exclusive.");
  }

  if (options.rootsOnly && options.subOnly) {
    return errorResult("Cannot use --roots-only and --sub-only together: they are mutually exclusive.");
  }

  if (options.subOnly && options.childrenOf !== undefined) {
    return errorResult("Cannot use --sub-only and --children-of together: they are mutually exclusive.");
  }

  if (options.includeSubagents && options.rootsOnly) {
    return errorResult("Cannot use --include-subagents and --roots-only together: they are mutually exclusive.");
  }

  const enabledEntries = configResult.value.agents.filter((entry) => entry.enabled);
  const agentResult = parseAgent(options.agent, enabledEntries);
  if (!agentResult.ok) {
    return errorResult(agentResult.error);
  }

  const aliasResult = parseAlias(options.alias, enabledEntries);
  if (!aliasResult.ok) {
    return errorResult(aliasResult.error);
  }

  const query: SessionListQuery = {
    agent: agentResult.value,
    alias: aliasResult.value,
    q: normalizeQuery(options.q),
    limit: options.limit,
    after: options.after,
  };

  let result: SessionListResult;
  try {
    result = await options.list(query);
  } catch (error) {
    return errorResult(errorMessage(error));
  }

  // Apply rootsOnly filter: only sessions with no parentSessionId
  let sessions = result.sessions;
  if (options.rootsOnly) {
    sessions = sessions.filter((s) => !s.parentSessionId);
  }

  // Apply childrenOf filter: only sessions whose parent is the specified ID
  if (options.childrenOf !== undefined) {
    sessions = sessions.filter((s) => s.parentSessionId === options.childrenOf);
  }

  // Apply subOnly filter: only sessions with a parentSessionId
  if (options.subOnly) {
    sessions = sessions.filter((s) => !!s.parentSessionId);
  }

  // Determine badge mode for formatting
  // - includeSubagents: show all, no badges
  // - childrenOf/subOnly: filtered view, no badges
  // - default/rootsOnly: hide children, show +N badges
  const showBadges = !options.includeSubagents && options.childrenOf === undefined && !options.subOnly;
  const hideChildren = showBadges && !options.rootsOnly; // rootsOnly already filters them

  if (hideChildren) {
    // Default mode: hide child sessions, show only roots with child count badges
    sessions = sessions.filter((s) => !s.parentSessionId);
  }

  const stderr = formatErrors(result.errors);
  if (options.format !== undefined && options.format !== "text" && options.format !== "json") {
    return errorResult(`Invalid --format value: must be 'text' or 'json'.`);
  }

  if (sessions.length === 0) {
    return {
      exitCode: 0,
      stdout: options.format === "json" ? "[]\n" : "No sessions found.\n",
      stderr,
    };
  }

  if (options.format === "json") {
    return { exitCode: 0, stdout: formatSessionsJson(sessions), stderr };
  }
  const rowOpts = { full: options.full, showAlias: options.showAlias };

  // Build child count map for badge display
  let childCounts: Map<string, number> | undefined;
  if (showBadges) {
    childCounts = new Map<string, number>();
    for (const s of result.sessions) {
      if (s.parentSessionId) {
        childCounts.set(s.parentSessionId, (childCounts.get(s.parentSessionId) ?? 0) + 1);
      }
    }
  }

  const stdout = sessions.map((s) => formatSessionRow(s, showBadges, childCounts, rowOpts)).join("\n") + "\n";
  return {
    exitCode: 0,
    stdout,
    stderr,
  };
}

function parseAgent(
  agentValue: string | undefined,
  entries: AgentEntry[]
): ParseResult<AgentKind | undefined> {
  const trimmed = agentValue?.trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }

  const available = listAgents(entries);
  const agent = trimmed as AgentKind;
  if (!isAgentKind(agent) || !available.includes(agent)) {
    return {
      ok: false,
      error: `Unknown agent "${trimmed}". Available agents: ${formatList(available)}`,
    };
  }

  return { ok: true, value: agent };
}

function parseAlias(
  aliasValue: string | undefined,
  entries: AgentEntry[]
): ParseResult<string | undefined> {
  const trimmed = aliasValue?.trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }

  const available = listAliases(entries);
  if (!available.includes(trimmed)) {
    return {
      ok: false,
      error: `Unknown alias "${trimmed}". Available aliases: ${formatList(available)}`,
    };
  }

  return { ok: true, value: trimmed };
}

// Agent helpers: imported from ./utils/agents

function normalizeQuery(query: string | undefined): string | undefined {
  if (query === undefined) {
    return undefined;
  }
  const trimmed = query.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function formatSessionRow(
  session: SessionSummary,
  showBadges = false,
  childCounts?: Map<string, number>,
  opts?: { full?: boolean; showAlias?: boolean },
): string {
  const badge = showBadges && !session.parentSessionId
    ? (() => {
        const count = childCounts?.get(session.id) ?? 0;
        return count > 0 ? ` +${count}` : " -";
      })()
    : "";

  const { formatSessionRow: formatRow } = require("./formatters/text");
  const base = formatRow(session, { ...opts, full: true });
  const row = `${base}${badge}`;
  
  return opts?.full ? row : truncateText(row, 100);
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + "...";
}

// Formatting helpers: imported from ./utils/agents
