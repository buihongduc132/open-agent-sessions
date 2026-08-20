/**
 * Grok Adapter — GREEN PHASE
 *
 * Reads Grok CLI sessions from ~/.grok/sessions (JSONL + summary.json).
 * Default root is `$GROK_HOME/sessions` (or `~/.grok/sessions`). Tests inject
 * sessionsDir / homeDir instead of touching the live home.
 *
 * Live layout:
 *
 *   <sessionsRoot>/<url-encoded-cwd>/<session-uuid>/
 *     summary.json         metadata
 *     chat_history.jsonl   raw model messages (adapter source for SessionMessage[])
 *     updates.jsonl        ACP stream (authoritative for resume; optional here)
 *
 *   Encoded cwd >255 bytes uses slug+hash + a `.cwd` file.
 *   Session IDs are UUIDv7. Subagent children are sibling UUID dirs (not nested).
 *   Cwd-level files (prompt_history.jsonl, locks) are NOT sessions.
 *   Directories without summary.json are NOT sessions.
 *
 * Title = generated_title if non-empty, else session_summary, else id.
 *
 * @file src/adapters/grok.ts
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createBrokenAdapter } from "./broken";
import { createLabel } from "./label";
import {
  containsIgnoreCase,
  contentContains,
  readTextFile,
  resolvePath,
  safeStat,
  sortByIsoDesc,
  splitJsonlLines,
} from "./fs-utils";
import type { OtherAgentEntry } from "../config/types";
import type {
  Adapter,
  ForkResult,
  SearchQuery,
  SessionDetail,
  SessionMessage,
  SessionPart,
  SessionReadOptions,
  SessionSummary,
  TimeRangeOptions,
  ToolSearchQuery,
} from "../core/types";
import { normalizeTimestamp } from "../core/normalize";
import { errorMessage } from "../core/utils";

/** Options for the grok adapter. sessionsDir overrides the default ~/.grok/sessions root. */
export type GrokAdapterOptions = {
  /** Sessions root (encoded-cwd groups). Defaults to ~/.grok/sessions */
  sessionsDir?: string;
  /** Home directory used when resolving the default ~/.grok/sessions path */
  homeDir?: string;
};

type GrokAgentEntry = Extract<OtherAgentEntry, { agent: "grok" }>;

type GrokSummaryFile = {
  info?: { id?: unknown; cwd?: unknown };
  session_summary?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  num_messages?: unknown;
  num_chat_messages?: unknown;
  current_model_id?: unknown;
  generated_title?: unknown;
  parent_session_id?: unknown;
};

type GrokToolCall = {
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
};

type GrokRecord = {
  type?: unknown;
  id?: unknown;
  content?: unknown;
  summary?: unknown;
  tool_calls?: unknown;
  model_id?: unknown;
  tool_call_id?: unknown;
};

type LocatedSession = {
  dir: string;
  summary: SessionSummary;
};

/**
 * grok adapter factory.
 *
 * Construction errors (missing path, path is a file, wrong agent) are deferred
 * to query time via createBrokenAdapter — one broken adapter must not kill the
 * entire registry (OT4).
 */
export function createGrokAdapter(
  entry: GrokAgentEntry,
  options: GrokAdapterOptions = {}
): Adapter {
  try {
    return buildGrokAdapter(entry, options);
  } catch (error) {
    return createBrokenAdapter(createLabel(entry), error);
  }
}

