import { AgentEntry, AgentKind, Config } from "../config/types";
import { SessionSummary, TimeRangeOptions } from "../core/types";
import { CliResult } from "./types";
import { parseLastDuration, parseTimestamp, ParseResult } from "./utils/time-parser";
import { formatSessionRow, formatSessionsJson, formatErrors } from "./formatters/text";

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
  const configResult = resolveConfig(options);
  if (!configResult.ok) {
    return errorResult(configResult.error);
  }

  const enabledEntries = configResult.value.agents.filter((entry) => entry.enabled);

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
    : result.sessions.map(formatSessionRow).join("\n") + "\n";
  
  return {
    exitCode: 0,
    stdout,
    stderr,
  };
}

// ============================================================================
// Config Resolution
// ============================================================================

type ConfigResult = { ok: true; value: Config } | { ok: false; error: string };

function resolveConfig(options: {
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
}): ConfigResult {
  if (options.config) {
    return { ok: true, value: options.config };
  }

  if (options.configPath && options.loadConfig) {
    try {
      return { ok: true, value: options.loadConfig(options.configPath) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  return { ok: false, error: `Missing config. ${USAGE}` };
}

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
  
  const result: TimeRangeOptions = {
    limit: options.limit ?? 50,
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

  // Default: last 24h if no time filters specified
  if (result.since === undefined && result.until === undefined) {
    result.since = now - 24 * 60 * 60 * 1000; // 24 hours ago
  }

  return { ok: true, value: result };
}

// ============================================================================
// Helpers
// ============================================================================

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

function errorResult(message: string): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${message}\n`,
  };
}
