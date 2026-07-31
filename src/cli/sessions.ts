import { AgentEntry, AgentKind, Config } from "../config/types";
import { SessionSummary, TimeRangeOptions } from "../core/types";
import { CliResult } from "./types";
import { parseLastDuration, parseTimestamp, ParseResult } from "./utils/time-parser";
import { formatSessionRow, formatSessionsJson, formatErrors } from "./formatters/text";
import type { FormatSessionRowOptions } from "./formatters/text";
import { resolveConfig, errorResult, errorMessage } from "./utils/config";
import { isAgentKind, formatList, listAgents, listAliases } from "./utils/agents";

const USAGE = `Usage: oas sessions [options]

Options:
  --last DURATION     Last duration (e.g., 4h, 2d, 1w)
  --since TIMESTAMP   Start time (ISO-8601 format)
  --until TIMESTAMP   End time (ISO-8601 format)
  --limit N           Maximum results (default: 50, 0 = all)
  --format FORMAT     Output format: text (default) or json

Time formats:
  --last 4h           Last 4 hours
  --last 2d           Last 2 days
  --last 1w           Last 1 week
  --since 2026-03-05T14:00:00Z
  --until 2026-03-08T00:00:00Z

Default: last 24h, limit 50, text format`;

// ============================================================================
// Types
// ============================================================================

export type SessionsService = (options: SessionsQuery) => Promise<SessionsResult>;

export type SessionsQuery = {
  cwd: string;
  timeRange: TimeRangeOptions;
  agent?: AgentKind;
  alias?: string;
};

export type SessionsResult = {
  sessions: SessionSummary[];
  errors: SessionsError[];
};

export type SessionsError = {
  agent: AgentKind;
  alias: string;
  message: string;
};

export type SessionsOptions = {
  last?: string;
  since?: string;
  until?: string;
  limit?: number;
  format?: "text" | "json";
  full?: boolean;
  showAlias?: boolean;
  agent?: string;
  alias?: string;
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
  getSessions: SessionsService;
};

// ============================================================================
// Main Command
// ============================================================================

export async function runSessionsCommand(options: SessionsOptions): Promise<CliResult> {
  // Validate --format is either "text" or "json" when provided
  if (options.format !== undefined) {
    if (options.format !== "text" && options.format !== "json") {
      return errorResult(`Invalid --format value: must be 'text' or 'json'.`);
    }
  }

  // Resolve config
  const configResult = resolveConfig(options, USAGE);
  if (!configResult.ok) {
    return errorResult(configResult.error);
  }

  const enabledEntries = configResult.value.agents.filter((entry) => entry.enabled);

  // Parse agent/alias filters (mirrors src/cli/list.ts pattern)
  const agentResult = parseAgent(options.agent, enabledEntries);
  if (!agentResult.ok) {
    return errorResult(agentResult.error);
  }

  const aliasResult = parseAlias(options.alias, enabledEntries);
  if (!aliasResult.ok) {
    return errorResult(aliasResult.error);
  }

  // Parse time range
  const timeRangeResult = parseTimeRange(options);
  if (!timeRangeResult.ok) {
    return errorResult(timeRangeResult.error);
  }

  const timeRange = timeRangeResult.value;

  // Build query
  const query: SessionsQuery = {
    cwd: process.cwd(),
    timeRange,
    agent: agentResult.value,
    alias: aliasResult.value,
  };

  // Fetch sessions
  let result: SessionsResult;
  try {
    result = await options.getSessions(query);
  } catch (error) {
    return errorResult(errorMessage(error));
  }

  const stderr = formatErrors(result.errors);
  if (result.sessions.length === 0) {
    return {
      exitCode: 0,
      stdout: options.format === "json" ? "[]\n" : "No sessions found.\n",
      stderr,
    };
  }

  const stdout = options.format === "json"
    ? formatSessionsJson(result.sessions)
    : result.sessions.map((s) => formatSessionRow(s, { full: options.full, showAlias: options.showAlias })).join("\n") + "\n";
  
  return {
    exitCode: 0,
    stdout,
    stderr,
  };
}

// Config resolution: imported from ./utils/config

// ============================================================================
// Time Range Parsing
// ============================================================================

function parseTimeRange(options: SessionsOptions): ParseResult<TimeRangeOptions> {
  const now = Date.now();
  
  // Validate --limit is a number when provided
  if (options.limit !== undefined) {
    if (typeof options.limit !== "number" || isNaN(options.limit)) {
      return {
        ok: false,
        error: `Invalid --limit value: must be a number.`,
      };
    }
  }
  
  const limit = options.limit ?? 50;
  const MAX_LIST_LIMIT = 2000;
  const effectiveLimit = limit === 0 ? MAX_LIST_LIMIT : Math.min(limit, MAX_LIST_LIMIT);
  const result: TimeRangeOptions = {
    limit: effectiveLimit,
  };

  // Parse --until first (if specified, it becomes the reference point for --last)
  if (options.until) {
    const untilResult = parseTimestamp(options.until);
    if (!untilResult.ok) {
      return untilResult;
    }
    result.until = untilResult.value;
    
    // Check if --until is in the future
    if (result.until > now) {
      return {
        ok: false,
        error: `Time range cannot be in the future.`,
      };
    }
  }

  // Determine reference point for --last (use --until if specified, otherwise now)
  const referencePoint = result.until ?? now;

  // Parse --last (relative time)
  if (options.last) {
    const lastResult = parseLastDuration(options.last, referencePoint);
    if (!lastResult.ok) {
      return lastResult;
    }
    result.since = lastResult.value;
  }

  // Parse --since (absolute time) - overrides --last if both specified
  if (options.since) {
    const sinceResult = parseTimestamp(options.since);
    if (!sinceResult.ok) {
      return sinceResult;
    }
    result.since = sinceResult.value;
  }

  // Validate time range
  if (result.since !== undefined && result.until !== undefined) {
    if (result.since > result.until) {
      return {
        ok: false,
        error: `Invalid time range: --since is after --until.`,
      };
    }
  }

  // Check if --since is in the future (only if --until is not specified, since --until validation already happened)
  if (result.since !== undefined && result.until === undefined && result.since > now) {
    return {
      ok: false,
      error: `Time range cannot be in the future.`,
    };
  }

  // Default: last 24h when no time filters AND no --limit flag was specified.
  // options.limit === undefined means no --limit was passed → apply 24h default.
  // options.limit === 0     means explicit --limit 0 → no time restriction (show all).
  // options.limit > 0       means explicit limit → apply 24h default.
  if (result.since === undefined && result.until === undefined && options.limit === undefined) {
    result.since = now - 24 * 60 * 60 * 1000;
  }

  return { ok: true, value: result };
}

// ============================================================================
// Helpers
// ============================================================================

// Error/formatting helpers: imported from ./utils/config

// Agent/alias parsing helpers: mirror src/cli/list.ts parseAgent/parseAlias.
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
