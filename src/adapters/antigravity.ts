import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLabel } from "./label";
import { OtherAgentEntry } from "../config/types";
import {
  Adapter,
  ForkResult,
  SearchQuery,
  SessionDetail,
  SessionMessage,
  SessionReadOptions,
  SessionSummary,
  SessionPart,
  TimeRangeOptions,
  ToolSearchQuery,
} from "../core/types";
import { normalizeTimestamp } from "../core/normalize";
import { errorMessage } from "../core/utils";
import type { SimilarSessionResult } from "../similarity/search";
import {
  contentContains,
  resolvePath,
  safeStat,
  splitJsonlLines,
  sortByIsoDesc,
} from "./fs-utils";

export type AntigravityAdapterOptions = {
  dataPath?: string;
  homeDir?: string;
};

type AntigravityLogEntry = {
  step_index: number;
  source: "USER_EXPLICIT" | "MODEL" | "SYSTEM" | string;
  type: "USER_INPUT" | "PLANNER_RESPONSE" | string;
  status: "DONE" | "PENDING" | string;
  created_at: string;
  content?: string;
  tool_calls?: AntigravityToolCall[];
  // Phase 5 parity fields (mirror pi.ts JSONL adapter):
  reasoning?: string;           // → reasoning SessionPart
  model?: string;               // → message.modelID
  agent?: string;               // → message.agent
  parent_session_id?: string;   // → SessionSummary.parentSessionId
};

