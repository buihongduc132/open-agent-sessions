import { AgentKind } from "../config/types";
import { SessionSummary, SessionStorageKind } from "./types";

const ALLOWED_AGENTS: AgentKind[] = ["opencode", "codex", "claude"];
const ALLOWED_STORAGE: SessionStorageKind[] = ["db", "jsonl", "other"];

export function normalizeSessionSummary(
  input: unknown,
  context = "SessionSummary"
): SessionSummary {
  if (!isPlainObject(input)) {
    throw new Error(`${context}: session summary must be a mapping, got ${typeName(input)}`);
  }

  const record = input as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`${context}: id must be a non-empty string`);
  }

  const agent = record.agent;
  if (typeof agent !== "string" || !ALLOWED_AGENTS.includes(agent as AgentKind)) {
    throw new Error(
      `${context}: agent must be one of ${ALLOWED_AGENTS.join(", ")}, got ${stringifyValue(agent)}`
    );
  }

  const alias = record.alias;
  if (typeof alias !== "string") {
    throw new Error(`${context}: alias must be a string`);
  }

  const title = record.title;
  if (typeof title !== "string") {
    throw new Error(`${context}: title must be a string`);
  }

  const createdAt = normalizeTimestamp(record.created_at, `${context}: created_at`);
  const updatedAt = normalizeTimestamp(record.updated_at, `${context}: updated_at`);

  const messageCount = record.message_count;
  if (!Number.isInteger(messageCount) || (messageCount as number) < 0) {
    throw new Error(`${context}: message_count must be a non-negative integer`);
  }

  const storage = record.storage;
  if (typeof storage !== "string" || !ALLOWED_STORAGE.includes(storage as SessionStorageKind)) {
    throw new Error(
      `${context}: storage must be one of ${ALLOWED_STORAGE.join(", ")}, got ${stringifyValue(storage)}`
    );
  }

  return {
    id,
    agent: agent as AgentKind,
    alias,
    title,
    created_at: createdAt,
    updated_at: updatedAt,
    message_count: messageCount as number,
    storage: storage as SessionStorageKind,
  };
}

function normalizeTimestamp(value: unknown, context: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${context} must be a valid timestamp`);
    }
    return value.toISOString();
  }

  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`${context} must be a valid timestamp`);
    }
    return date.toISOString();
  }

  throw new Error(`${context} must be a valid timestamp`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  return String(value);
}
