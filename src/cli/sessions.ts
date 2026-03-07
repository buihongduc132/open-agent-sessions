import { AgentEntry, AgentKind, Config } from "../config/types";
import { SessionSummary, TimeRangeOptions } from "../core/types";
import { CliResult } from "./types";

const USAGE = `Usage: oas sessions [options]

Options:
  --last DURATION     Last duration (e.g., 4h, 2d, 1w)
  --since TIMESTAMP   Start time (ISO-8601 format)
  --until TIMESTAMP   End time (ISO-8601 format)
  --limit N           Maximum results (default: 50, 0 = all)

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
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
  getSessions: SessionsService;
};

// ============================================================================
// Main Command
// ============================================================================

export async function runSessionsCommand(options: SessionsOptions): Promise<CliResult> {
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
      stdout: "No sessions found.\n",
      stderr,
    };
  }

  const stdout = result.sessions.map(formatSessionRow).join("\n") + "\n";
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

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseTimeRange(options: SessionsOptions): ParseResult<TimeRangeOptions> {
  const now = Date.now();
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

/**
 * Parse --last duration format (e.g., "4h", "2d", "1w")
 */
function parseLastDuration(value: string, now: number): ParseResult<number> {
  const trimmed = value.trim();
  
  // Match pattern: number + unit (h/d/w)
  const match = trimmed.match(/^(\d+)([hdw])$/);
  if (!match) {
    return {
      ok: false,
      error: `Invalid time format. Use: 4h, 2d, 1w, or ISO-8601 timestamp (2026-03-05T14:00:00Z)`,
    };
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2];

  if (amount <= 0) {
    return {
      ok: false,
      error: `Invalid --last value: ${value}. Duration must be positive.`,
    };
  }

  let ms: number;
  switch (unit) {
    case "h":
      ms = amount * 60 * 60 * 1000;
      break;
    case "d":
      ms = amount * 24 * 60 * 60 * 1000;
      break;
    case "w":
      ms = amount * 7 * 24 * 60 * 60 * 1000;
      break;
    default:
      return {
        ok: false,
        error: `Invalid time unit: ${unit}. Use h (hours), d (days), or w (weeks).`,
      };
  }

  const since = now - ms;
  return { ok: true, value: since };
}

/**
 * Parse ISO-8601 timestamp with strict timezone requirement
 * 
 * Accepts formats with timezone:
 * - 2024-01-01T00:00:00Z (UTC)
 * - 2024-01-01T00:00:00+00:00 (with offset)
 * - 2024-01-01T00:00:00.000Z (with milliseconds)
 * 
 * Rejects formats without timezone:
 * - 2024-01-01 (date only)
 * - 2024-01-01T00:00:00 (no timezone)
 */
function parseTimestamp(value: string): ParseResult<number> {
  const trimmed = value.trim();
  
  // Strict ISO-8601 pattern requiring timezone
  // Pattern: YYYY-MM-DDTHH:MM:SS[.sss](Z|±HH:MM)
  const iso8601WithTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  
  if (!iso8601WithTimezone.test(trimmed)) {
    return {
      ok: false,
      error: `Invalid timestamp format: "${value}". ISO-8601 with timezone required (e.g., 2024-01-01T00:00:00Z or 2024-01-01T00:00:00+00:00). Date-only strings like "2024-01-01" are not accepted.`,
    };
  }
  
  // Parse the timestamp - timezone is preserved from the input
  const date = new Date(trimmed);
  
  if (isNaN(date.getTime())) {
    return {
      ok: false,
      error: `Invalid timestamp: "${value}". Could not parse as valid date.`,
    };
  }

  return { ok: true, value: date.getTime() };
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatSessionRow(session: SessionSummary): string {
  const label = `[${session.agent}:${session.alias}]`;
  const title = session.title.trim().length > 0 ? session.title : session.id;
  if (title === session.id) {
    return `${label} ${session.id}`;
  }
  return `${label} ${title} (${session.id})`;
}

function formatErrors(errors: SessionsError[]): string {
  if (errors.length === 0) {
    return "";
  }
  return (
    errors
      .map((error) => {
        const label = `[${error.agent}:${error.alias}]`;
        const message = error.message;
        if (message.includes(label)) {
          return message;
        }
        return `${label} ${message}`;
      })
      .join("\n") + "\n"
  );
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
