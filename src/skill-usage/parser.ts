/**
 * src/skill-usage/parser.ts
 *
 * Extract skill references from a pi session JSONL file.
 *
 * Two extraction modes:
 *   - extractSkillReads   — assistant `read` toolCalls on …/skills/<name>/SKILL.md
 *   - extractSkillMentions — text tokens from assistant text parts
 *
 * The mention extractor generates three kinds of token per text part:
 *   1. Single words (split on non-alphanumeric except - and _, length 3–40)
 *   2. Hyphen-joined bigrams from adjacent words ("verifier loop" → "verifier-loop")
 *   3. Space-joined bigrams from adjacent words ("verifier loop" → "verifier loop")
 *
 * The bigram forms let downstream matching catch multi-word skill names written
 * with either separator (T1 for hyphen-form when skill is hyphenated; T2 for
 * space-form when canonicalization collapses the space to hyphen).
 *
 * Multi-line JSON handling:
 *   JSONL files may contain literal newlines inside JSON string fields (e.g.,
 *   text content with embedded \n). The parser accumulates lines until a valid
 *   JSON object is formed, then processes it.
 */

import { readFileSync } from "node:fs";
import type { SkillMatch } from "./types";

export interface ParsedToken {
  token: string;
  sessionId: string;
  timestamp: string;
}

/** Minimum and maximum token length (inclusive). */
const MIN_TOKEN_LEN = 3;
const MAX_TOKEN_LEN = 40;

/**
 * Parse JSONL content with multi-line JSON support.
 *
 * Accumulates lines until a valid JSON object is formed, then yields it.
 * Handles the case where a JSON string field contains literal newlines
 * (which JSON.parse would otherwise reject) by normalizing the accumulated
 * buffer's newlines to spaces before parsing. This is safe for our
 * tokenizer because it splits on any non-alphanumeric run anyway.
 */
function* parseJsonl(content: string): Generator<Record<string, unknown>> {
  let buffer = "";
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    buffer += (buffer ? "\n" : "") + line;
    try {
      // Normalize literal newlines inside JSON strings to spaces.
      // Standard JSON forbids literal newlines in string values, but real-world
      // session files may contain them. For tokenization purposes the
      // whitespace variant is irrelevant (the tokenizer splits on any non-
      // alphanumeric run).
      const safeBuffer = buffer.replace(/\n/g, " ");
      const obj = JSON.parse(safeBuffer);
      yield obj;
      buffer = "";
    } catch {
      // Incomplete JSON — keep accumulating
    }
  }
}

/**
 * Extract skill-load events from `read` toolCalls targeting SKILL.md paths.
 *
 * Each match is returned as a T1 exact SkillMatch (source: "read-tool").
 */
export function extractSkillReads(filePath: string): SkillMatch[] {
  const content = readFileSync(filePath, "utf-8");
  const result: SkillMatch[] = [];
  let sessionId = "";

  for (const event of parseJsonl(content)) {
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
      if (p.name !== "read") continue;

      const args = p.arguments as Record<string, unknown> | undefined;
      const path = args?.path;
      if (typeof path !== "string") continue;

      const m = path.match(/skills\/([^/]+)\/SKILL\.md$/);
      if (!m) continue;

      const skill = m[1];
      result.push({
        skill,
        tier: "exact",
        distance: 0,
        matchedText: skill,
        source: "read-tool",
        sessionId,
        timestamp: ts,
      });
    }
  }

  return result;
}

/**
 * Extract mention tokens from assistant text parts.
 *
 * Returns single-word tokens plus hyphen-joined and space-joined bigrams
 * from adjacent words. All tokens are lowercase and deduped per file.
 */
export function extractSkillMentions(filePath: string): ParsedToken[] {
  const content = readFileSync(filePath, "utf-8");
  const result: ParsedToken[] = [];
  const seen = new Set<string>();
  let sessionId = "";

  const add = (token: string, ts: string) => {
    if (seen.has(token)) return;
    seen.add(token);
    result.push({ token, sessionId, timestamp: ts });
  };

  for (const event of parseJsonl(content)) {
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
      if (p.type !== "text") continue;
      const text = typeof p.text === "string" ? p.text : "";
      if (!text) continue;

      const lowered = text.toLowerCase();
      const rawWords = lowered
        .split(/[^a-z0-9_-]+/)
        .filter((w) => w.length >= MIN_TOKEN_LEN && w.length <= MAX_TOKEN_LEN);

      // Single-word tokens
      for (const w of rawWords) {
        add(w, ts);
      }

      // Bigrams (hyphen-joined and space-joined)
      for (let i = 0; i < rawWords.length - 1; i++) {
        const hyphen = `${rawWords[i]}-${rawWords[i + 1]}`;
        const space = `${rawWords[i]} ${rawWords[i + 1]}`;
        if (hyphen.length >= MIN_TOKEN_LEN && hyphen.length <= MAX_TOKEN_LEN) {
          add(hyphen, ts);
          add(space, ts);
        }
      }
    }
  }

  return result;
}
