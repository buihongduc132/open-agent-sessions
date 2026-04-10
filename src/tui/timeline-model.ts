/**
 * src/tui/timeline-model.ts
 *
 * Timeline builder — converts SessionDetail.messages into a chronological
 * flat timeline with sub-agent markers and tool/reasoning annotations.
 *
 * @file src/tui/timeline-model.ts
 */

import type { SessionDetail, SessionMessage, SessionPart } from "../core/types";
import { inferSubAgents, type SessionSubAgentSummary } from "../core/subagents";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  /** 0-based index in the original messages array */
  index: number;
  role: "user" | "assistant" | "system";
  modelID?: string;
  subAgent?: string;       // inferred from modelID mapping
  timestamp: string;
  /** ISO date string, e.g. "2026-04-10 14:22:01" */
  timestampShort: string;
  /** Content: combined text parts */
  preview: string;
  /** First text content (for truncation) */
  firstText: string;
  /** Tool calls in this message */
  toolCalls: ToolCall[];
  /** Whether this message has reasoning blocks */
  hasReasoning: boolean;
  /** Whether this message has any tool calls */
  hasTools: boolean;
  /** Whether this message has text content */
  hasText: boolean;
  /** Raw text content for detail expansion */
  fullText: string;
}

export interface ToolCall {
  tool: string;
  /** Truncated state preview (first 60 chars) */
  statePreview: string;
  /** Inferred sub-agent category */
  category?: string;
}

export interface TimelineRenderLine {
  /** Full rendered line for the timeline row */
  text: string;
  entry: TimelineEntry;
  /** Role indicator: "●", "○", "■" */
  roleIcon: string;
  /** 0-based entry index */
  index: number;
  /** 0-based sub-line index within this entry (0 = header, 1+ = tool rows) */
  subIndex: number;
  /** Whether this is a continuation of a multi-line entry */
  isContinuation: boolean;
  /** Color code for role */
  roleColor: string;
}

