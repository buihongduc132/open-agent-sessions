import type { SessionMessage } from "../core/types";

function textOfRecord(record: Record<string, unknown>): string {
  return (
    (typeof record.text === "string" ? record.text : null) ??
    (typeof record.output_text === "string" ? record.output_text : null) ??
    (typeof record.input_text === "string" ? record.input_text : null) ??
    ""
  );
}

function textOfRecordCodex(record: Record<string, unknown>): string {
  return (
    (typeof record.input_text === "string" ? record.input_text : null) ??
    (typeof record.text === "string" ? record.text : null) ??
    (typeof record.output_text === "string" ? record.output_text : null) ??
    ""
  );
}

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/)[0]?.trim();
  return line && line.length > 0 ? line : undefined;
}

export function extractContentTextCodex(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const pieces = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return textOfRecordCodex(item as Record<string, unknown>);
        return "";
      })
      .filter((p) => p.length > 0);
    return pieces.length > 0 ? pieces.join("") : undefined;
  }
  if (content && typeof content === "object") return textOfRecord((content as Record<string, unknown>));
  return undefined;
}

export function extractContentTextClaude(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const pieces = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return textOfRecord(item as Record<string, unknown>);
        return "";
      })
      .filter((p) => p.length > 0);
    return pieces.length > 0 ? pieces.join("") : undefined;
  }
  if (content && typeof content === "object") return textOfRecord((content as Record<string, unknown>));
  return undefined;
}

export function extractContentLine(content: unknown): string | undefined {
  const text = extractContentTextClaude(content);
  return text ? firstLine(text) : undefined;
}

export function extractContentLineGemini(content: unknown): string | undefined {
  const text = extractContentTextGemini(content);
  return text ? firstLine(text) : undefined;
}

export function extractFirstResponseLine(content: unknown): string | undefined {
  const text = extractContentTextCodex(content);
  return text ? firstLine(text) : undefined;
}

export function extractContentPartsCodex(content: unknown): string[] {
  const parts: string[] = [];
  if (typeof content === "string") { parts.push(content); return parts; }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object") { const t = textOfRecordCodex(item as Record<string, unknown>); if (t) parts.push(t); }
    }
  } else if (content && typeof content === "object") {
    const t = textOfRecordCodex(content as Record<string, unknown>); if (t) parts.push(t);
  }
  return parts;
}

export function extractContentPartsClaude(content: unknown): string[] {
  const parts: string[] = [];
  if (typeof content === "string") { parts.push(content); return parts; }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object") { const t = textOfRecord(item as Record<string, unknown>); if (t) parts.push(t); }
    }
  } else if (content && typeof content === "object") {
    const t = textOfRecord(content as Record<string, unknown>); if (t) parts.push(t);
  }
  return parts;
}

export function extractContentTextGemini(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const pieces = (content as Array<{ text?: string }>).map(item => item.text ?? "").filter(t => t.length > 0);
    return pieces.length > 0 ? pieces.join("") : undefined;
  }
  return undefined;
}

export function extractContentPartsGemini(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) {
    return (content as Array<{ text?: string }>).map(item => item.text ?? "").filter(t => t.length > 0);
  }
  return [];
}
