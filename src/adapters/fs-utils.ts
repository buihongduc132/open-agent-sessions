/**
 * Shared filesystem utilities for adapter implementations.
 *
 * DRY consolidation of path resolution, directory walking, JSONL collection,
 * file content search, and ISO timestamp comparison — previously duplicated
 * between claude.ts and codex.ts.
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// ============================================================================
// Path Resolution
// ============================================================================

export function resolvePath(pathValue: string, baseDir?: string): string {
  const expanded = expandTilde(pathValue);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  const base = baseDir ?? process.cwd();
  return resolve(base, expanded);
}

export function expandTilde(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

export function safeStat(pathValue: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(pathValue);
  } catch {
    return null;
  }
}

// ============================================================================
// JSONL File Collection
// ============================================================================

export function collectJsonlFiles(rootPath: string): string[] {
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

export function walkDir(dir: string, files: string[]): void {
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

// NOTE: Reads entire file into memory. For session JSONL files (< 50MB typical),
// this is acceptable. Streaming would be needed for files > 100MB.
export function splitJsonlLines(content: string): string[] {
  return content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

// ============================================================================
// File Content Search
// ============================================================================

export function contentContains(filePath: string, needle: string): boolean {
  try {
    return readFileSync(filePath, "utf8").toLowerCase().includes(needle);
  } catch {
    return false;
  }
}

/**
 * BUG-2/3: Streaming, case-insensitive content check.
 *
 * Reads the file in bounded chunks (default 1 MiB) instead of loading the
 * whole file, and early-exits on the first match. A (needleLength - 1) byte
 * overlap between consecutive chunks guarantees matches that straddle a chunk
 * boundary are still found. Non-UTF8 bytes are tolerated: chunk boundaries
 * may split a multi-byte sequence, but since the needle is compared as
 * lowercase text and a split sequence cannot equal an ASCII-ish needle,
 * no false negatives are introduced for text needles.
 */
export function contentContainsStreaming(
  filePath: string,
  needleLower: string,
  options: { maxBytes?: number } = {}
): boolean {
  const maxBytes = options.maxBytes;
  if (needleLower.length === 0) return true;
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }
  try {
    const stat = safeStat(filePath);
    const size = stat ? Number(stat.size) : 0;
    const capped = maxBytes !== undefined && maxBytes >= 0 && size > maxBytes;
    const limit = capped ? maxBytes! : size;
    if (limit <= 0) return false;

    const CHUNK = 1024 * 1024;
    const overlap = Math.min(needleLower.length - 1, CHUNK);
    // Buffer layout per iteration: [0, prevCarry) = tail of previous chunk
    // (overlap guard), [prevCarry, prevCarry + read) = fresh bytes read at
    // file offset `offset`.
    const buf = Buffer.alloc(CHUNK + overlap);
    let prevCarry = 0;
    let offset = 0;
    while (offset < limit) {
      const toRead = Math.min(CHUNK, limit - offset);
      const read = Number(readSync(fd, buf, prevCarry, toRead, offset));
      if (read <= 0) break;
      const text = buf.toString("utf8", 0, prevCarry + read).toLowerCase();
      if (text.includes(needleLower)) return true;
      offset += read;
      // Retain the last `newCarry` bytes of the fresh data so a needle split
      // across chunk boundaries is still found at the start of the next chunk.
      const newCarry = Math.min(overlap, read);
      if (newCarry > 0) {
        buf.copy(buf, 0, prevCarry + read - newCarry, prevCarry + read);
      }
      prevCarry = newCarry;
      if (capped) break; // single bounded chunk when capped
    }
    return false;
  } catch {
    return false;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

export function listJsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export function containsIgnoreCase(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

// ============================================================================
// ISO Timestamp Helpers
// ============================================================================

export function minIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

export function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export function sortByIsoDesc<T>(arr: T[], key: keyof T): T[] {
  return [...arr].sort((a, b) => {
    const aVal = String(a[key] ?? "");
    const bVal = String(b[key] ?? "");
    return Date.parse(bVal) - Date.parse(aVal);
  });
}

// ============================================================================
// Safe Text File Read
// ============================================================================

export function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
