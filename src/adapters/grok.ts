/**
 * Grok Adapter — STUB (RED PHASE)
 *
 * Reads Grok CLI sessions from ~/.grok/sessions (JSONL + summary.json).
 * GROK_HOME overrides ~/.grok; tests inject sessionsDir / homeDir instead.
 *
 * This file is intentionally NOT implemented. It exists only so tests in
 * test/adapters/grok.test.ts can compile and then FAIL — the RED phase of TDD.
 * The GREEN-phase agent will replace this stub with real logic.
 *
 * Live layout (VERIFIED against grok-build docs + ~/.grok/sessions):
 *
 *   <sessionsRoot>/<url-encoded-cwd>/<session-uuid>/
 *     summary.json         metadata
 *     chat_history.jsonl   raw model messages (adapter source for SessionMessage[])
 *     updates.jsonl        ACP stream (authoritative for resume; optional here)
 *
 *   Encoded cwd >255 bytes uses slug+hash + a `.cwd` file.
 *   Session IDs are UUIDv7. Subagent children are sibling UUID dirs (not nested).
 *   Cwd-level files (prompt_history.jsonl, locks) are NOT sessions.
 *   Directories without summary.json are NOT sessions.
 *
 * summary.json:
 *   info.id / info.cwd, session_summary, created_at, updated_at (may include
 *   nanosecond fractional seconds), num_messages, num_chat_messages,
 *   current_model_id, generated_title, parent_session_id?
 *   Title = generated_title if non-empty, else session_summary, else id.
 *
 * chat_history.jsonl record types:
 *   { type: "system", content: string }
 *   { type: "user", content: [{ type: "text", text }] | string }
 *   { type: "reasoning", id, summary: [{ type: "summary_text", text }], status }
 *   { type: "assistant", content: string, tool_calls?: [{ id, name, arguments }], model_id? }
 *   { type: "tool_result", tool_call_id, content: string }
 *
 * Factory:
 *   createGrokAdapter(entry, options?: { sessionsDir?, homeDir? })
 *   Default root: join(homeDir ?? homedir(), ".grok", "sessions")
 *   Override: entry.path (string) or options.sessionsDir
 *   Construction errors (missing path, path is a file) MUST be deferred to
 *   query time via createBrokenAdapter (OT4).
 *
 * @file src/adapters/grok.ts
 */

import type { Adapter } from "../core/types";
import type { OtherAgentEntry } from "../config/types";

/** Options for the grok adapter. sessionsDir overrides the default ~/.grok/sessions root. */
export type GrokAdapterOptions = {
  /** Sessions root (encoded-cwd groups). Defaults to ~/.grok/sessions */
  sessionsDir?: string;
  /** Home directory used when resolving the default ~/.grok/sessions path */
  homeDir?: string;
};

type GrokAgentEntry = Extract<OtherAgentEntry, { agent: "grok" }>;

/**
 * STUB factory. Throws so RED-phase tests fail in a predictable way.
 * GREEN phase will implement: OT4 deferred path errors, encoded-cwd walk,
 * summary.json + chat_history.jsonl mapping, SessionReadOptions, search,
 * tool search, and a stub forkSession.
 */
export function createGrokAdapter(
  _entry: GrokAgentEntry,
  _options: GrokAdapterOptions = {}
): Adapter {
  throw new Error("grok adapter: not implemented (RED)");
}
