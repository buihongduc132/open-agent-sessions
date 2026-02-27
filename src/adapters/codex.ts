import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { OtherAgentEntry } from "../config/types";
import { Adapter, SessionSummary } from "../core/types";

type CodexAdapterOptions = {
  defaultPath?: string;
  configDir?: string;
};

type CodexRecord = {
  type?: string;
  timestamp?: unknown;
  payload?: Record<string, unknown>;
};

export function createCodexAdapter(
  entry: OtherAgentEntry,
  options: CodexAdapterOptions = {}
): Adapter {
  if (entry.agent !== "codex") {
    throw new Error(`Codex adapter requires agent "codex", got "${entry.agent}"`);
  }

  return {
    listSessions: () => {
      const label = `[${entry.agent}:${entry.alias}]`;
      try {
        const rootPath = resolveCodexPath(entry, options);
        const files = collectJsonlFiles(rootPath);
        return files.map((filePath) => parseCodexSession(filePath, entry));
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

function resolveCodexPath(entry: OtherAgentEntry, options: CodexAdapterOptions): string {
  const rawPath = (entry as Record<string, unknown>).path;
  if (rawPath !== undefined && typeof rawPath !== "string") {
    throw new Error(`Codex path must be a non-empty string`);
  }
  if (typeof rawPath === "string" && rawPath.trim().length === 0) {
    throw new Error(`Codex path must be a non-empty string`);
  }

  const configured = typeof rawPath === "string" ? rawPath : undefined;
  const fallback = options.defaultPath ?? join(homedir(), ".codex", "sessions");
  const resolved = resolvePath(configured ?? fallback, options.configDir);

  const stat = safeStat(resolved);
  if (!stat) {
    throw new Error(`Codex path not found: ${resolved}`);
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`Codex path is not a file or directory: ${resolved}`);
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

function parseCodexSession(filePath: string, entry: OtherAgentEntry): SessionSummary {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  let sessionMeta: CodexRecord | undefined;
  let title: string | undefined;
  let messageCount = 0;
  let maxTimestamp: string | undefined;

  let sessionId: string | undefined;
  const entries: Array<{ record: CodexRecord; lineNumber: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.length === 0) {
      continue;
    }

    const record = parseJsonLine(raw, filePath, i + 1);
    if (record.type === "session_meta") {
      sessionId = readOptionalString(record.payload?.id) ?? sessionId;
    }
    entries.push({ record, lineNumber: i + 1 });
  }

  for (const entryInfo of entries) {
    const record = entryInfo.record;
    if (record.timestamp !== undefined && record.timestamp !== null) {
      const timestampContext = sessionId
        ? `Codex timestamp invalid for ${sessionId} at ${filePath}:${entryInfo.lineNumber}`
        : `Codex timestamp invalid at ${filePath}:${entryInfo.lineNumber}`;
      const timestampIso = normalizeTimestamp(record.timestamp, timestampContext);
      maxTimestamp = maxTimestamp ? maxIso(maxTimestamp, timestampIso) : timestampIso;
    }

    if (record.type === "session_meta") {
      sessionMeta = record;
      continue;
    }

    if (record.type === "response_item") {
      const payload = record.payload ?? {};
      const role = payload.role;
      if (role === "user" || role === "assistant") {
        messageCount += 1;
      }
      if (!title && role === "user") {
        const extracted = extractResponseText(payload);
        if (extracted) {
          title = extracted;
        }
      }
    }
  }

  if (!sessionMeta) {
    throw new Error(`Codex session missing session_meta: ${filePath}`);
  }

  const resolvedSessionId = readString(
    sessionMeta.payload?.id,
    `Codex session id missing in ${filePath}`
  );
  const createdAt = normalizeTimestamp(
    sessionMeta.payload?.timestamp,
    `Codex created_at invalid for ${resolvedSessionId} in ${filePath}`
  );
  if (!maxTimestamp) {
    throw new Error(`Codex updated_at missing for ${resolvedSessionId} in ${filePath}`);
  }

  const metaTitle = readOptionalString(sessionMeta.payload?.title);
  const resolvedTitle = preferTitle(metaTitle, title, resolvedSessionId);

  return {
    id: resolvedSessionId,
    agent: "codex",
    alias: entry.alias,
    title: resolvedTitle,
    created_at: createdAt,
    updated_at: maxTimestamp,
    message_count: messageCount,
    storage: "other",
  };
}

function parseJsonLine(line: string, filePath: string, lineNumber: number): CodexRecord {
  try {
    return JSON.parse(line) as CodexRecord;
  } catch (error) {
    throw new Error(`Codex JSONL parse error in ${filePath} at line ${lineNumber}`);
  }
}

function extractResponseText(payload: Record<string, unknown>): string | undefined {
  const content = payload.content;
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
          if (typeof record.input_text === "string") return record.input_text;
          if (typeof record.text === "string") return record.text;
          if (typeof record.output_text === "string") return record.output_text;
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

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function readString(value: unknown, context: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(context);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function preferTitle(
  metaTitle: string | undefined,
  fallbackTitle: string | undefined,
  sessionId: string
): string {
  if (metaTitle && metaTitle.length > 0) return metaTitle;
  if (fallbackTitle && fallbackTitle.length > 0) return fallbackTitle;
  return sessionId;
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
