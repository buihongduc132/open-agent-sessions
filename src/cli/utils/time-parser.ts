/**
 * Time Parser Utility
 * 
 * Provides functions for parsing time durations and timestamps.
 * Supports:
 * - Duration formats: 4h, 2d, 1w (hours, days, weeks)
 * - ISO-8601 timestamps with timezone: 2024-01-01T00:00:00Z
 * 
 * Does NOT support:
 * - Natural language: "yesterday", "2 hours ago"
 * - Date-only strings: "2024-01-01"
 * - Timestamps without timezone: "2024-01-01T00:00:00"
 */

// ============================================================================
// Types
// ============================================================================

export interface TimeParseResult<T> {
  ok: true;
  value: T;
}

export interface TimeParseError {
  ok: false;
  error: string;
}

export type ParseResult<T> = TimeParseResult<T> | TimeParseError;

// ============================================================================
// Duration Parsing
// ============================================================================

/**
 * Parse --last duration format (e.g., "4h", "2d", "1w")
 * 
 * @param value - Duration string (e.g., "4h", "2d", "1w")
 * @param now - Reference timestamp (milliseconds since epoch)
 * @returns ParseResult with the calculated "since" timestamp or error
 * 
 * @example
 * parseLastDuration("4h", Date.now()) // Returns timestamp 4 hours ago
 * parseLastDuration("2d", Date.now()) // Returns timestamp 2 days ago
 * parseLastDuration("1w", Date.now()) // Returns timestamp 1 week ago
 */
export function parseLastDuration(value: string | number, now: number): ParseResult<number> {
  // Handle non-string inputs
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: `Invalid time format. Use: 4h, 2d, 1w, or ISO-8601 timestamp (2026-03-05T14:00:00Z)`,
    };
  }
  
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

// ============================================================================
// Timestamp Parsing
// ============================================================================

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
 * 
 * @param value - ISO-8601 timestamp string with timezone
 * @returns ParseResult with timestamp in milliseconds or error
 * 
 * @example
 * parseTimestamp("2024-01-01T00:00:00Z")
 * parseTimestamp("2024-01-01T00:00:00+00:00")
 * parseTimestamp("2024-01-01T00:00:00.000Z")
 */
export function parseTimestamp(value: string | number): ParseResult<number> {
  // Handle non-string inputs
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: `Invalid timestamp format. ISO-8601 with timezone required (e.g., 2024-01-01T00:00:00Z or 2024-01-01T00:00:00+00:00).`,
    };
  }
  
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
