/**
 * LD3 (e) — Saved queries: --save/--list/--rerun.
 *
 * Persists query templates as JSONL to ~/.config/oas-stats/history.jsonl
 * (path provided by caller).
 *
 * @file src/query/history.ts
 */
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SavedQuery {
  name: string;
  template: string;
  params: Record<string, unknown>;
}

/**
 * Append a query to history.jsonl. Creates parent dir if missing.
 */
export async function saveQuery(historyPath: string, query: SavedQuery): Promise<void> {
  await mkdir(dirname(historyPath), { recursive: true });
  const line = JSON.stringify(query) + "\n";
  await appendFile(historyPath, line, "utf8");
}

/**
 * List all saved queries. Returns [] if file missing.
 * Malformed lines are silently skipped (defensive against partial writes).
 */
export async function listQueries(historyPath: string): Promise<SavedQuery[]> {
  let content: string;
  try {
    content = await readFile(historyPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const out: SavedQuery[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as SavedQuery);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Re-run a saved query by name. Returns null if not found.
 */
export async function rerunQuery(
  historyPath: string,
  name: string,
): Promise<SavedQuery | null> {
  const all = await listQueries(historyPath);
  return all.find((q) => q.name === name) ?? null;
}
