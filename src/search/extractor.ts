/**
 * src/search/extractor.ts
 *
 * Selective payload extraction parsing conversational prompts, assistant text,
 * toolCall names/arguments, and skipping bulk toolResult stdout/stderr dumps (>64KB).
 *
 * Fulfills Milestone 2 (Tasks 7-10):
 * - extract-user-text: Isolates user conversational text, omits system prompt boilerplate
 * - extract-assistant-text: Extracts assistant answers and reasoning/thinking tokens, skips binary/base64
 * - extract-tool-payload: Extracts tool names and structured arguments
 * - extract-skip-bulk: Skips bulk tool_result dumps, bounds fields to <=64KB (65,536 bytes)
 */

import type { ExtractedTurnPayload } from "./types";

export const MAX_FIELD_BYTES = 65536; // 64KB SQLite FTS5 dictionary bound

/**
 * Truncate a string so that its UTF-8 byte representation does not exceed maxBytes.
 * Safely avoids cutting in the middle of multi-byte UTF-8 character sequences.
 */
export function truncateToByteLimit(str: string, maxBytes: number = MAX_FIELD_BYTES): string {
  if (!str) return "";
  const buf = Buffer.from(str, "utf8");
  if (buf.byteLength <= maxBytes) {
    return str;
  }

  let end = maxBytes;
  // If byte at end is a continuation byte (0x80..0xBF), walk back to find the lead byte
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }

  if (end > 0) {
    const lead = buf[end];
    let needed = 1;
    if ((lead & 0x80) === 0) needed = 1;
    else if ((lead & 0xe0) === 0xc0) needed = 2;
    else if ((lead & 0xf0) === 0xe0) needed = 3;
    else if ((lead & 0xf8) === 0xf0) needed = 4;

    if (end + needed > maxBytes) {
      // Character does not fit within maxBytes, truncate before lead byte
    } else {
      end = end + needed;
    }
  }

  const result = buf.subarray(0, end).toString("utf8");
  if (Buffer.byteLength(result, "utf8") > maxBytes) {
    return result.slice(0, Math.floor(maxBytes / 4));
  }
  return result;
}

/**
 * Strip system boilerplate from user prompts:
 * - <system>...</system> XML tags
 * - [SYSTEM INSTRUCTION]...[/SYSTEM INSTRUCTION] / [INSTRUCTIONS]...[/INSTRUCTIONS]
 * - Markdown '# System Instructions' preamble up to double newline or end
 */
function stripSystemBoilerplate(text: string): string {
  if (!text) return "";

  let cleaned = text;

  // 1. XML tags: <system>...</system>, <system_instruction>...</system_instruction>, etc.
  cleaned = cleaned.replace(/<system\b[^>]*>[\s\S]*?<\/system>/gi, "");
  cleaned = cleaned.replace(/<system_instruction\b[^>]*>[\s\S]*?<\/system_instruction>/gi, "");
  cleaned = cleaned.replace(/<instructions?\b[^>]*>[\s\S]*?<\/instructions?>/gi, "");

  // 2. Bracket headers: [SYSTEM INSTRUCTION]...[/SYSTEM INSTRUCTION], [SYSTEM PROMPT], [INSTRUCTIONS]
  cleaned = cleaned.replace(
    /\[(?:SYSTEM\s+INSTRUCTION|SYSTEM\s+PROMPT|INSTRUCTIONS?)\][\s\S]*?\[\/(?:SYSTEM\s+INSTRUCTION|SYSTEM\s+PROMPT|INSTRUCTIONS?)\]/gi,
    ""
  );

  // 3. Markdown '# System Instructions' preamble
  cleaned = cleaned.replace(
    /(?:^|\n)#+\s*(?:System\s+Instructions?|System\s+Prompt)[^\n]*(?:\n(?!\n)[^\n]+)*(?:\n+|$)/gi,
    "\n"
  );

  return cleaned.trim();
}

/**
 * Filter raw binary chunks, base64 data URIs, and huge base64 strings from assistant text.
 */
function filterBinaryAndDataUris(text: string): string {
  if (!text) return "";
  return text.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, "").trim();
}

/**
 * Serialize tool input/arguments/state to a searchable string representation.
 */
