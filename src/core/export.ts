/**
 * Export — R-16 (CSF) and R-17 (Markdown/text)
 *
 * Provides export functions for SessionDetail:
 *   - toCsf(): Canonical Session Format (structured JSON)
 *   - toMarkdown(): Human-readable markdown
 *   - toText(): Plain text
 *
 * @file src/core/export.ts
 */

import type {
  SessionDetail,
  SessionMessage,
  SessionPart,
} from "./types";

// ---------------------------------------------------------------------------
// CSF — Canonical Session Format
// ---------------------------------------------------------------------------

/**
 * Export a session to Canonical Session Format (CSF).
 * CSF is a structured, portable JSON format suitable for cross-agent transfer.
 */
export interface CsfExport {
  /** Format version */
  version: "1.0";
  /** Source agent that created this export */
  source: {
    agent: string;
    alias: string;
    session_id: string;
    title: string;
    created_at: string;
    updated_at: string;
    message_count: number;
  };
  /** Messages in the session */
  messages: CsfMessage[];
  /** Optional clone metadata if session was cloned */
  clone?: {
    src?: {
      agent?: string;
      session_id?: string;
      version?: string;
    };
    dst?: {
      agent?: string;
      session_id?: string;
      version?: string;
    };
  };
  /** ISO-8601 timestamp of this export */
  exported_at: string;
  /** Optional parent session ID if this was forked */
  parent_session_id?: string;
}

export interface CsfMessage {
  id: string;
  role: "user" | "assistant" | "system";
  created_at: string;
  modelID?: string;
  agent?: string;
  parts: CsfPart[];
}

export interface CsfPart {
  type: string;
  [key: string]: unknown;
}

export function toCsf(detail: SessionDetail): CsfExport {
  return {
    version: "1.0",
    source: {
      agent: detail.agent,
      alias: detail.alias,
      session_id: detail.id,
      title: detail.title,
      created_at: detail.created_at,
      updated_at: detail.updated_at,
      message_count: detail.message_count,
    },
    messages: detail.messages?.map(toCsfMessage) ?? [],
    clone: detail.clone,
    exported_at: new Date().toISOString(),
    parent_session_id: detail.parentSessionId,
  };
}

function toCsfMessage(msg: SessionMessage): CsfMessage {
  return {
    id: msg.id,
    role: msg.role,
    created_at: msg.created_at,
    modelID: msg.modelID,
    agent: msg.agent,
    parts: msg.parts.map(toCsfPart),
  };
}

