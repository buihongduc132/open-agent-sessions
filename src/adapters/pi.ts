import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createLabel } from "./label";
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
    content?: Array<{ type: string; text?: string }> | string;
    provider?: string;
    model?: string;
    usage?: { input: number; output: number; totalTokens: number };
    errorMessage?: string;
  };
};

type PiRecord = {
  type: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }> | string;
    provider?: string;
    model?: string;
    usage?: { input: number; output: number; totalTokens: number };
    errorMessage?: string;
  };
  [key: string]: unknown;
};

export function createPiAdapter(
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
      _options: SessionReadOptions
    ): Promise<SessionDetail> => {
      const label = createLabel(entry);
      const rootPath = resolvePiPath(entry, options);
      const sessionDirs = collectSessionDirs(rootPath);

      for (const dirPath of sessionDirs) {
        const dirId = basename(dirPath);
        if (dirId === sessionId) {
          const messages = parsePiMessages(dirPath, label);
          const summary = parsePiSession(dirPath, entry);
          return { ...summary, messages };
        }
      }

      throw new Error(`${label} session not found: ${sessionId}`);
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

function parsePiSession(dirPath: string, entry: OtherAgentEntry): SessionSummary {
  const sessionId = basename(dirPath);
  const files = collectJsonlFiles(dirPath);

  // Collect all JSONL files across the session directory
  let title: string | undefined;
  let messageCount = 0;
  let minTimestamp: string | undefined;
  let maxTimestamp: string | undefined;

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
            const textPart = content.find((c) => c.type === "text" && c.text);
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
  };
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

      const parts: import("../core/types").SessionPart[] = [];
      const content = record.message.content;

      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "text" && part.text) {
            parts.push({ type: "text", text: part.text });
          }
        }
      } else if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      }

      messages.push({
        id: record.id ?? `${filePath}:${i + 1}`,
        role: role as "user" | "assistant",
        created_at,
        parts,
      });
    }
  }

  return messages;
}
