/**
 * Text formatters for CLI output
 * 
 * Provides human-readable output formatting for:
 * - Session lists (table format)
 * - Session details (conversation format)
 * - Message formatting with role badges
 * - Tool visibility handling
 * - Timestamp display in local timezone
 * - ID truncation for readability
 */

import { SessionSummary, SessionDetail, SessionMessage, SessionPart } from "../../core/types";
import { formatRoleBadge, formatMetadata } from "../utils/colors";

// ============================================================================
// Types
// ============================================================================

export interface ReadQuery {
  agent: string;
  alias: string;
  id: string;
}

export interface TextFormatterOptions {
  showTools?: boolean;
}

// ============================================================================
// Session List Formatting
// ============================================================================

/**
 * Format a single session row for the sessions list
 * 
 * Format: [agent:alias] TITLE                    SESSION_ID    MSG   LAST_ACTIVITY
 * 
 * When title is empty/missing, uses session ID as title with different layout:
 * Format: [agent:alias] SESSION_ID...            MSG   LAST_ACTIVITY
 */
export function formatSessionRow(session: SessionSummary): string {
  const label = `[${session.agent}:${session.alias}]`;
  const title = session.title.trim().length > 0 ? session.title : session.id;
  const sessionId = truncateId(session.id, 20);
  const messageCount = session.message_count.toString().padStart(4, " ");
  const lastActivity = formatRelativeTime(session.updated_at);
  
  if (title === session.id) {
    // No title - show session ID prominently
    return `${label} ${sessionId.padEnd(23)} ${messageCount} msg  ${lastActivity}`;
  }
  
  // Has title - show title with session ID
  const displayTitle = truncateText(title, 40);
  return `${label} ${displayTitle.padEnd(40)} ${sessionId.padEnd(23)} ${messageCount} msg  ${lastActivity}`;
}

/**
 * Format multiple sessions as a table (one row per line)
 */
export function formatSessionsTable(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return "No sessions found.\n";
  }
  return sessions.map(formatSessionRow).join("\n") + "\n";
}

/**
 * Format sessions as JSON
 */
export function formatSessionsJson(sessions: SessionSummary[]): string {
  const output = sessions.map(session => ({
    id: session.id,
    agent: session.agent,
    alias: session.alias,
    title: session.title,
    message_count: session.message_count,
    created_at: session.created_at,
    updated_at: session.updated_at,
    storage: session.storage,
  }));
  return JSON.stringify(output, null, 2) + "\n";
}

// ============================================================================
// Session Detail Formatting
// ============================================================================

/**
 * Format session detail for the read command
 * 
 * Includes:
 * - Session header (id, title, timestamps, message count, storage)
 * - Warning (if any)
 * - Messages (if any)
 */
export function formatSessionDetail(
  detail: SessionDetail,
  target: ReadQuery,
  options?: TextFormatterOptions
): string {
  const lines: string[] = [];

  // Header
  const title = normalizeTitle(detail.title, detail.id);
  lines.push(`Session [${target.agent}:${target.alias}]`);
  lines.push(`id: ${detail.id}`);
  lines.push(`title: ${title}`);
  lines.push(`created_at: ${formatLocalTimestamp(detail.created_at)}`);
  lines.push(`updated_at: ${formatLocalTimestamp(detail.updated_at)}`);
  lines.push(`message_count: ${detail.message_count}`);
  lines.push(`storage: ${detail.storage}`);
  lines.push("");

  // Warning (if any)
  if (detail.warning) {
    lines.push(`Warning: ${detail.warning}`);
    lines.push("");
  }

  // Messages - show only if there are messages
  const messages = detail.messages ?? [];
  if (messages.length > 0) {
    lines.push(`Messages (${messages.length}):`);
    lines.push("---");
    for (const message of messages) {
      lines.push(...formatMessage(message, options));
      lines.push("---");
    }
  }
  // If no messages, show metadata only (no "No messages." text)

  return lines.join("\n");
}

