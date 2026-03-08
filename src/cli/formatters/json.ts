/**
 * JSON formatters for CLI output
 * 
 * Provides machine-readable output formatting for:
 * - Session lists (JSON array format)
 * - Session details (structured object format)
 * - Tool visibility handling (filter tool parts by default)
 * - Timestamps in ISO-8601 UTC format
 */

import { SessionSummary, SessionDetail, SessionMessage, SessionPart } from "../../core/types";

// ============================================================================
// Types
// ============================================================================

export interface JsonFormatterOptions {
  includeTools?: boolean;
}

// ============================================================================
// Timestamp Normalization
// ============================================================================

/**
 * Normalize timestamp to ISO-8601 UTC format
 * 
 * Handles:
 * - ISO-8601 strings (with or without timezone)
 * - Unix timestamps (milliseconds)
 * - Already normalized ISO-8601 UTC strings (pass through)
 * 
 * Output format: "YYYY-MM-DDTHH:MM:SSZ" (always UTC with 'Z' suffix)
 */
function toISO8601UTC(timestamp: string | number): string {
  let date: Date;
  
  if (typeof timestamp === "number") {
    // Unix timestamp (milliseconds)
    date = new Date(timestamp);
  } else if (typeof timestamp === "string") {
    // If already in ISO-8601 UTC format with Z suffix, pass through
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) {
      return timestamp;
    }
    // Parse the timestamp string
    date = new Date(timestamp);
  } else {
    // Fallback: return current time
    date = new Date();
  }
  
  // Validate the date is valid
  if (isNaN(date.getTime())) {
    // Invalid date - return current time as fallback
    date = new Date();
  }
  
  // Convert to ISO-8601 UTC format
  return date.toISOString();
}

// ============================================================================
// Session List Formatting
// ============================================================================

/**
 * Format sessions as a JSON array
 * 
 * Output format:
 * [
 *   {
 *     "id": "ses_...",
 *     "title": "...",
 *     "agent": "...",
 *     "alias": "...",
 *     "message_count": 118,
 *     "created_at": "2026-03-03T13:16:46Z",
 *     "updated_at": "2026-03-03T13:49:20Z"
 *   }
 * ]
 */
export function formatSessionsJson(sessions: SessionSummary[]): string {
  const output = sessions.map(session => ({
    id: session.id,
    title: session.title,
    agent: session.agent,
    alias: session.alias,
    message_count: session.message_count,
    created_at: toISO8601UTC(session.created_at),
    updated_at: toISO8601UTC(session.updated_at),
  }));
  return JSON.stringify(output, null, 2) + "\n";
}

// ============================================================================
// Session Detail Formatting
// ============================================================================

/**
 * Format session detail with messages as JSON
 * 
 * Output format:
 * {
 *   "session": {
 *     "id": "ses_...",
 *     "title": "...",
 *     "agent": "...",
 *     "alias": "...",
 *     "message_count": 118,
 *     "created_at": "2026-03-03T13:16:46Z",
 *     "updated_at": "2026-03-03T13:49:20Z"
 *   },
 *   "messages": [
 *     {
 *       "id": "msg_...",
 *       "role": "user",
 *       "created_at": "...",
 *       "parts": [...]
 *     }
 *   ]
 * }
 * 
 * Tool visibility:
 * - Without includeTools option: parts array excludes type='tool' entries
 * - With includeTools option: parts array includes all types
 */
export function formatMessagesJson(
  detail: SessionDetail,
  options?: JsonFormatterOptions
): string {
  const includeTools = options?.includeTools ?? false;
  
  // Filter tool parts from messages if includeTools is false
  const messages = (detail.messages ?? []).map(message => ({
    id: message.id,
    role: message.role,
    created_at: toISO8601UTC(message.created_at),
    parts: filterParts(message.parts, includeTools),
    ...(message.modelID !== undefined && { modelID: message.modelID }),
    ...(message.agent !== undefined && { agent: message.agent }),
  }));
  
  const output = {
    session: {
      id: detail.id,
      title: detail.title,
      agent: detail.agent,
      alias: detail.alias,
      message_count: detail.message_count,
      created_at: toISO8601UTC(detail.created_at),
      updated_at: toISO8601UTC(detail.updated_at),
      ...(detail.clone !== undefined && { clone: detail.clone }),
      ...(detail.warning !== undefined && { warning: detail.warning }),
    },
    messages,
  };
  
  return JSON.stringify(output, null, 2) + "\n";
}

// ============================================================================
// Part Filtering
// ============================================================================

/**
 * Filter parts based on tool visibility setting
 * 
 * - When includeTools is false: exclude parts with type='tool'
 * - When includeTools is true: include all parts
 */
function filterParts(parts: SessionPart[], includeTools: boolean): SessionPart[] {
  if (includeTools) {
    return parts;
  }
  
  return parts.filter(part => part.type !== "tool");
}
