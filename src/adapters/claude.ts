import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { OtherAgentEntry } from "../config/types";
import {
  Adapter,
  SearchQuery,
  SessionDetail,
  SessionMessage,
  SessionReadOptions,
  SessionSummary,
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
} from "./fs-utils";

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
};

export function createClaudeAdapter(
  entry: OtherAgentEntry,
  options: ClaudeAdapterOptions = {}
): Adapter {
  if (entry.agent !== "claude") {
    throw new Error(`Claude adapter requires agent "claude", got "${entry.agent}"`);
  }

  return {
    version: "1.0.0", // TODO: Replace with actual version from package.json or similar
    listSessions: () => {
      const label = `[${entry.agent}:${entry.alias}]`;
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
      const label = `[${entry.agent}:${entry.alias}]`;
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

        results.sort(
          (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
        );
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
      _options: SessionReadOptions
    ): Promise<SessionDetail> => {
      const label = `[${entry.agent}:${entry.alias}]`;
      const rootPath = resolveClaudePath(entry, options);
      const files = collectJsonlFiles(rootPath);

      for (const filePath of files) {
        const sessionIdFromFile = basename(filePath, ".jsonl");
        if (sessionIdFromFile === sessionId) {
          const messages = parseClaudeMessages(filePath, label);
          // parseClaudeSession already computed the summary
          const summary = parseClaudeSession(filePath, entry);
          return {
            ...summary,
            messages,
          };
        }
      }

      throw new Error(`${label} session not found: ${sessionId}`);
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
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  let title: string | undefined;
  let messageCount = 0;
  let minTimestamp: string | undefined;
  let maxTimestamp: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.length === 0) {
      continue;
    }

    const record = parseJsonLine(raw, filePath, i + 1);
    const recordType = record.type;
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
  };
}

function parseJsonLine(line: string, filePath: string, lineNumber: number): ClaudeRecord {
  try {
    return JSON.parse(line) as ClaudeRecord;
  } catch (error) {
    throw new Error(`Claude JSONL parse error in ${filePath} at line ${lineNumber}`);
  }
}

function extractContentLine(content: unknown): string | undefined {
  const text = extractContentText(content);
  if (!text) return undefined;
  const line = text.split(/\r?\n/)[0]?.trim();
  return line && line.length > 0 ? line : undefined;
}

function extractContentText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const pieces = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.output_text === "string") return record.output_text;
          if (typeof record.input_text === "string") return record.input_text;
        }
        return "";
      })
      .filter((part) => part.length > 0);
    return pieces.length > 0 ? pieces.join("") : undefined;
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
  }
  return undefined;
}

/**
 * Parse all messages from a Claude JSONL transcript file.
 */
function parseClaudeMessages(filePath: string, label: string): SessionMessage[] {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
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

    const textParts = extractContentParts(record.content);
    const parts: import("../core/types").SessionPart[] = textParts.map((text) => ({
      type: "text",
      text,
    }));

    messages.push({
      id: typeof recordId === "string" ? recordId : `${filePath}:${i + 1}`,
      role: recordType as "user" | "assistant",
      created_at,
      parts,
    });
  }

  return messages;
}

/**
 * Extract text parts from Claude message content.
 */
function extractContentParts(content: unknown): string[] {
  const parts: string[] = [];

  if (typeof content === "string") {
    parts.push(content);
    return parts;
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const text =
          (typeof record.input_text === "string" ? record.input_text : null) ??
          (typeof record.text === "string" ? record.text : null) ??
          (typeof record.output_text === "string" ? record.output_text : null);
        if (text) parts.push(text);
      }
    }
  } else if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    const text =
      (typeof record.input_text === "string" ? record.input_text : null) ??
      (typeof record.text === "string" ? record.text : null) ??
      (typeof record.output_text === "string" ? record.output_text : null);
    if (text) parts.push(text);
  }

  return parts;
}