/**
 * Format session detail as JSON
 */
export function formatSessionDetailJson(detail: SessionDetail): string {
  const output = {
    session: {
      id: detail.id,
      agent: detail.agent,
      alias: detail.alias,
      title: detail.title,
      message_count: detail.message_count,
      created_at: detail.created_at,
      updated_at: detail.updated_at,
      storage: detail.storage,
      clone: detail.clone,
      warning: detail.warning,
    },
    messages: detail.messages ?? [],
  };
  return JSON.stringify(output, null, 2) + "\n";
}

// ============================================================================
// Message Formatting
// ============================================================================

/**
 * Format a single message with role badge, timestamp, and content
 * 
 * Format:
 *   > USER (agent/model) @ timestamp
 *   
 *   message content...
 */
export function formatMessage(
  message: SessionMessage,
  options?: TextFormatterOptions
): string[] {
  const lines: string[] = [];
  const roleBadge = formatRoleBadge(message.role);
  const timestamp = formatLocalTimestamp(message.created_at);

  // Build agent/model suffix
  let agentModel = "";
  if (message.agent || message.modelID) {
    const agent = message.agent || "";
    const model = message.modelID || "";
    agentModel = ` (${agent}/${model})`;
  }

  // Format: "> USER (agent/model) @ timestamp"
  const metadata = formatMetadata(`${agentModel} @ ${timestamp}`);
  lines.push(`${roleBadge}${metadata}`);
  lines.push("");

  for (const part of message.parts) {
    lines.push(...formatPart(part, options));
  }

  return lines;
}

/**
 * Format a message part
 * 
 * - text: Indented text content
 * - tool: Tool name and status (hidden by default, shown with --tools)
 * - reasoning: Indented reasoning content
 */
export function formatPart(
  part: SessionPart,
  options?: TextFormatterOptions
): string[] {
  if (part.type === "text") {
    const text = (part as { text: string }).text.trim();
    return text.split("\n").map((line) => `  ${line}`);
  }

  if (part.type === "tool") {
    const toolPart = part as { tool: string; state: Record<string, unknown> };
    
    // By default, hide tool messages unless showTools is true
    if (!options?.showTools) {
      return [];
    }
    
    // Show tool name and status when --tools flag is used
    const status = toolPart.state?.status ?? "unknown";
    return [`  [tool: ${toolPart.tool} - ${status}]`];
  }

  if (part.type === "reasoning") {
    const reasoningPart = part as { text: string };
    return [`  [reasoning]`, ...reasoningPart.text.trim().split("\n").map((l) => `    ${l}`)];
  }

  // Unknown part type
  return [`  [${part.type}]`];
}

// ============================================================================
// Timestamp Formatting
// ============================================================================

/**
 * Format a timestamp as relative time
 * 
 * Examples: "just now", "5m ago", "2h ago", "3d ago", "2024-01-15"
 */
export function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Format a timestamp in local timezone
 * 
 * Format: "2024-01-15 14:30:45"
 */
export function formatLocalTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Format a timestamp as local date only
 * 
 * Format: "2024-01-15"
 */
export function formatLocalDate(timestamp: string): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ============================================================================
// ID and Text Truncation
// ============================================================================

/**
 * Truncate an ID for readability
 * 
 * If ID is longer than maxLength, truncate and add "..."
 */
export function truncateId(id: string, maxLength: number = 20): string {
  if (id.length <= maxLength) {
    return id;
  }
  return id.substring(0, maxLength) + "...";
}

/**
 * Truncate text for display
 * 
 * If text is longer than maxLength, truncate and add "..."
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + "...";
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize title - return ID if title is empty
 */
function normalizeTitle(title: string, id: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : id;
}

/**
 * Format errors for display
 */
export function formatErrors(errors: Array<{ agent: string; alias: string; message: string }>): string {
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
