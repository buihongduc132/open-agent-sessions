/**
 * Hermes Adapter — R-43, R-44, R-45
 *
 * Reads sessions from ~/.hermes/state.db (SQLite WAL mode, schema v6).
 *
 * Schema:
 *   sessions: id, source, model, title (nullable), parent_session_id,
 *             started_at (unix sec), ended_at, message_count, tool_call_count, tokens...
 *   messages: id, session_id, role (user/assistant/tool), content, tool_calls (JSON),
 *             tool_name, timestamp, reasoning, reasoning_details (JSON)
 *   messages_fts: FTS5 on messages.content
 *
 * @file src/adapters/hermes.ts
 */
import type { Database } from "bun:sqlite";
import { Adapter } from "../core/types";
type HermesAgentEntry = {
    agent: "hermes";
    alias: string;
    enabled: boolean;
};
export type HermesAdapterOptions = {
    /** Path to state.db. Defaults to ~/.hermes/state.db */
    dbPath?: string | Database;
};
export declare function createHermesAdapter(entry: HermesAgentEntry, options?: HermesAdapterOptions): Adapter;
export {};
