/**
 * ZCode Adapter — GREEN PHASE
 *
 * Reads sessions from ~/.zcode/cli/db/db.sqlite (SQLite).
 *
 * Schema (VERIFIED against live DB):
 *   session(id, project_id, parent_id, slug, directory, title, version,
 *           time_created ms, time_updated ms, task_type, title_source)
 *   message(id, session_id, time_created, time_updated, data JSON, sequence)
 *     - role lives inside data.role (NO role column): user | assistant | system
 *     - data.time.created is the ms-epoch message creation time
 *     - data.model?.modelID carries the model id (optional)
 *   part(id, message_id, session_id, time_created, time_updated, data JSON, sequence)
 *     - type lives inside data.type (NO type column): text | tool | reasoning
 *       text     → { type:"text",     text }
 *       tool     → { type:"tool",     tool, state }
 *       reasoning→ { type:"reasoning",text }
 *   tool_usage(id, session_id, tool_call_id, tool_name, status,
 *              started_at, completed_at, duration_ms)
 *   All times are ms-epoch integers (NOT seconds — do NOT divide by 1000).
 *
 * @file src/adapters/zcode.ts
 */
import type { Database } from "bun:sqlite";
import { Adapter } from "../core/types";
type ZcodeAgentEntry = {
    agent: "zcode";
    alias: string;
    enabled: boolean;
};
export type ZcodeAdapterOptions = {
    /** Path to db.sqlite. Defaults to ~/.zcode/cli/db/db.sqlite */
    dbPath?: string | Database;
};
export declare function createZcodeAdapter(entry: ZcodeAgentEntry, options?: ZcodeAdapterOptions): Adapter;
export {};