type AntigravityToolCall = {
  name: string;
  args: Record<string, unknown>;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAntigravityAdapter(
  entry: OtherAgentEntry,
  options: AntigravityAdapterOptions = {}
): Adapter {
  if (entry.agent !== "antigravity") {
    throw new Error(`Antigravity adapter requires agent "antigravity", got "${entry.agent}"`);
  }

  return {
    version: "1.0.0",
    listSessions: () => {
      const label = createLabel(entry);
      try {
        const dataPath = resolveAntigravityPath(entry, options);
        const brainPath = join(dataPath, "brain");
        const stat = safeStat(brainPath);
        if (!stat || !stat.isDirectory()) return [];

        const uuids = readdirSync(brainPath).filter(name => UUID_REGEX.test(name));
        return uuids.map(uuid => parseAntigravitySession(dataPath, uuid, entry));
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
        const dataPath = resolveAntigravityPath(entry, options);
        const brainPath = join(dataPath, "brain");
        const uuids = readdirSync(brainPath).filter(name => UUID_REGEX.test(name));
        const needle = query.text.toLowerCase();
        const results: SessionSummary[] = [];

        for (const uuid of uuids) {
          const logPath = join(dataPath, "brain", uuid, ".system_generated", "logs", "overview.txt");
          if (contentContains(logPath, needle)) {
            results.push(parseAntigravitySession(dataPath, uuid, entry));
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
      readOptions: SessionReadOptions
    ): Promise<SessionDetail> => {
      const label = createLabel(entry);
      const dataPath = resolveAntigravityPath(entry, options);
      const sessionPath = join(dataPath, "brain", sessionId);
      if (!safeStat(sessionPath)) {
        throw new Error(`${label} session not found: ${sessionId}`);
      }

      // TODO: parseAntigravitySession and parseAntigravityMessages both read overview.txt.
      // Consider caching or combining into a single-pass parse. Minor agent with small session counts.
      const summary = parseAntigravitySession(dataPath, sessionId, entry);
      const logPath = join(sessionPath, ".system_generated", "logs", "overview.txt");
      const stat = safeStat(logPath);
      if (!stat) {
        return { ...summary, messages: [] };
      }

      let messages = parseAntigravityMessages(logPath, label);

      // Apply selection mode (mirrors pi/claude/zcode verbatim — selection FIRST).
      const selection = readOptions.selection;
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

      // Apply role-based filtering (mirrors pi/claude/zcode verbatim — AFTER selection).
      const effectiveUserOnly = readOptions.userOnly || readOptions.selection?.userOnly;
      if (effectiveUserOnly) {
        if (readOptions.role && readOptions.role !== "user") {
          messages = [];
        } else {
          messages = messages.filter((m) => m.role === "user");
        }
      } else if (readOptions.role) {
        messages = messages.filter((m) => m.role === readOptions.role);
      }

      return {
        ...summary,
        messages,
      };
    },
    listSessionsByTimeRange: (opts: TimeRangeOptions): SessionSummary[] => {
      const label = createLabel(entry);
      try {
        // Default to the full epoch window. since/until are ms-epoch; we
        // compare against updated_at (ISO-8601 → ms). updated_at is derived
        // from the max logEntry.created_at in the session log.
        const sinceMs = opts.since != null ? opts.since : 0;
        const untilMs = opts.until != null ? opts.until : 8640000000000000;
        const skipId = opts.skipSessionId;

        const dataPath = resolveAntigravityPath(entry, options);
        const brainPath = join(dataPath, "brain");
        const stat = safeStat(brainPath);
        if (!stat || !stat.isDirectory()) return [];
        const uuids = readdirSync(brainPath).filter((name) => UUID_REGEX.test(name));

        let results: SessionSummary[] = [];
        for (const uuid of uuids) {
          try {
            const session = parseAntigravitySession(dataPath, uuid, entry);
            if (skipId === session.id) continue;
            const updatedMs = Date.parse(session.updated_at);
            if (Number.isNaN(updatedMs)) continue;
            if (updatedMs < sinceMs || updatedMs > untilMs) continue;
            results.push(session);
          } catch {
            // Skip sessions that fail to parse
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
        const dataPath = resolveAntigravityPath(entry, options);
        const brainPath = join(dataPath, "brain");
        const stat = safeStat(brainPath);
        if (!stat || !stat.isDirectory()) return [];

        const uuids = readdirSync(brainPath).filter((name) => UUID_REGEX.test(name));
        const results: SessionSummary[] = [];

        for (const uuid of uuids) {
          try {
            if (sessionUsesTool(dataPath, uuid, needle)) {
              results.push(parseAntigravitySession(dataPath, uuid, entry));
            }
          } catch {
            // Skip sessions that fail to parse
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
      // STUB: native write to agy session storage is deferred (R-18).
      // Mirror pi/claude/zcode forkSession — return a well-formed ForkResult.
      return {
        newSessionId: `agy-fork-${Date.now()}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString(),
      };
    },
    destroy: () => {
      // No-op for JSONL-based adapter (no handles to release).
    },
    findSimilarSessions: async (): Promise<SimilarSessionResult[]> => [],
  };
}

function resolveAntigravityPath(entry: OtherAgentEntry, options: AntigravityAdapterOptions): string {
  const home = options.homeDir ?? homedir();
  const configured = typeof entry.path === "string" ? entry.path : undefined;
  const defaultPath = options.dataPath ?? join(home, ".gemini", "antigravity");
  const resolved = resolvePath(configured ?? defaultPath);

  const stat = safeStat(resolved);
  if (!stat) {
    throw new Error(`Antigravity path not found: ${resolved}`);
  }
  return resolved;
}

function parseAntigravitySession(dataPath: string, uuid: string, entry: OtherAgentEntry): SessionSummary {
  const logPath = join(dataPath, "brain", uuid, ".system_generated", "logs", "overview.txt");
  const stat = safeStat(logPath);

  if (!stat) {
    const dirStat = safeStat(join(dataPath, "brain", uuid));
    const mtime = dirStat?.mtime.toISOString() ?? new Date().toISOString();
    return {
      id: uuid,
      agent: "antigravity",
      alias: entry.alias,
      title: uuid,
      created_at: mtime,
      updated_at: mtime,
      message_count: 0,
      storage: "other",
    };
  }

  const content = readFileSync(logPath, "utf8");
  const lines = splitJsonlLines(content);
  let title: string | undefined;
  let messageCount = 0;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let parentSessionId: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    let logEntry: AntigravityLogEntry;
    try {
      logEntry = JSON.parse(lines[i]);
    } catch {
      continue; // Skip malformed lines
    }

    // Extract parentSessionId from any entry (mirrors pi.ts parentId /
    // claude.ts parent_session_id — first-write-wins).
    if (!parentSessionId && logEntry.parent_session_id) {
      parentSessionId = logEntry.parent_session_id;
    }

    const ts = normalizeTimestamp(logEntry.created_at, `Antigravity timestamp invalid in ${logPath}:${i + 1}`);
    if (!firstTimestamp) firstTimestamp = ts;
    lastTimestamp = ts;

    if (logEntry.source === "USER_EXPLICIT" && logEntry.type === "USER_INPUT") {
      messageCount++;
      if (!title && logEntry.content) {
        title = logEntry.content.split(/\r?\n/)[0].trim();
      }
    } else if (logEntry.source === "MODEL" && logEntry.type === "PLANNER_RESPONSE") {
      messageCount++;
    }
  }

  const mtime = stat.mtime.toISOString();
  return {
    id: uuid,
    agent: "antigravity",
    alias: entry.alias,
    title: title || uuid,
    created_at: firstTimestamp || mtime,
    updated_at: lastTimestamp || mtime,
    message_count: messageCount,
    storage: "other",
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

function parseAntigravityMessages(logPath: string, label: string): SessionMessage[] {
  const content = readFileSync(logPath, "utf8");
  const lines = splitJsonlLines(content);
  const messages: SessionMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    let entry: AntigravityLogEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if ((entry.source === "USER_EXPLICIT" && entry.type === "USER_INPUT") ||
        (entry.source === "MODEL" && entry.type === "PLANNER_RESPONSE")) {
      
      const created_at = normalizeTimestamp(entry.created_at, `${label} timestamp invalid in ${logPath}:${i + 1}`);
      const parts: SessionPart[] = [];

      if (entry.content) {
        parts.push({ type: "text", text: entry.content });
      }

      // Phase 5: reasoning part (mirror pi.ts reasoning content part).
      if (entry.reasoning) {
        parts.push({ type: "reasoning", text: entry.reasoning });
      }

      if (entry.tool_calls) {
        for (const tc of entry.tool_calls) {
          parts.push({
            type: "tool",
            tool: tc.name,
            state: { args: tc.args },
          });
        }
      }

      const message: SessionMessage = {
        id: `step-${entry.step_index}-${i}`,
        role: entry.source === "MODEL" ? "assistant" : "user",
        created_at,
        parts,
      };

      // Phase 5: modelID + agent field (mirror pi.ts record.message.model/agent).
      if (entry.model) message.modelID = entry.model;
      if (entry.agent) message.agent = entry.agent;

      messages.push(message);
    }
  }

  return messages;
}

/**
 * Determine whether any log entry in the session's overview.txt contains a
 * tool_call whose name case-insensitively contains the needle.
 * Mirror of pi.ts sessionUsesTool / zcode.ts toolSearchSessions.
 */
function sessionUsesTool(dataPath: string, uuid: string, needle: string): boolean {
  const logPath = join(dataPath, "brain", uuid, ".system_generated", "logs", "overview.txt");
  const stat = safeStat(logPath);
  if (!stat) return false;

  const content = readFileSync(logPath, "utf8");
  const lines = splitJsonlLines(content);

  for (let i = 0; i < lines.length; i++) {
    let entry: AntigravityLogEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (!entry.tool_calls) continue;
    for (const tc of entry.tool_calls) {
      const toolName = typeof tc.name === "string" ? tc.name : "";
      if (toolName.toLowerCase().includes(needle)) return true;
    }
  }
  return false;
}
