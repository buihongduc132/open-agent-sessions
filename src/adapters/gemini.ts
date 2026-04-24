import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createLabel } from "./label";
import {
  extractContentLineGemini,
  extractContentPartsGemini,
} from "./content-utils";
import { OtherAgentEntry } from "../config/types";
import {
  Adapter,
  SearchQuery,
  SessionDetail,
  SessionMessage,
  SessionReadOptions,
  SessionSummary,
  SessionPart,
} from "../core/types";
import { normalizeTimestamp } from "../core/normalize";
import { errorMessage } from "../core/utils";
import type { SimilarSessionResult } from "../similarity/search";
import {
  collectJsonlFiles,
  contentContains,
  resolvePath,
  safeStat,
  splitJsonlLines,
  sortByIsoDesc,
} from "./fs-utils";

export type GeminiAdapterOptions = {
  defaultPath?: string;
  homeDir?: string;
};

type GeminiRecord = {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: unknown;
  thoughts?: Array<{ subject: string; description: string; timestamp: string }>;
  tokens?: { input: number; output: number; cached: number; thoughts: number; tool: number; total: number };
  model?: string;
  toolCalls?: GeminiToolCall[];
  "$set"?: unknown;
};

type GeminiToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  status?: string;
  timestamp?: string;
};