function buildGrokAdapter(
  entry: GrokAgentEntry,
  options: GrokAdapterOptions = {}
): Adapter {
  if (entry.agent !== "grok") {
    throw new Error(`grok adapter requires agent "grok", got "${entry.agent}"`);
  }

  const label = createLabel(entry);
  const rootPath = resolveGrokPath(entry, options);

  const loadLocated = (): LocatedSession[] => {
    const dirs = collectSessionDirs(rootPath);
    const located: LocatedSession[] = [];
    for (const dir of dirs) {
      try {
        located.push({ dir, summary: parseGrokSession(dir, entry) });
      } catch {
        // Skip dirs whose summary.json cannot be mapped.
      }
    }
    return located;
  };

  const listSorted = (): SessionSummary[] =>
    sortByIsoDesc(
      loadLocated().map((item) => item.summary),
      "updated_at"
    );

  return {
    version: "1.0.0",

    listSessions: (): SessionSummary[] => {
      try {
        return listSorted();
      } catch (error) {
        throwLabeled(label, error);
      }
    },

    listSessionsByTimeRange: (opts: TimeRangeOptions): SessionSummary[] => {
      try {
        const sinceMs = opts.since != null ? opts.since : 0;
        const untilMs = opts.until != null ? opts.until : 8640000000000000;
        const skipId = opts.skipSessionId;

        let results: SessionSummary[] = [];
        for (const item of loadLocated()) {
          const session = item.summary;
          if (skipId === session.id) continue;
          const updatedMs = Date.parse(session.updated_at);
          if (Number.isNaN(updatedMs)) continue;
          if (updatedMs < sinceMs || updatedMs > untilMs) continue;
          results.push(session);
        }

        results = sortByIsoDesc(results, "updated_at");
        if (opts.limit && opts.limit > 0) {
          results = results.slice(0, opts.limit);
        }
        return results;
      } catch (error) {
        throwLabeled(label, error);
      }
    },

    searchSessions: (query: SearchQuery): SessionSummary[] => {
      try {
        const results: SessionSummary[] = [];
        for (const item of loadLocated()) {
          const titleMatch = containsIgnoreCase(item.summary.title, query.text);
          const chatPath = join(item.dir, "chat_history.jsonl");
          const contentMatch = contentContains(chatPath, query.text.toLowerCase());
          if (titleMatch || contentMatch) {
            results.push(item.summary);
          }
        }
        return sortByIsoDesc(results, "updated_at");
      } catch (error) {
        throwLabeled(label, error);
      }
    },

    getSessionDetail: async (
      sessionId: string,
      opts: SessionReadOptions
    ): Promise<SessionDetail> => {
      const located = findSession(rootPath, entry, sessionId);
      if (!located) {
        throw new Error(`${label} session not found: ${sessionId}`);
      }

      let messages = parseChatHistory(
        located.dir,
        located.summary.id,
        located.summary.updated_at
      );
      messages = applySessionReadOptions(messages, opts);
      return { ...located.summary, messages };
    },

    toolSearchSessions: (query: ToolSearchQuery): SessionSummary[] => {
      try {
        const results: SessionSummary[] = [];
        for (const item of loadLocated()) {
          if (sessionUsesTool(item.dir, query.tool)) {
            results.push(item.summary);
          }
        }
        return sortByIsoDesc(results, "updated_at");
      } catch (error) {
        throwLabeled(label, error);
      }
    },

    forkSession: async (
      sourceSessionId: string,
      destAgent: string,
      destAlias: string
    ): Promise<ForkResult> => {
      return {
        newSessionId: `grok-fork-${Date.now()}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString(),
      };
    },

    destroy: () => {
      // No-op for JSONL-based adapter (no handles to release).
    },
  };
}

function resolveGrokPath(entry: GrokAgentEntry, options: GrokAdapterOptions): string {
  const entryPath =
    typeof entry.path === "string" && entry.path.trim().length > 0
      ? entry.path
      : undefined;
  const grokHome =
    options.homeDir ??
    (typeof process.env.GROK_HOME === "string" && process.env.GROK_HOME.trim().length > 0
      ? process.env.GROK_HOME
      : join(homedir(), ".grok"));
  const raw = entryPath ?? options.sessionsDir ?? join(grokHome, "sessions");
  const resolved = resolvePath(raw);
  const stat = safeStat(resolved);
  if (!stat) {
    throw new Error(`sessions path not found: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`sessions path is not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Walk `<root>/<encoded-cwd>/<uuid>/summary.json`.
 * Skip cwd-level files and directories without summary.json.
 */
function collectSessionDirs(rootPath: string): string[] {
  const dirs: string[] = [];
  const rootStat = safeStat(rootPath);
  if (!rootStat || !rootStat.isDirectory()) return dirs;

  for (const cwdEntry of readdirSync(rootPath, { withFileTypes: true })) {
    if (!cwdEntry.isDirectory()) continue;
    const cwdPath = join(rootPath, cwdEntry.name);
    let sessionEntries;
    try {
      sessionEntries = readdirSync(cwdPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = join(cwdPath, sessionEntry.name);
      const summaryStat = safeStat(join(sessionDir, "summary.json"));
      if (summaryStat && summaryStat.isFile()) {
        dirs.push(sessionDir);
      }
    }
  }
  return dirs;
}

function findSession(
  rootPath: string,
  entry: GrokAgentEntry,
  sessionId: string
): LocatedSession | undefined {
  if (basename(sessionId) !== sessionId || sessionId.includes("..")) {
    return undefined;
  }
  for (const dir of collectSessionDirs(rootPath)) {
    if (basename(dir) !== sessionId) continue;
    try {
      return { dir, summary: parseGrokSession(dir, entry) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseGrokSession(dir: string, entry: GrokAgentEntry): SessionSummary {
  const sessionId = basename(dir);
  const raw = readTextFile(join(dir, "summary.json"));
  if (raw == null) {
    throw new Error(`summary.json not found for ${sessionId}`);
  }

  let parsed: GrokSummaryFile;
  try {
    parsed = JSON.parse(raw) as GrokSummaryFile;
  } catch {
    throw new Error(`summary.json is not valid JSON for ${sessionId}`);
  }

  const createdAt = normalizeTimestamp(
    parsed.created_at,
    `grok created_at invalid for ${sessionId}`
  );
  const updatedAt = normalizeTimestamp(
    parsed.updated_at,
    `grok updated_at invalid for ${sessionId}`
  );

  const messages = parseChatHistory(dir, sessionId, updatedAt);
  const parentSessionId = readOptionalString(parsed.parent_session_id);

  return {
    id: sessionId,
    agent: "grok",
    alias: entry.alias,
    title: sessionTitle(parsed, sessionId),
    created_at: createdAt,
    updated_at: updatedAt,
    message_count: messages.length,
    storage: "jsonl",
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

function sessionTitle(summary: GrokSummaryFile, sessionId: string): string {
  const generated = readOptionalString(summary.generated_title);
  if (generated) return generated;
  const fallback = readOptionalString(summary.session_summary);
  if (fallback) return fallback;
  return sessionId;
}

function parseChatHistory(
  dir: string,
  sessionId: string,
  fallbackTimestamp: string
): SessionMessage[] {
  const raw = readTextFile(join(dir, "chat_history.jsonl"));
  if (raw == null || raw.length === 0) return [];

  const messages: SessionMessage[] = [];
  let pendingReasoning: SessionPart[] = [];
  let index = 0;

  const nextId = (record: GrokRecord): string => {
    const recordId = readOptionalString(record.id);
    if (recordId) return recordId;
    const id = `${sessionId}:${index}`;
    index += 1;
    return id;
  };

  const flushReasoningAsAssistant = (): void => {
    if (pendingReasoning.length === 0) return;
    messages.push({
      id: `${sessionId}:${index++}`,
      role: "assistant",
      created_at: fallbackTimestamp,
      parts: pendingReasoning,
    });
    pendingReasoning = [];
  };

  for (const line of splitJsonlLines(raw)) {
    let record: GrokRecord;
    try {
      record = JSON.parse(line) as GrokRecord;
    } catch {
      continue;
    }

    const type = record.type;
    if (type === "system") {
      flushReasoningAsAssistant();
      const text = typeof record.content === "string" ? record.content : "";
      messages.push({
        id: nextId(record),
        role: "system",
        created_at: fallbackTimestamp,
        parts: [{ type: "text", text }],
      });
      continue;
    }

    if (type === "user") {
      flushReasoningAsAssistant();
      messages.push({
        id: nextId(record),
        role: "user",
        created_at: fallbackTimestamp,
        parts: userParts(record.content),
      });
      continue;
    }

    if (type === "reasoning") {
      pendingReasoning.push(...reasoningParts(record.summary));
      continue;
    }

    if (type === "assistant") {
      const parts: SessionPart[] = [...pendingReasoning];
      pendingReasoning = [];
      parts.push(...assistantContentParts(record.content));
      parts.push(...toolParts(record.tool_calls));

      const message: SessionMessage = {
        id: nextId(record),
        role: "assistant",
        created_at: fallbackTimestamp,
        parts,
      };
      const modelID = readOptionalString(record.model_id);
      if (modelID) message.modelID = modelID;
      messages.push(message);
      continue;
    }

    if (type === "tool_result") {
      const toolCallId = readOptionalString(record.tool_call_id);
      if (toolCallId) {
        attachToolResult(messages, toolCallId, toolResultContent(record.content));
      }
    }
  }

  flushReasoningAsAssistant();
  return messages;
}

function userParts(content: unknown): SessionPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];

  const parts: SessionPart[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as { type?: unknown; text?: unknown };
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    }
  }
  return parts;
}

function reasoningParts(summary: unknown): SessionPart[] {
  if (!Array.isArray(summary)) return [];
  const parts: SessionPart[] = [];
  for (const item of summary) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      parts.push({ type: "reasoning", text });
    }
  }
  return parts;
}

function assistantContentParts(content: unknown): SessionPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  return userParts(content);
}

function toolParts(toolCalls: unknown): SessionPart[] {
  if (!Array.isArray(toolCalls)) return [];
  const parts: SessionPart[] = [];
  for (const raw of toolCalls) {
    if (!raw || typeof raw !== "object") continue;
    const call = raw as GrokToolCall;
    const name = typeof call.name === "string" ? call.name : "";
    const state: Record<string, unknown> = {
      arguments: parseToolArguments(call.arguments),
    };
    const id = readOptionalString(call.id);
    if (id) state.id = id;
    parts.push({ type: "tool", tool: name, state });
  }
  return parts;
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function attachToolResult(
  messages: SessionMessage[],
  toolCallId: string,
  output: string
): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const state = (part as { type: "tool"; tool: string; state: Record<string, unknown> }).state;
      if (state && state.id === toolCallId) {
        state.output = output;
        return;
      }
    }
  }
}

function sessionUsesTool(dir: string, tool: string): boolean {
  const raw = readTextFile(join(dir, "chat_history.jsonl"));
  if (raw == null) return false;

  for (const line of splitJsonlLines(raw)) {
    let record: GrokRecord;
    try {
      record = JSON.parse(line) as GrokRecord;
    } catch {
      continue;
    }
    if (record.type !== "assistant" || !Array.isArray(record.tool_calls)) continue;
    for (const rawCall of record.tool_calls) {
      if (!rawCall || typeof rawCall !== "object") continue;
      const name = (rawCall as GrokToolCall).name;
      if (typeof name === "string" && containsIgnoreCase(name, tool)) {
        return true;
      }
    }
  }
  return false;
}

function applySessionReadOptions(
  messages: SessionMessage[],
  opts: SessionReadOptions
): SessionMessage[] {
  if (opts.mode === "last_message") {
    return messages.slice(-1);
  }
  if (opts.mode === "all_no_tools") {
    return messages.map((m) => ({
      ...m,
      parts: m.parts.filter((p) => p.type !== "tool"),
    }));
  }

  let next = messages;
  const selection = opts.selection;
  if (selection) {
    switch (selection.mode) {
      case "first":
        next = next.slice(0, selection.count);
        break;
      case "last":
        next =
          selection.count === 0
            ? next
            : next.slice(-(selection.count ?? 10));
        break;
      case "range": {
        const start = (selection.start ?? 1) - 1;
        const end = selection.end ?? next.length;
        next = next.slice(start, end);
        break;
      }
      case "all":
      default:
        break;
    }
  }

  const effectiveUserOnly = opts.userOnly || opts.selection?.userOnly;
  if (effectiveUserOnly) {
    if (opts.role && opts.role !== "user") {
      return [];
    }
    return next.filter((m) => m.role === "user");
  }
  if (opts.role) {
    return next.filter((m) => m.role === opts.role);
  }
  return next;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function throwLabeled(label: string, error: unknown): never {
  const message = errorMessage(error);
  if (message.includes(label)) {
    throw new Error(message);
  }
  throw new Error(`${label} ${message}`);
}
