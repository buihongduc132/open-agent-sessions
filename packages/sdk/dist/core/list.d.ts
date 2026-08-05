import { AgentKind } from "../config/types";
import { AdapterRegistry, SessionSummary } from "./types";
/**
 * F4: Clear the list cache.
 * Call this when the session list may have changed (new session created,
 * session deleted, or user requests a refresh).
 */
export declare function clearListCache(): void;
/**
 * Encode a session's position into a cursor string.
 * Uses updated_at_ms timestamp + session_id to form a stable, unique cursor.
 * Cursor is sorted after by updated_at DESC then id ASC — so we encode the
 * last session's (updated_at_ms, id) pair.
 */
export declare function cursorEncode(session: SessionSummary): string;
/**
 * Decode a cursor string back to { updatedAtMs: number; sessionId: string }.
 * Returns null if the cursor is malformed.
 */
export declare function cursorDecode(cursor: string): {
    updatedAtMs: number;
    sessionId: string;
} | null;
export type SessionListQuery = {
    agent?: AgentKind;
    alias?: string;
    q?: string;
    /** Maximum number of sessions to return. When set, triggers cursor pagination. */
    limit?: number;
    /**
     * Cursor from a previous response (`nextCursor`) — positions after the
     * sessions in that page. When set, the result starts from the session
     * immediately after the one referenced by the cursor.
     */
    after?: string;
};
export type SessionListError = {
    agent: AgentKind;
    alias: string;
    message: string;
};
export type SessionListResult = {
    sessions: SessionSummary[];
    errors: SessionListError[];
    /**
     * Opaque cursor for the next page. Present when `hasMore` is true.
     * Pass as `after` in the next request to continue paginating.
     */
    nextCursor?: string | null;
    /**
     * True when there may be more sessions beyond the current page.
     * Computed as: `results.length === limit` at the time of the request.
     */
    hasMore?: boolean;
};
export declare function createListService(registry: AdapterRegistry): (query?: SessionListQuery) => Promise<SessionListResult>;
export declare function listSessions(registry: AdapterRegistry, query?: SessionListQuery): Promise<SessionListResult>;
