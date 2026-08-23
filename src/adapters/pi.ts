import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createLabel } from "./label";
import { createBrokenAdapter } from "./broken";
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

export type PiAdapterOptions = {
  defaultPath?: string;
  configDir?: string;
  homeDir?: string;
};

// Pi JSONL event types
type PiSessionEntry = {
  type: "session";
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
};

type PiMessageEntry = {
  type: "message";
  id?: string;
  parentId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: PiContentPart[] | string;
    provider?: string;
    model?: string;
    usage?: { input: number; output: number; totalTokens: number };
    errorMessage?: string;
  };
};

/**
 * Pi content part shapes (mirrors SessionPart union). text/tool/reasoning
 * are first-class; anything else passes through verbatim.
 */
type PiContentPart =
  | { type: "text"; text?: string }
  | { type: "tool"; tool?: string; state?: Record<string, unknown> }
  | { type: "reasoning"; text?: string }
  | { type: string; [key: string]: unknown };

type PiRecord = {
  type: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: PiContentPart[] | string;
    provider?: string;
    model?: string;
    agent?: string;
    usage?: { input: number; output: number; totalTokens: number };
    errorMessage?: string;
  };
  [key: string]: unknown;
};

/**
 * Pi adapter factory.
 *
 * Construction errors deferred to query time (OT4) — see ./broken.ts.
 */
export function createPiAdapter(
  entry: OtherAgentEntry,
  options: PiAdapterOptions = {}
): Adapter {
  try {
    return buildPiAdapter(entry, options);
  } catch (error) {
    return createBrokenAdapter(createLabel(entry), error);
  }
}