function toCsfPart(part: SessionPart): CsfPart {
  return part as CsfPart;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * Export a session to a human-readable Markdown format.
 */
export function toMarkdown(detail: SessionDetail): string {
  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push(`title: "${escapeMarkdown(detail.title || detail.id)}"`);
  lines.push(`agent: ${detail.agent}`);
  lines.push(`alias: ${detail.alias}`);
  lines.push(`id: ${detail.id}`);
  lines.push(`created_at: ${detail.created_at}`);
  lines.push(`updated_at: ${detail.updated_at}`);
  lines.push(`message_count: ${detail.message_count}`);
  if (detail.parentSessionId) {
    lines.push(`parent_session_id: ${detail.parentSessionId}`);
  }
  lines.push("---");
  lines.push("");

  // Title
  lines.push(`# ${escapeMarkdown(detail.title || detail.id)}`);
  lines.push("");
  lines.push(`**Agent:** \`${detail.agent}:${detail.alias}\` · **Session ID:** \`${detail.id}\``);
  lines.push("");

  // Clone metadata
  if (detail.clone) {
    lines.push("## Clone Info");
    lines.push("");
    if (detail.clone.src) {
      const src = detail.clone.src;
      lines.push(`- **Source agent:** ${src.agent ?? "unknown"}`);
      lines.push(`- **Source session:** ${src.session_id ?? "unknown"}`);
    }
    if (detail.clone.dst) {
      const dst = detail.clone.dst;
      lines.push(`- **Destination agent:** ${dst.agent ?? "unknown"}`);
      lines.push(`- **Destination session:** ${dst.session_id ?? "unknown"}`);
    }
    lines.push("");
  }

  // Messages
  lines.push("## Messages");
  lines.push("");

  if (!detail.messages || detail.messages.length === 0) {
    lines.push("*No messages in this session.*");
    lines.push("");
    return lines.join("\n");
  }

  for (const msg of detail.messages) {
    const roleLabel = capitalize(msg.role);
    const meta: string[] = [];
    if (msg.modelID) meta.push(`model: ${msg.modelID}`);
    if (msg.agent) meta.push(`agent: ${msg.agent}`);
    const metaLine = meta.length > 0 ? ` *( ${meta.join(" · ")} )*` : "";

    lines.push(`### ${roleLabel}${metaLine}`);
    lines.push("");

    for (const part of msg.parts) {
      lines.push(formatPartAsMarkdown(part));
    }

    lines.push("");
    lines.push(`*[${msg.id}] — ${msg.created_at}*`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

/**
 * Export a session to a plain text format (no markdown, no ANSI codes).
 */
export function toText(detail: SessionDetail): string {
  const lines: string[] = [];
  const SEP = "─".repeat(60);

  lines.push(`Session: ${detail.title || detail.id}`);
  lines.push(`Agent: ${detail.agent}:${detail.alias}`);
  lines.push(`ID: ${detail.id}`);
  lines.push(`Created: ${detail.created_at}`);
  lines.push(`Updated: ${detail.updated_at}`);
  lines.push(`Messages: ${detail.message_count}`);
  if (detail.parentSessionId) {
    lines.push(`Parent: ${detail.parentSessionId}`);
  }
  if (detail.clone) {
    lines.push(SEP);
    lines.push("CLONE INFO");
    if (detail.clone.src) {
      lines.push(`  From: ${detail.clone.src.agent ?? "?"}/${detail.clone.src.session_id ?? "?"}`);
    }
    if (detail.clone.dst) {
      lines.push(`  To:   ${detail.clone.dst.agent ?? "?"}/${detail.clone.dst.session_id ?? "?"}`);
    }
  }
  lines.push(SEP);
  lines.push("");

  if (!detail.messages || detail.messages.length === 0) {
    lines.push("(No messages)");
    return lines.join("\n");
  }

  for (const msg of detail.messages) {
    const meta: string[] = [msg.role];
    if (msg.modelID) meta.push(`model=${msg.modelID}`);
    if (msg.agent) meta.push(`agent=${msg.agent}`);

    lines.push(`[${meta.join(" | ")}] ${msg.created_at}`);
    lines.push("");

    for (const part of msg.parts) {
      lines.push(formatPartAsText(part));
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPartAsMarkdown(part: SessionPart): string {
  if (part.type === "text") {
    return escapeMarkdown((part as { text: string }).text) + "\n";
  } else if (part.type === "tool") {
    return `> **Tool:** \`${escapeMarkdown((part as { tool: string }).tool)}\`\n`;
  } else if (part.type === "reasoning") {
    return `> *${escapeMarkdown((part as { text: string }).text)}*\n`;
  }
  // Fallback for unknown part types
  const { type: _type, ...rest } = part as Record<string, unknown>;
  return `\`\`\`\n${JSON.stringify(rest, null, 2)}\n\`\`\`\n`;
}

function formatPartAsText(part: SessionPart): string {
  if (part.type === "text") {
    return indentText((part as { text: string }).text, 2);
  } else if (part.type === "tool") {
    return `  [TOOL] ${(part as { tool: string }).tool}`;
  } else if (part.type === "reasoning") {
    return indentText(`[REASONING] ${(part as { text: string }).text}`, 2);
  }
  // Unknown type → JSON fallback
  const { type: _type, ...rest } = part as Record<string, unknown>;
  return indentText(JSON.stringify(rest), 2);
}

function indentText(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/#/g, "\\#");
}
