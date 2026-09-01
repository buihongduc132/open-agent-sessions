import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createLabel } from "./label";
import { createBrokenAdapter } from "./broken";
import { extractContentLine, extractContentPartsClaude, extractContentTextClaude } from "./content-utils";
import { OtherAgentEntry } from "../config/types";
import {
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
import type { SimilarSessionResult } from "../similarity/search";
import {
  collectJsonlFiles,
  contentContains,
  maxIso,
  minIso,
  resolvePath,
  safeStat,
  sortByIsoDesc,
  splitJsonlLines,
} from "./fs-utils";

// Adapter version read from package.json (replaces hardcoded "1.0.0").
const PKG_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as {
    version: string;
  }
).version;

type ClaudeAdapterOptions = {
  defaultPath?: string;
  configDir?: string;
  homeDir?: string;
};

type ClaudeRecord = {
  id?: unknown;
  type?: string;
  timestamp?: unknown;
  content?: unknown;
  parent_session_id?: unknown;
  model?: unknown;
  agent?: unknown;
};

/**
 * Claude adapter factory. Construction errors deferred to query time (OT4).
 */
export function createClaudeAdapter(
  entry: OtherAgentEntry,
  options: ClaudeAdapterOptions = {}
): Adapter {
  try {
    return buildClaudeAdapter(entry, options);
  } catch (error) {
    return createBrokenAdapter(createLabel(entry), error);
  }
}