function serializeToolArgs(args: any): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args.trim();
  if (typeof args === "object") {
    try {
      return JSON.stringify(args);
    } catch {
      return String(args);
    }
  }
  return String(args);
}

/**
 * Safely resolve timestamp from various session formats.
 */
function resolveTimestamp(obj: any): number {
  const ts =
    obj.timestamp ??
    obj.time ??
    obj.created_at ??
    obj.message?.timestamp ??
    obj.payload?.timestamp;

  if (typeof ts === "number" && !isNaN(ts) && ts > 0) {
    return ts;
  }
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
    const num = Number(ts);
    if (!isNaN(num) && num > 0) {
      return num;
    }
  }
  return Date.now();
}

/**
 * Extract selective turn payload from a raw session JSONL line.
 * Returns ExtractedTurnPayload if the line represents an indexable conversation or tool turn,
 * or null for non-message events, system prompts, invalid JSON, or empty turns.
 */
export function extractTurnPayload(rawLine: string): ExtractedTurnPayload | null {
  if (typeof rawLine !== "string" || !rawLine.trim()) {
    return null;
  }

  let obj: any;
  try {
    obj = JSON.parse(rawLine);
  } catch {
    return null;
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return null;
  }

  // Non-message and non-turn event types to ignore
  const ignoredTypes = new Set([
    "session",
    "session_meta",
    "model_change",
    "compaction",
    "thinking_level_change",
    "tool_result",
  ]);

  if (typeof obj.type === "string" && ignoredTypes.has(obj.type)) {
    return null;
  }

  // Pure system messages to ignore (no user conversational intent)
  if (
    obj.type === "system" ||
    obj.role === "system" ||
    obj.message?.role === "system" ||
    obj.payload?.role === "system"
  ) {
    return null;
  }

  // Check for recognized message/turn properties
  const hasRecognizedProps =
    obj.type !== undefined ||
    obj.role !== undefined ||
    obj.message !== undefined ||
    obj.payload !== undefined ||
    obj.tool_calls !== undefined;

  if (!hasRecognizedProps) {
    return null;
  }

  const rawRole =
    obj.role ??
    obj.message?.role ??
    obj.payload?.role ??
    (obj.type === "user" ? "user" : null) ??
    (obj.type === "assistant" ? "assistant" : null) ??
    (obj.type === "reasoning" ? "assistant" : null) ??
    (obj.type === "tool" ? "tool" : null);

  let roleNum: number | null = null;
  if (rawRole === "user" || rawRole === 1 || rawRole === "1") {
    roleNum = 1;
  } else if (rawRole === "assistant" || rawRole === 2 || rawRole === "2") {
    roleNum = 2;
  } else if (rawRole === "tool" || rawRole === 3 || rawRole === "3") {
    roleNum = 3;
  } else {
    return null;
  }

  const timestamp = resolveTimestamp(obj);

  // ───────────────────────────────────────────────────────────────────────────
  // Role 1: User
  // ───────────────────────────────────────────────────────────────────────────
  if (roleNum === 1) {
    const content = obj.content ?? obj.message?.content ?? obj.payload?.content;
    let rawUserText = "";

    if (typeof content === "string") {
      rawUserText = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        if (!item) continue;
        if (typeof item === "string") {
          parts.push(item);
        } else if (typeof item === "object") {
          // Explicitly omit bulk tool_result stdout/stderr dumps
          if (item.type === "tool_result") {
            continue;
          }
          if (typeof item.text === "string") {
            parts.push(item.text);
          }
        }
      }
      rawUserText = parts.join("\n");
    }

    const cleanedUserText = stripSystemBoilerplate(rawUserText);
    if (!cleanedUserText) {
      return null;
    }

    const user_text = truncateToByteLimit(cleanedUserText);
    return {
      user_text,
      assistant_text: "",
      tool_name: "",
      tool_args: "",
      role: 1,
      timestamp,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Role 2: Assistant
  // ───────────────────────────────────────────────────────────────────────────
  if (roleNum === 2) {
    const content = obj.content ?? obj.message?.content ?? obj.payload?.content;
    const textParts: string[] = [];
    const toolNames: string[] = [];
    const toolArgs: string[] = [];

    if (typeof content === "string") {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (!item) continue;
        if (typeof item === "string") {
          textParts.push(item);
        } else if (typeof item === "object") {
          // Skip raw binary/image blocks
          if (
            item.type === "image" ||
            item.type === "image_url" ||
            item.source?.type === "base64"
          ) {
            continue;
          }
          // Claude thinking tokens
          if (item.type === "thinking" && typeof item.thinking === "string") {
            textParts.push(item.thinking);
          }
          // Pi reasoning tokens
          else if (item.type === "reasoning" && typeof item.text === "string") {
            textParts.push(item.text);
          }
          // Assistant text (including Codex output_text)
          else if (
            (item.type === "text" || item.type === "output_text") &&
            typeof item.text === "string"
          ) {
            textParts.push(item.text);
          }
          // Claude tool_use
          else if (item.type === "tool_use") {
            if (typeof item.name === "string") toolNames.push(item.name.trim());
            const argStr = serializeToolArgs(item.input);
            if (argStr) toolArgs.push(argStr);
          }
          // Pi tool block: { type: "tool", tool: "edit", state: { ... } }
          else if (item.type === "tool") {
            if (typeof item.tool === "string") toolNames.push(item.tool.trim());
            const argStr = serializeToolArgs(item.state ?? item.arguments ?? item.input);
            if (argStr) toolArgs.push(argStr);
          }
        }
      }
    }

    // Grok reasoning: { type: "reasoning", summary: [{ text: "..." }] }
    if (Array.isArray(obj.summary)) {
      for (const item of obj.summary) {
        if (item && typeof item.text === "string") {
          textParts.push(item.text);
        }
      }
    }

    // Grok / OpenAI tool_calls: [{ id, name, arguments }] or [{ function: { name, arguments } }]
    const toolCalls = obj.tool_calls ?? obj.message?.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (!call) continue;
        const name = call.name ?? call.function?.name;
        if (typeof name === "string") toolNames.push(name.trim());
        const rawArgs = call.arguments ?? call.function?.arguments;
        const argStr = serializeToolArgs(rawArgs);
        if (argStr) toolArgs.push(argStr);
      }
    }

    // Direct toolCall object: { name, arguments } or { tool, arguments } or { function: { name, arguments } }
    const singleToolCall = obj.toolCall ?? obj.tool_call ?? obj.message?.toolCall ?? obj.message?.tool_call;
    if (singleToolCall && typeof singleToolCall === "object" && !Array.isArray(singleToolCall)) {
      const name = singleToolCall.name ?? singleToolCall.tool ?? singleToolCall.function?.name;
      if (typeof name === "string") toolNames.push(name.trim());
      const rawArgs = singleToolCall.arguments ?? singleToolCall.function?.arguments ?? singleToolCall.input;
      const argStr = serializeToolArgs(rawArgs);
      if (argStr) toolArgs.push(argStr);
    }

    const filteredText = filterBinaryAndDataUris(textParts.join("\n"));

    const assistant_text = truncateToByteLimit(filteredText);
    const tool_name = truncateToByteLimit(toolNames.join(" "));
    const tool_args = truncateToByteLimit(toolArgs.join(" "));

    if (!assistant_text && !tool_name && !tool_args) {
      return null;
    }

    return {
      user_text: "",
      assistant_text,
      tool_name,
      tool_args,
      role: 2,
      timestamp,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Role 3: Standalone Tool Invocation
  // ───────────────────────────────────────────────────────────────────────────
  if (roleNum === 3) {
    const toolNames: string[] = [];
    const toolArgs: string[] = [];

    const name = obj.tool ?? obj.name ?? "";
    if (typeof name === "string" && name.trim()) {
      toolNames.push(name.trim());
    }

    const rawArgs = obj.arguments ?? obj.input ?? obj.state;
    const argStr = serializeToolArgs(rawArgs);
    if (argStr) {
      toolArgs.push(argStr);
    }

    const tool_name = truncateToByteLimit(toolNames.join(" "));
    const tool_args = truncateToByteLimit(toolArgs.join(" "));

    if (!tool_name && !tool_args) {
      return null;
    }

    return {
      user_text: "",
      assistant_text: "",
      tool_name,
      tool_args,
      role: 3,
      timestamp,
    };
  }

  return null;
}
