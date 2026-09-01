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
    /** Present when this export covers a bounded turn slice of the session */
    slice?: SliceMeta;
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

export interface SliceMeta {
  /** 0-based absolute turn indices, inclusive */
  turn_start: number;
  turn_end: number;
  total_turns: number;
}

export interface PartFilter {
  /** additive: text ∪ selected types */
  include: Set<string>;
}

export const IGNORE_PART_TYPES: ReadonlySet<string> = new Set(["step-start", "step-finish"]);

/** Per-part byte cap applied to markdown/text rendering (csf stays lossless). */
const PART_BYTE_CAP = 64 * 1024;

/** Upper bound for dynamic fence length — pathological backtick floods must not
 *  blow up the file; content runs are broken during escaping anyway (see
 *  breakBacktickRuns), so a capped fence stays strictly longer than any run
 *  that can actually appear in the rendered output. */
const FENCE_LEN_CAP = 16;

/** Part keys that indicate binary-ish payloads, skipped in markdown/text. */
const BINARYISH_KEYS = new Set(["data", "base64", "image", "b64"]);

/** Strip C0 control chars (keep \n and \t) — renders cleanly and is yaml-safe. */
/** Meta-scalar safe for inline markdown: strip newlines/control chars + backticks. */
function mdSafeModel(text: string): string {
  return String(text).replace(/[\u0000-\u001f\u007f`]/g, "").slice(0, 200);
}

/** Code-span-safe name: strip backticks + newlines. */
function codeSpanName(name: string): string {
  return name.replace(/[`\r\n]/g, "");
}

function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

/** Longest backtick run (>=1) in text. */
function longestBacktickRun(text: string): number {
  const m = text.match(/`+/g);
  if (!m) return 0;
  return m.reduce((acc, s) => Math.max(acc, s.length), 0);
}

/** Break backtick runs >=3 in rendered fenced content by inserting a zero-width
 *  space after every 2nd consecutive backtick — keeps the closed fence
 *  unambiguous without ballooning size. */
function breakBacktickRuns(text: string): string {
  return text.replace(/`{3,}/g, (run) => {
    let out = "";
    for (let i = 0; i < run.length; i++) {
      out += "`";
      if (i % 2 === 1 && i !== run.length - 1) out += "\u200B";
    }
    return out;
  });
}

/** Code-point-safe slice by approximate byte budget. */
function sliceByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return { text, truncated: false };
  const chars = Array.from(text);
  let out = "";
  let bytes = 0;
  for (const ch of chars) {
    const b = Buffer.byteLength(ch, "utf-8");
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return { text: out, truncated: true };
}

function isBinaryish(part: SessionPart): boolean {
  for (const key of Object.keys(part as Record<string, unknown>)) {
    if (BINARYISH_KEYS.has(key)) return true;
  }
  return false;
}

/** Escape text-part content for inline markdown rendering: neutralises
 *  link/image/task-list/heading injection at line start and mid-line, without
 *  mangling legit prose (word-internal _ kept, words survive). */