function buildPiAdapter(
  entry: OtherAgentEntry,
  options: PiAdapterOptions = {}
): Adapter {
  if (entry.agent !== "pi") {
    throw new Error(`Pi adapter requires agent "pi", got "${entry.agent}"`);
  }

  return {
    version: "1.0.0",
    listSessions: () => {
      const label = createLabel(entry);
      try {
        const rootPath = resolvePiPath(entry, options);
        const sessionDirs = collectSessionDirs(rootPath);
        return sessionDirs.map((dirPath) => parsePiSession(dirPath, entry));
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes(label)) {
          throw new Error(message);
        }
        throw new Error(`${label} ${message}`);
      }
    },
    searchSessions: (query: SearchQuery): SessionSummary[] => {
      const label = createLabel(entry);
      try {
        const rootPath = resolvePiPath(entry, options);
        const sessionDirs = collectSessionDirs(rootPath);
        const needle = query.text.toLowerCase();
        const results: SessionSummary[] = [];

        for (const dirPath of sessionDirs) {
          try {
            const session = parsePiSession(dirPath, entry);
            const titleMatch = session.title.toLowerCase().includes(needle);
            const contentMatch = contentContains(dirPath, needle);
            if (titleMatch || contentMatch) {
              results.push(session);
            }
          } catch {
            // Skip dirs that fail to parse
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
    getSessionDetail: async (
      sessionId: string,
      opts: SessionReadOptions
    ): Promise<SessionDetail> => {
      const label = createLabel(entry);
      const rootPath = resolvePiPath(entry, options);
      const sessionDirs = collectSessionDirs(rootPath);

      for (const dirPath of sessionDirs) {
        const dirId = basename(dirPath);
        if (dirId === sessionId) {
          let messages = parsePiMessages(dirPath, label);
          const summary = parsePiSession(dirPath, entry);

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

            // Apply selection mode (mirrors zcode/hermes verbatim)
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

            // Apply role-based filtering (mirrors zcode/hermes verbatim)
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

          return { ...summary, messages };
        }
      }

      throw new Error(`${label} session not found: ${sessionId}`);
    },
    listSessionsByTimeRange: (opts: TimeRangeOptions): SessionSummary[] => {
      const label = createLabel(entry);
      try {
        // Default to the full epoch window. since/until are ms-epoch; we
        // compare against updated_at (ISO-8601 → ms) of each top-level jsonl.
        // Invariant: --last/--limit bound bytes read, not only the array returned.
        const sinceMs = opts.since != null ? opts.since : 0;
        const untilMs = opts.until != null ? opts.until : 8640000000000000;
        const skipId = opts.skipSessionId;
        const pruneBefore = sinceMs > 0 ? sinceMs - MTIME_SLACK_MS : 0;

        const rootPath = resolvePiPath(entry, options);
        const files = collectTopLevelJsonl(rootPath);

        let results: SessionSummary[] = [];
        for (const filePath of files) {
          const st = safeStat(filePath);
          if (!st || !st.isFile()) continue;
          // mtime is an upper bound on last write. Skip cold files before open.
          if (pruneBefore > 0 && st.mtimeMs < pruneBefore) continue;

          try {
            const session = parsePiJsonlFile(filePath, entry);
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
        // limit: 0 or undefined means "all" of the already-pruned matches
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
        const rootPath = resolvePiPath(entry, options);
        const sessionDirs = collectSessionDirs(rootPath);
        const results: SessionSummary[] = [];

        for (const dirPath of sessionDirs) {
          try {
            if (sessionUsesTool(dirPath, needle)) {
              results.push(parsePiSession(dirPath, entry));
            }
          } catch {
            // Skip dirs that fail to parse
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
      // STUB: native write to pi session storage is deferred (R-18).
      // Mirror zcode forkSession — return a well-formed ForkResult.
      return {
        newSessionId: `pi-fork-${Date.now()}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString(),
      };
    },
    destroy: () => {
      // No-op for JSONL-based adapter (no handles to release).
    },
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

function resolvePiPath(entry: OtherAgentEntry, options: PiAdapterOptions): string {
  const rawPath = entry.path;
  if (rawPath !== undefined && typeof rawPath !== "string") {
    throw new Error(`Pi path must be a non-empty string`);
  }
  if (typeof rawPath === "string" && rawPath.trim().length === 0) {
    throw new Error(`Pi path must be a non-empty string`);
  }

  const configured = typeof rawPath === "string" ? rawPath : undefined;
  const home = options.homeDir ?? homedir();
  const defaultPath = options.defaultPath ?? join(home, ".pi", "sessions");
  const resolved = resolvePath(configured ?? defaultPath, options.configDir);

  const stat = safeStat(resolved);
  if (!stat) {
    throw new Error(`Pi sessions path not found: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Pi sessions path is not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Collect all session directories (slug dirs containing .jsonl files).
 */
function collectSessionDirs(rootPath: string): string[] {
  const dirs: string[] = [];
  const entries = safeStat(rootPath);
  if (!entries || !entries.isDirectory()) return dirs;

  const { readdirSync, statSync } = require("node:fs");
  for (const name of readdirSync(rootPath)) {
    if (name.startsWith(".")) continue;
    const fullPath = join(rootPath, name);
    try {
      if (statSync(fullPath).isDirectory()) {
        // Check if directory contains .jsonl files
        const files = readdirSync(fullPath).filter((f: string) => f.endsWith(".jsonl"));
        if (files.length > 0) {
          dirs.push(fullPath);
        }
      }
    } catch {
      // Skip inaccessible dirs
    }
  }
  return dirs;
}

/** Clock-skew / copy-in slack for mtime prune. False positives are fine; false negatives are not. */
const MTIME_SLACK_MS = 60 * 60 * 1000;

const FILENAME_UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Top-level `*.jsonl` under each slug dir. Nested trees (subagent-artifacts/)
 * are not sessions and must not be merged into the parent.
 */
function collectTopLevelJsonl(rootPath: string): string[] {
  const files: string[] = [];
  const rootStat = safeStat(rootPath);
  if (!rootStat || !rootStat.isDirectory()) return files;

  let slugs: string[] = [];
  try {
    slugs = readdirSync(rootPath);
  } catch {
    return files;
  }

  for (const name of slugs) {
    if (name.startsWith(".")) continue;
    const slugPath = join(rootPath, name);
    const st = safeStat(slugPath);
    if (!st || !st.isDirectory()) continue;
    let children: string[] = [];
    try {
      children = readdirSync(slugPath);
    } catch {
      continue;
    }
    for (const fileName of children) {
      if (fileName.endsWith(".jsonl")) {
        files.push(join(slugPath, fileName));
      }
    }
  }
  return files;
}

function sessionIdFromJsonlPath(filePath: string, recordId?: string): string {
  const fromName = basename(filePath).match(FILENAME_UUID_RE)?.[0];
  if (fromName) return fromName;
  if (recordId) return recordId;
  return basename(dirname(filePath));
}

function parsePiJsonlFile(filePath: string, entry: OtherAgentEntry): SessionSummary {
  const lines = splitJsonlLines(readFileSync(filePath, "utf8"));
  let title: string | undefined;
  let messageCount = 0;
  let minTimestamp: string | undefined;
  let maxTimestamp: string | undefined;
  let parentSessionId: string | undefined;
  let recordSessionId: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.length === 0) continue;

    let record: PiRecord;
    try {
      record = JSON.parse(raw) as PiRecord;
    } catch {
      continue;
    }

    if (!parentSessionId) {
      parentSessionId = readOptionalString(record.parentId);
    }
    if (!recordSessionId && record.type === "session") {
      recordSessionId = readOptionalString(record.id);
    }

    if (record.timestamp) {
      const context = `Pi timestamp invalid for ${filePath}:${i + 1}`;
      const timestampIso = normalizeTimestamp(record.timestamp, context);
      minTimestamp = minTimestamp ? minIso(minTimestamp, timestampIso) : timestampIso;
      maxTimestamp = maxTimestamp ? maxIso(maxTimestamp, timestampIso) : timestampIso;
    }

    if (record.type === "message" && record.message) {
      messageCount += 1;
      if (!title && record.message.role === "user") {
        const content = record.message.content;
        if (Array.isArray(content)) {
          const textPart = content.find(
            (c): c is { type: "text"; text: string } =>
              c.type === "text" &&
              typeof (c as { text?: unknown }).text === "string" &&
              (c as { text: string }).text.length > 0
          );
          if (textPart?.text) {
            title = textPart.text.slice(0, 120);
          }
        } else if (typeof content === "string" && content.trim().length > 0) {
          title = content.slice(0, 120);
        }
      }
    }
  }

  const sessionId = sessionIdFromJsonlPath(filePath, recordSessionId);
  if (!minTimestamp || !maxTimestamp) {
    const st = safeStat(filePath);
    if (!st) {
      throw new Error(`Pi timestamps missing for ${sessionId} and cannot stat file`);
    }
    const fallback = new Date(Number(st.mtimeMs)).toISOString();
    minTimestamp = fallback;
    maxTimestamp = fallback;
  }

  return {
    id: sessionId,
    agent: "pi",
    alias: entry.alias,
    title: title && title.length > 0 ? title : sessionId,
    created_at: minTimestamp,
    updated_at: maxTimestamp,
    message_count: messageCount,
    storage: "jsonl",
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

function parsePiSession(dirPath: string, entry: OtherAgentEntry): SessionSummary {
  const sessionId = basename(dirPath);
  const files = collectJsonlFiles(dirPath);

  // Collect all JSONL files across the session directory
  let title: string | undefined;
  let messageCount = 0;
  let minTimestamp: string | undefined;
  let maxTimestamp: string | undefined;
  let parentSessionId: string | undefined;

  for (const filePath of files) {
    const lines = splitJsonlLines(readFileSync(filePath, "utf8"));

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i].trim();
      if (raw.length === 0) continue;

      let record: PiRecord;
      try {
        record = JSON.parse(raw) as PiRecord;
      } catch {
        continue;
      }

      // Extract parentSessionId from any event (mirrors claude.ts
      // parent_session_id / zcode.ts session.parent_id).
      if (!parentSessionId) {
        parentSessionId = readOptionalString(record.parentId);
      }

      if (record.timestamp) {
        const context = `Pi timestamp invalid for ${sessionId} at ${filePath}:${i + 1}`;
        const timestampIso = normalizeTimestamp(record.timestamp, context);
        minTimestamp = minTimestamp ? minIso(minTimestamp, timestampIso) : timestampIso;
        maxTimestamp = maxTimestamp ? maxIso(maxTimestamp, timestampIso) : timestampIso;
      }

      if (record.type === "message" && record.message) {
        messageCount += 1;
        if (!title && record.message.role === "user") {
          const content = record.message.content;
          if (Array.isArray(content)) {
            const textPart = content.find(
              (c): c is { type: "text"; text: string } =>
                c.type === "text" && typeof (c as { text?: unknown }).text === "string" && ((c as { text: string }).text.length > 0)
            );
            if (textPart?.text) {
              title = textPart.text.slice(0, 120);
            }
          } else if (typeof content === "string" && content.trim().length > 0) {
            title = content.slice(0, 120);
          }
        }
      }
    }
  }

  if (!minTimestamp || !maxTimestamp) {
    // Fallback: use directory mtime
    const { statSync } = require("node:fs");
    try {
      const stat = statSync(dirPath);
      const fallback = new Date(stat.mtimeMs).toISOString();
      minTimestamp = fallback;
      maxTimestamp = fallback;
    } catch {
      throw new Error(`Pi timestamps missing for ${sessionId} and cannot stat dir`);
    }
  }

  return {
    id: sessionId,
    agent: "pi",
    alias: entry.alias,
    title: title && title.length > 0 ? title : sessionId,
    created_at: minTimestamp,
    updated_at: maxTimestamp,
    message_count: messageCount,
    storage: "jsonl",
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

/**
 * Safely coerce an unknown value to a non-empty string, or return undefined.
 * Mirrors claude.ts readOptionalString.
 */
function readOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function parsePiMessages(dirPath: string, label: string): SessionMessage[] {
  const files = collectJsonlFiles(dirPath);
  const messages: SessionMessage[] = [];

  for (const filePath of files) {
    const lines = splitJsonlLines(readFileSync(filePath, "utf8"));

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (raw.length === 0) continue;

      let record: PiRecord;
      try {
        record = JSON.parse(raw) as PiRecord;
      } catch {
        continue;
      }

      if (record.type !== "message" || !record.message) continue;

      const role = record.message.role;
      if (role !== "user" && role !== "assistant") continue;

      const context = `${label} timestamp invalid in ${filePath}:${i + 1}`;
      const created_at = record.timestamp
        ? normalizeTimestamp(record.timestamp, context)
        : new Date().toISOString();

      const parts: SessionPart[] = [];
      const content = record.message.content;

      if (Array.isArray(content)) {
        for (const part of content) {
          parts.push(mapContentPart(part));
        }
      } else if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      }

      const message: SessionMessage = {
        id: record.id ?? `${filePath}:${i + 1}`,
        role: role as "user" | "assistant",
        created_at,
        parts,
      };

      const modelID = readOptionalString(record.message.model);
      const agentField = readOptionalString(record.message.agent);
      if (modelID) message.modelID = modelID;
      if (agentField) message.agent = agentField;

      messages.push(message);
    }
  }

  return messages;
}

/**
 * Map a raw pi content part onto the unified SessionPart union.
 * Mirrors zcode mapParts: text/tool/reasoning are first-class, anything
 * else passes through verbatim.
 */
function mapContentPart(part: PiContentPart): SessionPart {
  const t = part.type;
  if (t === "text") {
    const text = "text" in part && typeof part.text === "string" ? part.text : "";
    return { type: "text", text };
  }
  if (t === "tool") {
    const p = part as { type: "tool"; tool?: string; state?: Record<string, unknown> };
    return {
      type: "tool",
      tool: typeof p.tool === "string" ? p.tool : "",
      state: p.state ?? {},
    };
  }
  if (t === "reasoning") {
    const text = "text" in part && typeof part.text === "string" ? part.text : "";
    return { type: "reasoning", text };
  }
  // Unknown part type — pass through verbatim.
  return part as SessionPart;
}

/**
 * Determine whether any event in the session dir contains a tool-call
 * content part whose `tool` name case-insensitively contains `needle`.
 * Mirror of zcode toolSearchSessions (LOWER(tool_name) LIKE).
 */
function sessionUsesTool(dirPath: string, needle: string): boolean {
  const files = collectJsonlFiles(dirPath);
  for (const filePath of files) {
    const lines = splitJsonlLines(readFileSync(filePath, "utf8"));
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i].trim();
      if (raw.length === 0) continue;

      let record: PiRecord;
      try {
        record = JSON.parse(raw) as PiRecord;
      } catch {
        continue;
      }

      if (record.type !== "message" || !record.message) continue;
      const content = record.message.content;
      if (!Array.isArray(content)) continue;

      for (const part of content) {
        if (part.type === "tool") {
          const toolName = (part as { tool?: string }).tool ?? "";
          if (toolName.toLowerCase().includes(needle)) return true;
        }
      }
    }
  }
  return false;
}
