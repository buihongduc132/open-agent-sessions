/**
 * Shared filesystem utilities for adapter implementations.
 *
 * DRY consolidation of path resolution, directory walking, JSONL collection,
 * file content search, and ISO timestamp comparison — previously duplicated
 * between claude.ts and codex.ts.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
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

// ============================================================================
// File Content Search
// ============================================================================

/**
 * Search file content for a case-insensitive text match.
 */
export function contentContains(filePath: string, needle: string): boolean {
  try {
    return readFileSync(filePath, "utf8").toLowerCase().includes(needle);
  } catch {
    return false;
  }
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
