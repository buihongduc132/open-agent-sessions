import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { OtherAgentEntry } from "../config/types";
import { Adapter, SessionSummary } from "../core/types";

type ClaudeAdapterOptions = {
  defaultPath?: string;
  configDir?: string;
};

type ClaudeRecord = {
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
  };
}

function resolveClaudePath(entry: OtherAgentEntry, options: ClaudeAdapterOptions): string {
  const rawPath = (entry as Record<string, unknown>).path;
  if (rawPath !== undefined && typeof rawPath !== "string") {
    throw new Error(`Claude path must be a non-empty string`);
  }
  if (typeof rawPath === "string" && rawPath.trim().length === 0) {
    throw new Error(`Claude path must be a non-empty string`);
  }

  const configured = typeof rawPath === "string" ? rawPath : undefined;
  const defaultPath =
    options.defaultPath ??
    (safeStat(join(homedir(), ".claude", "transcripts"))
      ? join(homedir(), ".claude", "transcripts")
      : join(homedir(), ".claude", "sessions"));
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

function collectJsonlFiles(rootPath: string): string[] {
  const stat = statSync(rootPath);
  if (stat.isFile()) {
    return [rootPath];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const files: string[] = [];
  walkDir(rootPath, files);
  return files.sort((a, b) => a.localeCompare(b));
}

function walkDir(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
}

function parseClaudeSession(filePath: string, entry: OtherAgentEntry): SessionSummary {
  const sessionId = basename(filePath, ".jsonl");
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
      const context = `Claude timestamp invalid for ${sessionId} at ${filePath}:${i + 1}`;
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

function normalizeTimestamp(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(context);
  }
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(context);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(context);
  }
  return parsed.toISOString();
}

function minIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function resolvePath(pathValue: string, baseDir?: string): string {
  const expanded = expandTilde(pathValue);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  const base = baseDir ?? process.cwd();
  return resolve(base, expanded);
}

function expandTilde(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function safeStat(pathValue: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(pathValue);
  } catch (error) {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