function buildClaudeAdapter(
  entry: OtherAgentEntry,
  options: ClaudeAdapterOptions = {}
): Adapter {
  if (entry.agent !== "claude") {
    throw new Error(`Claude adapter requires agent "claude", got "${entry.agent}"`);
  }

  return {
    version: PKG_VERSION,
    listSessions: () => {
      const label = createLabel(entry);
      try {
        const rootPath = resolveClaudePath(entry, options);
        const files = collectJsonlFiles(rootPath);
        return files.map((filePath) => parseClaudeSession(filePath, entry));
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    // R-22: searchSessions — full Claude adapter
    searchSessions: (query: SearchQuery): SessionSummary[] => {
      const label = createLabel(entry);
      try {
        const rootPath = resolveClaudePath(entry, options);
        const files = collectJsonlFiles(rootPath);
        const needle = query.text.toLowerCase();
        const results: SessionSummary[] = [];

        for (const filePath of files) {
          try {
            const session = parseClaudeSession(filePath, entry);
            // Match title (session ID) or file content
            const titleMatch = session.title.toLowerCase().includes(needle);
            const contentMatch = contentContains(filePath, needle);
            if (titleMatch || contentMatch) {
              results.push(session);
            }
          } catch {
            // Skip files that fail to parse
          }
        }

        return sortByIsoDesc(results, "updated_at");
        return results;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    // R-22: getSessionDetail — full Claude adapter
    getSessionDetail: async (
      sessionId: string,
      opts: SessionReadOptions
    ): Promise<SessionDetail | null> => {
      const label = createLabel(entry);
      const rootPath = resolveClaudePath(entry, options);
      const files = collectJsonlFiles(rootPath);

      for (const filePath of files) {
        const sessionIdFromFile = basename(filePath, ".jsonl");
        if (sessionIdFromFile === sessionId) {
          let messages = parseClaudeMessages(filePath, label);
          // parseClaudeSession already computed the summary
          const summary = parseClaudeSession(filePath, entry);

          // Apply mode (takes precedence over selection)
          if (opts.mode === "last_message") {
            messages = messages.slice(-1);
          } else if (opts.mode === "all_no_tools") {
            messages = messages.map((m) => ({
              ...m,
              parts: m.parts.filter((p) => p.type !== "tool"),
            }));
          } else {
            // mode is "all_with_tools" or undefined → use existing selection/role/userOnly logic

            // Apply selection mode (mirrors zcode/hermes/pi verbatim)
            const selection = opts.selection;
            if (selection) {
              switch (selection.mode) {
                case "first":
                  messages = messages.slice(0, selection.count);
                  break;
                case "last":
                  messages =
                    selection.count === 0
                      ? messages
                      : messages.slice(-(selection.count ?? 10));
                  break;
                case "range": {
                  const start = (selection.start ?? 1) - 1;
                  const end = selection.end ?? messages.length;
                  messages = messages.slice(start, end);
                  break;
                }
                case "all":
                default:
                  break;
              }
            }

            // Apply role-based filtering (mirrors zcode/hermes/pi verbatim)
            const effectiveUserOnly = opts.userOnly || opts.selection?.userOnly;
            if (effectiveUserOnly) {
              if (opts.role && opts.role !== "user") {
                messages = [];
              } else {
                messages = messages.filter((m) => m.role === "user");
              }
            } else if (opts.role) {
              messages = messages.filter((m) => m.role === opts.role);
            }
          }

          return {
            ...summary,
            messages,
          };
        }
      }

      // Not-found is a normal result (Adapter contract): callers null-check.
      return null;
    },
    listSessionsByTimeRange: (opts: TimeRangeOptions): SessionSummary[] => {
      const label = createLabel(entry);
      try {
        // Default to the full epoch window. since/until are ms-epoch; we
        // compare against updated_at (ISO-8601 → ms). updated_at is derived
        // from the max record.timestamp across all records in the transcript.
        const sinceMs = opts.since != null ? opts.since : 0;
        const untilMs = opts.until != null ? opts.until : 8640000000000000;
        const skipId = opts.skipSessionId;

        const rootPath = resolveClaudePath(entry, options);
        const files = collectJsonlFiles(rootPath);

        let results: SessionSummary[] = [];
        for (const filePath of files) {
          try {
            const session = parseClaudeSession(filePath, entry);
            if (skipId === session.id) continue;

            const updatedMs = Date.parse(session.updated_at);
            if (Number.isNaN(updatedMs)) continue;
            if (updatedMs < sinceMs || updatedMs > untilMs) continue;
            results.push(session);
          } catch {
            // Skip files that fail to parse
          }
        }

        results = sortByIsoDesc(results, "updated_at");
        // limit: 0 or undefined means "all"
        if (opts.limit && opts.limit > 0) {
          results = results.slice(0, opts.limit);
        }
        return results;
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    toolSearchSessions: (query: ToolSearchQuery): SessionSummary[] => {
      const label = createLabel(entry);
      try {
        const needle = query.tool.toLowerCase();
        const rootPath = resolveClaudePath(entry, options);
        const files = collectJsonlFiles(rootPath);
        const results: SessionSummary[] = [];

        for (const filePath of files) {
          try {
            if (sessionUsesTool(filePath, needle)) {
              results.push(parseClaudeSession(filePath, entry));
            }
          } catch {
            // Skip files that fail to parse
          }
        }

        return sortByIsoDesc(results, "updated_at");
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    forkSession: async (
      sourceSessionId: string,
      destAgent: string,
      destAlias: string
    ): Promise<ForkResult> => {
      // STUB: native write to claude session storage is deferred (R-18).
      // Mirror zcode/pi forkSession — return a well-formed ForkResult.
      return {
        newSessionId: `claude-fork-${Date.now()}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString(),
      };
    },
    destroy: () => {
      // No-op for JSONL-based adapter (no handles to release).
    },
    // REQ-SIM-03: Similarity search not yet supported for Claude adapter
    findSimilarSessions: async (): Promise<SimilarSessionResult[]> => [
      {
        sessionId: "",
        title: "",
        score: 0,
        rank: 0,
        matchType: "none",
        matchedChunks: 0,
        note: "Not yet supported",
      },
    ],
  };
}

function resolveClaudePath(entry: OtherAgentEntry, options: ClaudeAdapterOptions): string {
  const rawPath = entry.path;
  if (rawPath !== undefined && typeof rawPath !== "string") {
    throw new Error(`Claude path must be a non-empty string`);
  }
  if (typeof rawPath === "string" && rawPath.trim().length === 0) {
    throw new Error(`Claude path must be a non-empty string`);
  }

  const configured = typeof rawPath === "string" ? rawPath : undefined;
  const home = options.homeDir ?? homedir();
  const defaultPath =
    options.defaultPath ??
    (safeStat(join(home, ".claude", "transcripts"))
      ? join(home, ".claude", "transcripts")
      : join(home, ".claude", "sessions"));
  const resolved = resolvePath(configured ?? defaultPath, options.configDir);

  const stat = safeStat(resolved);
  if (!stat) {
    throw new Error(`Claude path not found: ${resolved}`);
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`Claude path is not a file or directory: ${resolved}`);
  }
  return resolved;
}

function parseClaudeSession(filePath: string, entry: OtherAgentEntry): SessionSummary {
  const sessionId = basename(filePath, ".jsonl");
  if (!sessionId || sessionId.trim().length === 0 || sessionId.startsWith(".")) {
    throw new Error(`Claude session id missing for ${filePath}`);
  }
  const lines = splitJsonlLines(readFileSync(filePath, "utf8"));
  let title: string | undefined;
  let messageCount = 0;
  let minTimestamp: string | undefined;
  let maxTimestamp: string | undefined;
  let parentSessionId: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.length === 0) {
      continue;
    }

    const record = parseJsonLine(raw, filePath, i + 1);
    const recordType = record.type;

    // Collect parent_session_id from any record type (metadata, system, etc.)
    if (!parentSessionId) {
      parentSessionId = readOptionalString(record.parent_session_id);
    }
    if (record.timestamp !== undefined && record.timestamp !== null) {
      const recordId = record.id;
      const context =
        typeof recordId === "string" && recordId.length > 0
          ? `Claude timestamp invalid for ${sessionId} record ${recordId} at ${filePath}:${i + 1}`
          : `Claude timestamp invalid for ${sessionId} (missing record id) at ${filePath}:${i + 1}`;
      const timestampIso = normalizeTimestamp(record.timestamp, context);
      minTimestamp = minTimestamp ? minIso(minTimestamp, timestampIso) : timestampIso;
      maxTimestamp = maxTimestamp ? maxIso(maxTimestamp, timestampIso) : timestampIso;
    }

    if (recordType === "user" || recordType === "assistant") {
      messageCount += 1;
    }

    if (!title && recordType === "user") {
      const extracted = extractContentLine(record.content);
      if (extracted) {
        title = extracted;
      }
    }
  }

  if (!minTimestamp || !maxTimestamp) {
    throw new Error(`Claude timestamps missing for ${sessionId} in ${filePath}`);
  }

  return {
    id: sessionId,
    agent: "claude",
    alias: entry.alias,
    title: title && title.length > 0 ? title : sessionId,
    created_at: minTimestamp,
    updated_at: maxTimestamp,
    message_count: messageCount,
    storage: "other",
    parentSessionId,
  };
}

function parseJsonLine(line: string, filePath: string, lineNumber: number): ClaudeRecord {
  try {
    return JSON.parse(line) as ClaudeRecord;
  } catch (error) {
    throw new Error(`Claude JSONL parse error in ${filePath} at line ${lineNumber}`);
  }
}

/**
 * Safely coerce an unknown value to a non-empty string, or return undefined.
 * Handles null, undefined, non-string types, and empty/whitespace-only strings.
 */
function readOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/**
 * Parse all messages from a Claude JSONL transcript file.
 */
function parseClaudeMessages(filePath: string, label: string): SessionMessage[] {
  const lines = splitJsonlLines(readFileSync(filePath, "utf8"));
  const messages: SessionMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw.length === 0) continue;

    let record: ClaudeRecord;
    try {
      record = JSON.parse(raw) as ClaudeRecord;
    } catch {
      throw new Error(`Claude JSONL parse error in ${filePath} at line ${i + 1}`);
    }

    const recordType = record.type;
    if (recordType !== "user" && recordType !== "assistant") continue;

    const recordId = record.id;
    const context =
      typeof recordId === "string"
        ? `${label} timestamp invalid in ${filePath}:${i + 1}`
        : `${label} timestamp invalid (missing record id) in ${filePath}:${i + 1}`;
    const created_at = normalizeTimestamp(record.timestamp, context);

    const parts = mapClaudeContent(record.content);

    const message: SessionMessage = {
      id: typeof recordId === "string" ? recordId : `${filePath}:${i + 1}`,
      role: recordType as "user" | "assistant",
      created_at,
      parts,
    };

    // modelID: claude records carry model at the top level (mirrors zcode
    // parsed.model.modelID). agent: record-level subagent identity (mirrors
    // zcode parsed.agent). Only set when non-empty string.
    const modelID = readOptionalString(record.model);
    const agentField = readOptionalString(record.agent);
    if (modelID) message.modelID = modelID;
    if (agentField) message.agent = agentField;

    messages.push(message);
  }

  return messages;
}

/**
 * Map Claude message content onto SessionPart[]. Mirrors zcode mapParts /
 * pi mapContentPart: text/tool/reasoning are first-class, anything else
 * passes through verbatim. Non-array string content becomes a single text part.
 *
 * Claude content blocks:
 *   { type:"text", text }
 *   { type:"tool_use", id, name, input } → tool part
 *   { type:"thinking", thinking } → reasoning part
 *   { type:"tool_result", ... } → pass through verbatim
 */
function mapClaudeContent(content: unknown): SessionPart[] {
  const parts: SessionPart[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      parts.push(mapClaudeContentBlock(block));
    }
  } else if (typeof content === "string") {
    parts.push({ type: "text", text: content });
  } else if (content !== null && content !== undefined) {
    // Non-array object content — coerce to text via existing util.
    const textParts = extractContentPartsClaude(content);
    for (const text of textParts) {
      parts.push({ type: "text", text });
    }
  }
  return parts;
}

/**
 * Map a single Claude content block onto a SessionPart.
 */
function mapClaudeContentBlock(block: unknown): SessionPart {
  if (block === null || typeof block !== "object") {
    return { type: "text", text: "" };
  }
  const b = block as { type?: string; [key: string]: unknown };
  const t = typeof b.type === "string" ? b.type : "";

  if (t === "text") {
    const text = typeof b.text === "string" ? b.text : "";
    return { type: "text", text };
  }
  if (t === "tool_use") {
    // Claude tool_use: { type, id, name, input }. Map to unified tool part.
    const name = typeof b.name === "string" ? b.name : "";
    const input = b.input;
    return {
      type: "tool",
      tool: name,
      state: { input: input && typeof input === "object" ? input : {} },
    };
  }
  if (t === "thinking") {
    // Claude thinking block: { type, thinking }. Map to reasoning part.
    const text = typeof b.thinking === "string" ? b.thinking : "";
    return { type: "reasoning", text };
  }
  // Unknown block type (tool_result, etc.) — pass through verbatim.
  return b as SessionPart;
}

/**
 * Determine whether any record in the transcript file contains a tool_use
 * content block whose `name` case-insensitively contains `needle`.
 * Mirror of pi sessionUsesTool / zcode toolSearchSessions.
 */
function sessionUsesTool(filePath: string, needle: string): boolean {
  const lines = splitJsonlLines(readFileSync(filePath, "utf8"));
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.length === 0) continue;

    let record: ClaudeRecord;
    try {
      record = JSON.parse(raw) as ClaudeRecord;
    } catch {
      continue;
    }

    const content = record.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const b = block as { type?: string; name?: unknown };
      if (b.type === "tool_use") {
        const toolName = typeof b.name === "string" ? b.name : "";
        if (toolName.toLowerCase().includes(needle)) return true;
      }
    }
  }
  return false;
}
