/**
 * ZCode Adapter — STUB (RED PHASE)
 *
 * Reads sessions from ~/.zcode/cli/db/db.sqlite (SQLite).
 *
 * This file is intentionally NOT implemented. It exists only so tests in
 * test/adapters/zcode.test.ts can compile and then FAIL — the RED phase of TDD.
 * The GREEN-phase agent will replace this stub with real logic.
 *
 * Schema (VERIFIED against live DB):
 *   session(id, project_id, parent_id, slug, directory, title, version,
 *           time_created ms, time_updated ms, task_type, title_source)
 *   message(id, session_id, time_created, time_updated, data JSON, sequence)
 *     - role lives inside data.role (NO role column)
 *   part(id, message_id, session_id, time_created, time_updated, data JSON, sequence)
 *     - type lives inside data.type (NO type column): text | tool | reasoning
 *   tool_usage(id, session_id, tool_call_id, tool_name, status, started_at, completed_at, duration_ms)
 *   All times are ms-epoch integers (NOT seconds).
 *
 * @file src/adapters/zcode.ts
 */

import type { Database } from "bun:sqlite";
import type { Adapter } from "../core/types";
import type { OtherAgentEntry } from "../config/types";

/** Options for the zcode adapter. dbPath may be a path string or an injected Database (for tests). */
export type ZcodeAdapterOptions = {
  /** Path to db.sqlite. Defaults to ~/.zcode/cli/db/db.sqlite */
  dbPath?: string | Database;
};

type ZcodeAgentEntry = Extract<OtherAgentEntry, { agent: "zcode" }>;

/**
 * STUB factory. Throws so RED-phase tests fail in a predictable way.
 * GREEN phase will implement: schema validation, readonly open, row → SessionSummary
 * mapping, message+part join, tool_usage search, ms-epoch → ISO conversion.
 */
export function createZcodeAdapter(
  _entry: ZcodeAgentEntry,
  _options: ZcodeAdapterOptions = {}
): Adapter {
  throw new Error("zcode adapter: not implemented (RED)");
}