export function createGeminiAdapter(
  entry: OtherAgentEntry,
  options: GeminiAdapterOptions = {}
): Adapter {
  if (entry.agent !== "gemini") {
    throw new Error(`Gemini adapter requires agent "gemini", got "${entry.agent}"`);
  }

  return {
    version: "1.0.0",
    listSessions: () => {
      const label = createLabel(entry);
      try {
        const rootPath = resolveGeminiPath(entry, options);
        const files = collectJsonlFiles(rootPath);
        const results: SessionSummary[] = [];
        for (const filePath of files) {
          try {
            results.push(parseGeminiSession(filePath, entry));
          } catch {
            // Skip files that fail to parse
          }
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
    searchSessions: (query: SearchQuery): SessionSummary[] => {
      const label = createLabel(entry);
      try {
        const rootPath = resolveGeminiPath(entry, options);
        const files = collectJsonlFiles(rootPath);
        const needle = query.text.toLowerCase();
        const results: SessionSummary[] = [];

        for (const filePath of files) {
          try {
            const session = parseGeminiSession(filePath, entry);
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
      const rootPath = resolveGeminiPath(entry, options);

      // Validate sessionId to prevent path traversal
      if (basename(sessionId) !== sessionId || sessionId.includes("..")) {
        throw new Error(`${label} invalid session id: ${sessionId}`);
      }

      // Try direct file lookup first: <sessionId>.jsonl
      const directPath = join(rootPath, sessionId + ".jsonl");
      const directStat = safeStat(directPath);
      let targetPath: string | undefined;

      if (directStat) {
        targetPath = directPath;
      } else {
        // Fall back to O(N) scan
        const files = collectJsonlFiles(rootPath);
        for (const filePath of files) {
          const summary = parseGeminiSession(filePath, entry);
          if (summary.id === sessionId) {
            targetPath = filePath;
            break;
          }
        }
      }

      if (!targetPath) {
        throw new Error(`${label} session not found: ${sessionId}`);
      }

      const summary = parseGeminiSession(targetPath, entry);
      // TODO(PR#15-c4): parseGeminiSession and parseGeminiMessages both read the same file.
      // Consider combining into a single-pass parse to avoid double I/O.
      let messages = parseGeminiMessages(targetPath, label);

      // Apply selection/filtering
      if (readOptions.userOnly) {
        messages = messages.filter(m => m.role === "user");
      }
      if (readOptions.selection) {
        const { mode, count, start, end } = readOptions.selection;
        if (mode === "last") {
          messages = (count === 0) ? messages : messages.slice(-(count ?? 10));
        } else if (mode === "first") {
          messages = messages.slice(0, count ?? 10);
        } else if (mode === "range") {
          messages = messages.slice((start ?? 1) - 1, end ?? messages.length);
        }
      }

      return {
        ...summary,
        messages,
      };
    },
    findSimilarSessions: async (): Promise<SimilarSessionResult[]> => [],
  };
}

function resolveGeminiPath(entry: OtherAgentEntry, options: GeminiAdapterOptions): string {
  const home = options.homeDir ?? homedir();
  const configured = typeof entry.path === "string" ? entry.path : undefined;
  const defaultPath = options.defaultPath ?? join(home, ".gemini", "tmp");
  const resolved = resolvePath(configured ?? defaultPath);

  const stat = safeStat(resolved);
  if (!stat) {
    throw new Error(`Gemini path not found: ${resolved}`);
  }
  return resolved;
}

function parseGeminiSession(filePath: string, entry: OtherAgentEntry): SessionSummary {
  const content = readFileSync(filePath, "utf8");
  const lines = splitJsonlLines(content);
  if (lines.length === 0) {
    throw new Error(`Gemini session file is empty: ${filePath}`);
  }

  let header: any;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`Gemini JSONL parse error in ${filePath} at line 1`);
  }

  const sessionId = header.sessionId || basename(filePath, ".jsonl");
  let title: string | undefined;
  let messageCount = 0;
  let created_at = normalizeTimestamp(header.startTime, `Gemini timestamp invalid for ${sessionId} in ${filePath}`);
  let updated_at = normalizeTimestamp(header.lastUpdated || header.startTime, `Gemini timestamp invalid for ${sessionId} in ${filePath}`);

  for (let i = 1; i < lines.length; i++) {
    let record: GeminiRecord;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (record["$set"]) continue;
    if (record.type === "user" || record.type === "gemini") {
      messageCount++;
      if (!title && record.type === "user") {
        title = extractContentLineGemini(record.content);
      }
    }
  }

  return {
    id: sessionId,
    agent: "gemini",
    alias: entry.alias,
    title: title || sessionId,
    created_at,
    updated_at,
    message_count: messageCount,
    storage: "jsonl",
  };
}

function parseGeminiMessages(filePath: string, label: string): SessionMessage[] {
  const content = readFileSync(filePath, "utf8");
  const lines = splitJsonlLines(content);
  const messageMap = new Map<string, SessionMessage>();
  const messageOrder: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    let record: GeminiRecord;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (record["$set"]) continue;
    if (record.type !== "user" && record.type !== "gemini") continue;

    const id = record.id || `${filePath}:${i + 1}`;
    const context = `${label} timestamp invalid in ${filePath}:${i + 1}`;
    const created_at = normalizeTimestamp(record.timestamp, context);

    const parts: SessionPart[] = [];

    // Reasoning parts from thoughts
    if (record.thoughts) {
      for (const thought of record.thoughts) {
        parts.push({
          type: "reasoning",
          text: `[${thought.subject}] ${thought.description}`,
        });
      }
    }

    // Text parts
    const textParts = extractContentPartsGemini(record.content);
    for (const text of textParts) {
      parts.push({ type: "text", text });
    }

    // Tool parts
    if (record.toolCalls) {
      for (const tc of record.toolCalls) {
        parts.push({
          type: "tool",
          tool: tc.name,
          state: {
            id: tc.id,
            args: tc.args,
            result: tc.result,
            status: tc.status,
          },
        });
      }
    }

    const msg: SessionMessage = {
      id,
      role: record.type === "gemini" ? "assistant" : "user",
      created_at,
      parts,
      modelID: record.model,
    };

    if (record.tokens) {
      (msg as any).tokens = record.tokens;
    }

    if (messageMap.has(id)) {
      // Deduplicate: replace with latest update
      messageMap.set(id, msg);
    } else {
      messageMap.set(id, msg);
      messageOrder.push(id);
    }
  }

  return messageOrder.map(id => messageMap.get(id)!);
}