export interface TimelineState {
  entries: TimelineEntry[];
  subAgentSummary: SessionSubAgentSummary;
  filter: {
    role?: "user" | "assistant" | "system";
    showTools: boolean;
    showReasoning: boolean;
    showText: boolean;
  };
  selectedIndex: number;
  scrollOffset: number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the full timeline from a SessionDetail.
 */
export function buildTimeline(detail: SessionDetail): TimelineState {
  const subAgentSummary = inferSubAgents(detail);
  const entries = buildEntries(detail.messages ?? []);
  return {
    entries,
    subAgentSummary,
    filter: { showTools: true, showReasoning: true, showText: true },
    selectedIndex: 0,
    scrollOffset: 0,
  };
}

/**
 * Convert raw SessionMessage[] → TimelineEntry[].
 */
export function buildEntries(messages: SessionMessage[]): TimelineEntry[] {
  return messages.map((msg, index) => buildEntry(msg, index));
}

function buildEntry(msg: SessionMessage, index: number): TimelineEntry {
  const toolCalls = buildToolCalls(msg.parts ?? []);
  const textParts = msg.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n");

  const reasoningParts = msg.parts
    .filter((p) => p.type === "reasoning")
    .map((p) => (p as { text: string }).text)
    .join("\n");

  const fullText = [textParts, reasoningParts].filter(Boolean).join("\n\n");
  const preview = truncate(textParts || reasoningParts || "(no text)", 80);
  const firstText = truncate(textParts || reasoningParts || "", 60);

  return {
    index,
    role: msg.role,
    modelID: msg.modelID,
    subAgent: inferSubAgentLabel(msg.modelID),
    timestamp: msg.created_at ?? "",
    timestampShort: formatTimestamp(msg.created_at),
    preview,
    firstText,
    toolCalls,
    hasReasoning: msg.parts.some((p) => p.type === "reasoning"),
    hasTools: toolCalls.length > 0,
    hasText: Boolean(textParts),
    fullText,
  };
}

function buildToolCalls(parts: SessionPart[]): ToolCall[] {
  return parts
    .filter((p) => p.type === "tool")
    .map((p) => {
      const t = p as { tool: string; state?: Record<string, unknown> };
      const statePreview = t.state
        ? truncate(JSON.stringify(t.state).slice(0, 80), 60)
        : "";
      return {
        tool: t.tool ?? "(unknown)",
        statePreview,
        category: undefined, // set below
      };
    })
    .map((tc) => ({ ...tc, category: inferCategory(tc.tool) }));
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const ROLE_COLORS: Record<string, string> = {
  user: "\x1b[34m",       // blue
  assistant: "\x1b[32m",   // green
  system: "\x1b[90m",     // dim
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const TOOL_COLOR = "\x1b[33m";    // yellow
const REASONING_COLOR = "\x1b[36m"; // cyan
const BOLD = "\x1b[1m";

/**
 * Render all visible timeline entries → array of render lines.
 * Respects filter state.
 */
export function renderTimeline(
  state: TimelineState,
  viewportHeight: number
): TimelineRenderLine[] {
  const lines: TimelineRenderLine[] = [];

  const filtered = filterEntries(state.entries, state.filter);

  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i];
    const isSelected = i === state.selectedIndex;
    renderEntry(entry, isSelected, lines);
  }

  return lines.slice(state.scrollOffset, state.scrollOffset + viewportHeight);
}

function filterEntries(
  entries: TimelineEntry[],
  filter: TimelineState["filter"]
): TimelineEntry[] {
  return entries.filter((e) => {
    if (filter.role && e.role !== filter.role) return false;
    if (!filter.showTools && e.hasTools) return false;
    if (!filter.showReasoning && e.hasReasoning) return false;
    if (!filter.showText && e.hasText) return false;
    return true;
  });
}

function renderEntry(
  entry: TimelineEntry,
  isSelected: boolean,
  lines: TimelineRenderLine[]
): void {
  const roleColor = ROLE_COLORS[entry.role] ?? "";
  const icon = entry.role === "user" ? "●" : entry.role === "assistant" ? "●" : "●";
  const selBg = isSelected ? "\x1b[7m" : "";

  // Header row
  const metaParts: string[] = [icon];
  metaParts.push(`${DIM}${entry.timestampShort}${RESET}`);
  if (entry.modelID) {
    metaParts.push(`${roleColor}${entry.modelID}${RESET}`);
  }
  if (entry.subAgent) {
    metaParts.push(`${DIM}[${entry.subAgent}]${RESET}`);
  }

  const metaStr = metaParts.join("  ");
  const textStr = entry.preview
    ? `  ${entry.preview}`
    : "";

  lines.push({
    text: `${selBg}${roleColor}${metaStr}${textStr}${RESET}`,
    entry,
    roleIcon: icon,
    index: entry.index,
    subIndex: 0,
    isContinuation: false,
    roleColor,
  });

  // Tool call rows
  if (entry.toolCalls.length > 0) {
    for (const tc of entry.toolCalls) {
      const catStr = tc.category ? `[${tc.category}] ` : "";
      lines.push({
        text: `${selBg}${TOOL_COLOR}  📎 ${catStr}${tc.tool}${RESET}${tc.statePreview ? ` ${DIM}${tc.statePreview}${RESET}` : ""}`,
        entry,
        roleIcon: "📎",
        index: entry.index,
        subIndex: 1,
        isContinuation: true,
        roleColor: TOOL_COLOR,
      });
    }
  }

  // Reasoning row
  if (entry.hasReasoning) {
    lines.push({
      text: `${selBg}${REASONING_COLOR}  💭 reasoning block${RESET}`,
      entry,
      roleIcon: "💭",
      index: entry.index,
      subIndex: 1,
      isContinuation: true,
      roleColor: REASONING_COLOR,
    });
  }
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/** Move selection to the next visible entry (not sub-line). */
export function moveDown(state: TimelineState, viewportHeight: number): TimelineState {
  const filtered = filterEntries(state.entries, state.filter);
  const newIndex = Math.min(state.selectedIndex + 1, filtered.length - 1);

  // Auto-scroll: if selected goes below viewport, scroll down
  const newOffset =
    newIndex >= state.scrollOffset + viewportHeight
      ? newIndex - viewportHeight + 1
      : state.scrollOffset;

  return { ...state, selectedIndex: newIndex, scrollOffset: Math.max(0, newOffset) };
}

/** Move selection to the previous visible entry. */
export function moveUp(state: TimelineState): TimelineState {
  const newIndex = Math.max(state.selectedIndex - 1, 0);
  const newOffset =
    newIndex < state.scrollOffset ? newIndex : state.scrollOffset;

  return { ...state, selectedIndex: newIndex, scrollOffset: newOffset };
}

/** Toggle tool call visibility. */
export function toggleTools(state: TimelineState): TimelineState {
  return { ...state, filter: { ...state.filter, showTools: !state.filter.showTools } };
}

/** Toggle reasoning visibility. */
export function toggleReasoning(state: TimelineState): TimelineState {
  return {
    ...state,
    filter: { ...state.filter, showReasoning: !state.filter.showReasoning },
  };
}

/** Toggle text visibility. */
export function toggleText(state: TimelineState): TimelineState {
  return { ...state, filter: { ...state.filter, showText: !state.filter.showText } };
}

/** Filter by role. */
export function setRoleFilter(
  state: TimelineState,
  role?: "user" | "assistant" | "system"
): TimelineState {
  return { ...state, selectedIndex: 0, scrollOffset: 0, filter: { ...state.filter, role } };
}

// ---------------------------------------------------------------------------
// Sub-agent label inference
// ---------------------------------------------------------------------------

/** Map known model IDs → human-readable sub-agent labels. */
const MODEL_LABEL_MAP: Record<string, string> = {
  "claude-3-5-sonnet": "Claude 3.5 Sonnet",
  "claude-3-5-sonnet-20250514": "Claude 3.5 Sonnet",
  "claude-3-5-sonnet-20250608": "Claude 3.5 Sonnet",
  "claude-opus-4-20250514": "Claude Opus 4",
  "claude-sonnet-4-20250514": "Claude Sonnet 4",
  "o3": "o3",
  "o3-mini": "o3-mini",
  "o4-mini": "o4-mini",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o mini",
  "gpt-4-turbo": "GPT-4 Turbo",
  "gpt-3.5-turbo": "GPT-3.5 Turbo",
  "Claude-coder": "Claude Coder",
  "codestral": "Codestral",
  "codellama": "Code Llama",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
};

/** Normalize model ID → label. */
function inferSubAgentLabel(modelID?: string): string | undefined {
  if (!modelID) return undefined;
  const lower = modelID.toLowerCase();
  for (const [key, label] of Object.entries(MODEL_LABEL_MAP)) {
    if (lower.includes(key.toLowerCase())) return label;
  }
  return undefined;
}

function inferCategory(toolName: string): string | undefined {
  // Re-use the categorise from subagents.ts
  // (imported at top — using inline version for tree-model compatibility)
  const TOOL_CATEGORY: Record<string, string> = {
    Bash: "Shell/CLI",
    Read: "FileSystem", Write: "FileSystem", Edit: "FileSystem",
    Glob: "FileSystem",
    git_add: "GitOperator", git_commit: "GitOperator",
    git_push: "GitOperator", git_status: "GitOperator",
    WebFetch: "WebSearch", Browser: "WebSearch",
    SearchCode: "CodeSearch",
  };
  return TOOL_CATEGORY[toolName];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxLen: number): string {
  const single = text.replace(/\n/g, " ").trim();
  if (single.length <= maxLen) return single;
  return single.slice(0, maxLen - 1) + "…";
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "?";
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return "?";
  }
}
