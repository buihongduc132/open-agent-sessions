/**
 * src/cmd-usage/parser.ts
 *
 * Extract bash toolCall commands from pi session JSONL files.
 *
 * Mirrors the pattern from src/skill-usage/parser.ts:
 *   - Multi-line JSON tolerant (accumulates buffer until valid JSON)
 *   - Tracks sessionId from session blocks
 *   - Filters for toolCall blocks where name="bash"
 *   - Extracts arguments.command, timestamp, toolCallId
 */

import { readFileSync } from "node:fs";

export interface RawBashCall {
  command: string;
  ts: string;
  sessionId: string;
  toolCallId: string;
}

/**
 * Parse JSONL content with multi-line JSON support.
 * Accumulates lines until a valid JSON object is formed.
 */
function* parseJsonl(content: string): Generator<Record<string, unknown>> {
  let buffer = "";
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    buffer += (buffer ? "\n" : "") + line;
    try {
      const safeBuffer = buffer.replace(/\n/g, " ");
      const obj = JSON.parse(safeBuffer);
      yield obj;
      buffer = "";
    } catch {
      // If buffer is a single line that failed to parse, skip it (malformed JSON).
      // If buffer has multiple lines, keep accumulating (multi-line JSON support).
      if (!buffer.includes("\n")) {
        buffer = "";
      }
    }
  }
}

/**
 * Extract bash commands from a pi session JSONL file.
 *
 * Walks all events, tracking sessionId from session blocks.
 * For each assistant message with toolCall blocks where name="bash",
 * extracts the command, timestamp, sessionId, and toolCallId.
 */
export function extractBashCommands(filePath: string): RawBashCall[] {
  const content = readFileSync(filePath, "utf-8");
  const result: RawBashCall[] = [];
  let sessionId = "";

  for (const event of parseJsonl(content)) {
    // Track session ID
    if (event.type === "session") {
      const id = (event as { id?: unknown }).id;
      if (typeof id === "string") sessionId = id;
      continue;
    }

    if (event.type !== "message") continue;

    const msg = (event as { message?: Record<string, unknown> }).message;
    if (!msg || msg.role !== "assistant") continue;

    const ts = typeof event.timestamp === "string" ? event.timestamp : "";
    const contentArr = msg.content;
    if (!Array.isArray(contentArr)) continue;

    for (const part of contentArr) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "toolCall") continue;
      if (p.name !== "bash") continue;

      const args = p.arguments as Record<string, unknown> | undefined;
      const command = args?.command;
      if (typeof command !== "string") continue;

      const toolCallId = typeof p.id === "string" ? p.id : "";

      result.push({
        command,
        ts,
        sessionId,
        toolCallId,
      });
    }
  }

  return result;
}