function escapeTextForMarkdown(text: string): string {
  let out = text
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*")
    .replace(/</g, "\\<");
  // line-start markers (before [ ] escaping so raw "- [" is still intact)
  out = out.replace(/^(\s*)#/gm, "$1\\#");
  out = out.replace(/^(\s*)- \[/gm, "$1\\- [");
  out = out.replace(/^(\s*)>/gm, "$1\\>");
  // bracket escaping neutralises link/image/task-list injection, mid-line included
  out = out.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  return out;
}

interface RenderedPart {
  /** Final rendered block (may be multi-line). */
  text: string;
  /** Marker lines emitted after the block (truncation markers, skip notes). */
  tail: string[];
}

function renderUnknownPartFenced(part: SessionPart): RenderedPart {
  // Include `type` in the payload so explicitly-included exotic part types
  // (e.g. step-start) remain identifiable in output.
  const json = JSON.stringify(part, null, 2);
  const { text: capped, truncated } = sliceByBytes(json, PART_BYTE_CAP);
  const escaped = breakBacktickRuns(capped);
  // Fence computed AFTER truncation; longer than any run that can appear
  // (content runs are broken; use pre-escape truncated run for extra margin,
  // capped to keep pathological floods bounded).
  const fenceLen = Math.min(
    FENCE_LEN_CAP,
    Math.max(3, longestBacktickRun(capped) + 1, longestBacktickRun(escaped) + 1)
  );
  const fence = "`".repeat(fenceLen);
  const tail: string[] = [];
  if (truncated) {
    tail.push(`…[truncated ${Buffer.byteLength(json) - Buffer.byteLength(capped)} bytes]`);
  }
  return { text: `${fence}\n${escaped}\n${fence}`, tail };
}

function renderPartMarkdown(part: SessionPart, filter: PartFilter): RenderedPart | null {
  const include = filter.include;
  if (part.type !== "text" && !include.has(part.type)) return null;
  if (IGNORE_PART_TYPES.has(part.type) && !include.has(part.type)) return null;
  if (isBinaryish(part)) {
    return {
      text: `> [skipped binary-ish part: ${part.type} — use --format csf for full content]`,
      tail: [],
    };
  }
  if (part.type === "text") {
    const raw = stripControlChars(String((part as { text: string }).text ?? ""));
    const { text: capped, truncated } = sliceByBytes(raw, PART_BYTE_CAP);
    const tail: string[] = [];
    if (truncated) {
      tail.push(`…[truncated ${Buffer.byteLength(raw) - Buffer.byteLength(capped)} bytes]`);
    }
    return { text: escapeTextForMarkdown(capped), tail };
  }
  if (part.type === "tool") {
    const tool = String((part as { tool: string }).tool ?? "unknown").replace(/`/g, "'");
    const state = (part as { state?: unknown }).state ?? {};
    const json = JSON.stringify({ type: "tool_state", tool, state }, null, 2);
    const { text: capped, truncated } = sliceByBytes(json, PART_BYTE_CAP);
    const escaped = breakBacktickRuns(capped);
    const fenceLen = Math.min(
      FENCE_LEN_CAP,
      Math.max(3, longestBacktickRun(capped) + 1, longestBacktickRun(escaped) + 1)
    );
    const fence = "`".repeat(fenceLen);
    const tail: string[] = [];
    if (truncated) tail.push("…[truncated tool state]");
    return { text: `**Tool:** \`${tool}\`\n\n${fence}\n${escaped}\n${fence}`, tail };
  }
  if (part.type === "tool_result") {
    const tool = codeSpanName(String((part as unknown as { tool?: string }).tool ?? "unknown"));
    return { text: `**Tool result:** \`${tool}\``, tail: [] };
  }
  if (part.type === "reasoning") {
    const raw = stripControlChars(String((part as { text: string }).text ?? ""));
    const { text: capped, truncated } = sliceByBytes(raw, PART_BYTE_CAP);
    const tail: string[] = [];
    if (truncated) tail.push("…[truncated reasoning]");
    return { text: `*${escapeTextForMarkdown(capped)}*`, tail };
  }
  return renderUnknownPartFenced(part);
}

function renderPartText(part: SessionPart, filter: PartFilter): RenderedPart | null {
  const include = filter.include;
  if (part.type !== "text" && !include.has(part.type)) return null;
  if (IGNORE_PART_TYPES.has(part.type) && !include.has(part.type)) return null;
  if (isBinaryish(part)) {
    return {
      text: `[skipped binary-ish part: ${part.type} — use --format csf for full content]`,
      tail: [],
    };
  }
  if (part.type === "text") {
    const raw = stripControlChars(String((part as { text: string }).text ?? ""));
    const { text: capped, truncated } = sliceByBytes(raw, PART_BYTE_CAP);
    const tail: string[] = [];
    if (truncated) tail.push(`…[truncated ${Buffer.byteLength(raw) - Buffer.byteLength(capped)} bytes]`);
    return { text: capped, tail };
  }
  if (part.type === "tool") {
    return { text: `[TOOL] ${(part as unknown as { tool: string }).tool ?? "unknown"}`, tail: [] };
  }
  if (part.type === "tool_result") {
    return { text: `[TOOL RESULT] ${(part as unknown as { tool: string }).tool ?? "unknown"}`, tail: [] };
  }
  if (part.type === "reasoning") {
    const raw = stripControlChars(String((part as { text: string }).text ?? ""));
    const { text: capped, truncated } = sliceByBytes(raw, PART_BYTE_CAP);
    const tail: string[] = [];
    if (truncated) tail.push("…[truncated reasoning]");
    return { text: `[REASONING] ${capped}${truncated ? " …[truncated reasoning]" : ""}`, tail };
  }
  const json = JSON.stringify(part, null, 2);
  const { text: capped, truncated } = sliceByBytes(json, PART_BYTE_CAP);
  const tail: string[] = [];
  if (truncated) tail.push("…[truncated]");
  return { text: capped, tail };
}

export function renderTurnBody(
  messages: SessionMessage[],
  filter: PartFilter,
  format: "markdown" | "text" | "csf"
): string {
  if (format === "csf") {
    // Lossless: no caps, no binary skip — filtered parts only.
    const filtered = messages.map((m) => ({
      ...m,
      parts: m.parts.filter(
        (p) => p.type === "text" || filter.include.has(p.type)
      ),
    }));
    return JSON.stringify(filtered, null, 2);
  }

  const blocks: string[] = [];
  for (const msg of messages) {
    const header =
      format === "markdown"
        ? `### ${capitalize(msg.role)}${msg.modelID ? ` *( model: ${mdSafeModel(msg.modelID)} )*` : ""}`
        : `[${msg.role}] ${msg.created_at}`;
    blocks.push(header);
    for (const part of msg.parts) {
      const rendered =
        format === "markdown"
          ? renderPartMarkdown(part, filter)
          : renderPartText(part, filter);
      if (!rendered) continue;
      blocks.push(rendered.text);
      blocks.push(...rendered.tail);
    }
    blocks.push("");
  }
  return blocks.join("\n");
}

export function toCsf(detail: SessionDetail, opts?: { slice?: SliceMeta }): CsfExport {
  const exportedAt = opts?.slice ? detail.updated_at : new Date().toISOString();
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
      ...(opts?.slice ? { slice: opts.slice } : {}),
    },
    messages: detail.messages?.map(toCsfMessage) ?? [],
    clone: detail.clone,
    exported_at: exportedAt,
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

    lines.push(`[${detail.agent}:${detail.alias}] [${meta.join(" | ")}] ${msg.created_at}`);
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
