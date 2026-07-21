/**
 * src/skill-usage/inventory.ts
 *
 * Scan one or more inventory directories for skill definitions.
 *
 * Each skill lives at <invDir>/<skill-name>/SKILL.md. The SKILL.md YAML
 * frontmatter provides:
 *   name:         canonical skill name (required)
 *   description:  short description
 *   metadata.aliases: list of alternate names (CLI aliases, synonyms)
 *
 * Entries are deduped by name (first directory wins on collision).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SkillInventoryEntry } from "./types";

export function loadSkillInventory(dirs: string[]): SkillInventoryEntry[] {
  const entries = new Map<string, SkillInventoryEntry>();

  for (const dir of dirs) {
    let topEntries: string[];
    try {
      topEntries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of topEntries) {
      // Skip hidden dirs (e.g. .archive, .curator_backups)
      if (name.startsWith(".")) continue;

      const skillDir = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(skillDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;

      const skillMdPath = join(skillDir, "SKILL.md");
      let content: string;
      try {
        content = readFileSync(skillMdPath, "utf-8");
      } catch {
        continue;
      }

      const fm = parseFrontmatter(content);
      const skillName = fm.name;
      if (!skillName) continue;

      // Dedup by canonical name — first directory wins
      if (entries.has(skillName)) continue;

      entries.set(skillName, {
        name: skillName,
        description: typeof fm.description === "string" ? fm.description : "",
        aliases: parseAliases(fm),
        path: skillMdPath,
      });
    }
  }

  return Array.from(entries.values());
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 *
 * Handles the subset of YAML used in pi/hermes SKILL.md files via an
 * indentation-aware recursive parser:
 *   - Top-level scalar key: value (quotes stripped)
 *   - Nested mapping under a key (deeper indent)
 *   - List items under a key (dash-prefixed, deeper indent)
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const yaml = content.slice(3, end).trim();
  const lines = yaml.split("\n");
  const { result } = parseBlock(lines, 0, 0);
  return result;
}

interface BlockParseResult {
  result: Record<string, unknown>;
  nextIndex: number;
}

/**
 * Parse a YAML block (mapping or list) starting at lines[startIndex] with
 * entries indented at >= minIndent. Returns the parsed result and the index
 * of the next line outside this block.
 */
function parseBlock(
  lines: string[],
  startIndex: number,
  minIndent: number,
): BlockParseResult {
  const result: Record<string, unknown> = {};
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const indent = leadingSpaces(line);
    if (indent < minIndent) break;

    const trimmed = line.trim();

    // List item
    if (trimmed.startsWith("- ") || trimmed === "-") {
      // Lists are handled by parseList; skip here (shouldn't reach in mapping)
      i++;
      continue;
    }

    const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_.-]*)\s*:\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1];
    const inlineValue = match[2];

    if (inlineValue !== "") {
      result[key] = stripQuotes(inlineValue);
      i++;
      continue;
    }

    // Block value: nested mapping or list at deeper indent
    const childIndent = indent + 2; // assume 2-space indent step
    const child = parseChildBlock(lines, i + 1, childIndent);
    result[key] = child.value;
    i = child.nextIndex;
  }

  return { result, nextIndex: i };
}

interface ChildBlockResult {
  value: unknown;
  nextIndex: number;
}

/**
 * Parse the value following a `key:` line — either a nested mapping or a list,
 * determined by the first non-empty child line.
 */
function parseChildBlock(
  lines: string[],
  startIndex: number,
  minIndent: number,
): ChildBlockResult {
  // Peek at first non-empty line to determine type
  let peek = startIndex;
  while (peek < lines.length) {
    const line = lines[peek];
    if (!line.trim()) {
      peek++;
      continue;
    }
    const indent = leadingSpaces(line);
    if (indent < minIndent) {
      // No children — empty mapping
      return { value: {}, nextIndex: startIndex };
    }
    break;
  }

  if (peek >= lines.length) {
    return { value: {}, nextIndex: startIndex };
  }

  const firstTrimmed = lines[peek].trim();
  if (firstTrimmed.startsWith("- ") || firstTrimmed === "-") {
    // List
    return parseList(lines, startIndex, minIndent);
  }
  // Nested mapping
  const { result, nextIndex } = parseBlock(lines, startIndex, minIndent);
  return { value: result, nextIndex };
}

function parseList(
  lines: string[],
  startIndex: number,
  minIndent: number,
): ChildBlockResult {
  const items: unknown[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const indent = leadingSpaces(line);
    if (indent < minIndent) break;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      items.push(stripQuotes(trimmed.slice(2)));
    } else if (trimmed === "-") {
      items.push("");
    } else {
      // Not a list item — stop
      break;
    }
    i++;
  }
  return { value: items, nextIndex: i };
}

function leadingSpaces(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

function stripQuotes(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseAliases(fm: Record<string, unknown>): string[] {
  const metadata = fm.metadata;
  if (!metadata || typeof metadata !== "object") return [];
  const aliases = (metadata as Record<string, unknown>).aliases;
  if (!Array.isArray(aliases)) return [];
  return aliases.filter((x): x is string => typeof x === "string");
}
