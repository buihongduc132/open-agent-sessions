import { AgentKind } from "../config/types";
import { AdapterRegistry, SessionSummary } from "./types";
import { errorMessage } from "./utils";
import QuickLRU from "quick-lru";
import { AGENT_ORDER } from "./constants";



// F4: In-memory LRU cache for session list results.
// Key = serialized filter dimensions (agent + alias + q).
// Bounded at 20 entries — one per unique query profile.
// TTL: 30 seconds (handled by maxAge in QuickLRU via periodic eviction).
// Invalidated when forkSession creates a new session via clearListCache().
const listCache = new QuickLRU<string, SessionListResult>({ maxSize: 20, maxAge: 30_000 });

// Cache key — only dimensions that affect the result set.
// limit and after are NOT included (they control pagination, not the base set).
// Use explicit strings so that e.g. { agent: "codex" } produces a different key
// than {} (undefined values become "" rather than being omitted, avoiding collisions
// where JSON.stringify({ agent: undefined }) === JSON.stringify({})).
function listCacheKey(query: SessionListQuery): string {
  return JSON.stringify({
    agent: query.agent ?? "",
    alias: query.alias ?? "",
    q: query.q ?? "",
  });
}

/**
 * F4: Clear the list cache.
 * Call this when the session list may have changed (new session created,
 * session deleted, or user requests a refresh).
 */
export function clearListCache(): void {
  listCache.clear();
}

// ---------------------------------------------------------------------------
// Cursor encoding / decoding
// Format: base64(updated_at_ms:session_id)  using btoa/atob + TextEncoder
//
// updated_at is stored as a numeric ms timestamp (no colons, no ambiguity).
// ---------------------------------------------------------------------------

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

/**
 * Encode a session's position into a cursor string.
 * Uses updated_at_ms timestamp + session_id to form a stable, unique cursor.
 * Cursor is sorted after by updated_at DESC then id ASC — so we encode the
 * last session's (updated_at_ms, id) pair.
 */
export function cursorEncode(session: SessionSummary): string {
  const updatedAtMs = Date.parse(session.updated_at);
  const payload = `${updatedAtMs}:${session.id}`;
  const bytes = _encoder.encode(payload);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary);
}

/**
 * Decode a cursor string back to { updatedAtMs: number; sessionId: string }.
 * Returns null if the cursor is malformed.
 */
export function cursorDecode(cursor: string): { updatedAtMs: number; sessionId: string } | null {
  try {
    const binary = atob(cursor);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const decoded = _decoder.decode(bytes);
    const colonIdx = decoded.indexOf(":");
    if (colonIdx < 0) return null;
    const updatedAtMs = parseInt(decoded.slice(0, colonIdx), 10);
    const sessionId = decoded.slice(colonIdx + 1);
    if (isNaN(updatedAtMs) || !sessionId) return null;
    return { updatedAtMs, sessionId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export function createListService(
  registry: AdapterRegistry
): (query?: SessionListQuery) => Promise<SessionListResult> {
  // F4: Wrap with cache keyed on filter dimensions (agent + alias + q).
  // Only cache unfiltered queries (no filter = full combined set that never changes
  // for a given registry state). Filtered queries require fresh collection + filter
  // because the cached result would be wrong for a different filter.
  return async (query?: SessionListQuery) => {
    const effectiveQuery = query ?? {};
    const key = listCacheKey(effectiveQuery);

    // Only serve from cache for unfiltered queries (agent/alias/q all undefined).
    // Any filter changes the result so caching would be incorrect.
    const hasFilter =
      effectiveQuery.agent !== undefined ||
      effectiveQuery.alias !== undefined ||
      (effectiveQuery.q !== undefined && effectiveQuery.q.trim().length > 0);

    if (!hasFilter && listCache.has(key)) {
      return listCache.get(key)!;
    }

    const result = await listSessions(registry, effectiveQuery);

    if (!hasFilter) {
      listCache.set(key, result);
    }
    return result;
  };
}

export async function listSessions(
  registry: AdapterRegistry,
  query: SessionListQuery = {}
): Promise<SessionListResult> {
  // ── Cursor-pagination branch ──────────────────────────────────────────────
  // Route to listSessionsByTimeRange when either limit or after is requested.
  // The after cursor positions after a specific session; limit controls page size.
  if (query.limit !== undefined || query.after !== undefined) {
    return listSessionsPaginated(registry, query);
  }

  // ── Default branch (no pagination) ──────────────────────────────────────
  const { sessions, errors } = await collectSessions(registry, query);
  const filtered = applyFilters(sessions, query);
  const ordered = filtered.slice().sort(compareSessions);
  return { sessions: ordered, errors };
}

// ---------------------------------------------------------------------------
// Cursor-paginated path
// ---------------------------------------------------------------------------

async function listSessionsPaginated(
  registry: AdapterRegistry,
  query: SessionListQuery
): Promise<SessionListResult> {
  const limit = query.limit ?? 50;

  // Decode the cursor to extract a `since` timestamp and optional sessionId.
  // If `after` is provided, we pass the decoded timestamp as the `since` lower
  // bound so the adapter returns only sessions that are newer than the cursor.
  let since: number | undefined;
  let skipSessionId: string | undefined;
  if (query.after !== undefined) {
    const decoded = cursorDecode(query.after);
    if (decoded) {
      since = decoded.updatedAtMs;
      skipSessionId = decoded.sessionId;
    }
    // If the cursor is malformed we intentionally ignore it rather than error,
    // so a corrupted bookmark still yields a graceful empty result.
  }

  const sessions: SessionSummary[] = [];
  const errors: SessionListError[] = [];

  // F6: When agent or alias filter is set, call only matching adapters.
  // This avoids triggering Codex's fallback full-scan for single-agent queries.
  const targetAdapters =
    query.agent !== undefined || query.alias !== undefined
      ? registry.adapters.filter(
          (a) =>
            (query.agent === undefined || a.agent === query.agent) &&
            (query.alias === undefined || a.alias === query.alias)
        )
      : registry.adapters;

  // Call adapters sequentially so we can catch individual adapter errors and
  // still process successful results from other adapters.
  for (const adapter of targetAdapters) {
    try {
      if (adapter.listSessionsByTimeRange) {
        const result = adapter.listSessionsByTimeRange({ since, limit, skipSessionId });
        sessions.push(...result);
      } else {
        const result = await adapter.listSessions();
        sessions.push(...filterInProcess(result, since, limit));
      }
    } catch (error) {
      errors.push({
        agent: adapter.agent,
        alias: adapter.alias,
        message: errorMessage(error),
      });
    }
  }

  // Merge results from all adapters, apply filters, and skip the cursor session.
  // The skip (via skipSessionId) is applied AFTER filters so cursor-skipping
  // doesn't interfere with cross-adapter ordering or agent filters.
  let ordered = applyFilters(sessions, query);
  if (skipSessionId !== undefined) {
    ordered = ordered.filter((s) => s.id !== skipSessionId);
  }
  ordered = ordered.slice().sort(compareSessions);

  // hasMore: true when there is at least one more item beyond the page.
  // Computed AFTER filtering so that e.g. agent-filtered results correctly
  // indicate whether more pages remain in that filtered view.
  const hasMore = ordered.length > limit;
  const page = ordered.slice(0, limit);
  const nextCursor =
    hasMore && page.length > 0 ? cursorEncode(page[page.length - 1]) : undefined;

  return { sessions: page, errors, nextCursor, hasMore: hasMore || undefined };
}

/**
 * In-process fallback for adapters that don't implement listSessionsByTimeRange.
 * Returns ALL sessions newer than or equal to `since` (no limit applied here —
 * the caller computes hasMore from the full filtered set and slices the page).
 */
function filterInProcess(
  sessions: SessionSummary[],
  since: number | undefined,
  _limit: number
): SessionSummary[] {
  return sessions
    .filter((s) => since === undefined || Date.parse(s.updated_at) >= since)
    .sort(compareSessions);
}

// ---------------------------------------------------------------------------
// Default (non-paginated) helpers
// ---------------------------------------------------------------------------

function applyFilters(
  sessions: SessionSummary[],
  query: SessionListQuery
): SessionSummary[] {
  const agent = query.agent;
  const alias = query.alias;
  const normalizedQuery = query.q?.trim().toLowerCase();
  const hasQuery = Boolean(normalizedQuery);

  return sessions.filter((session) => {
    if (agent && session.agent !== agent) return false;
    if (alias && session.alias !== alias) return false;
    if (!hasQuery) return true;
    const needle = normalizedQuery as string;
    return (
      session.id.toLowerCase().includes(needle) ||
      session.title.toLowerCase().includes(needle) ||
      session.agent.toLowerCase().includes(needle) ||
      session.alias.toLowerCase().includes(needle)
    );
  });
}

function compareSessions(a: SessionSummary, b: SessionSummary): number {
  const timeA = Date.parse(a.updated_at);
  const timeB = Date.parse(b.updated_at);
  if (timeA !== timeB) {
    return timeB - timeA;
  }

  const agentDelta = AGENT_ORDER[a.agent] - AGENT_ORDER[b.agent];
  if (agentDelta !== 0) return agentDelta;

  return a.id.localeCompare(b.id);
}

async function collectSessions(
  registry: AdapterRegistry,
  query: SessionListQuery = {}
): Promise<{ sessions: SessionSummary[]; errors: SessionListError[] }> {
  // F6: when agent or alias filter is set, call only matching adapters.
  const targetAdapters =
    query.agent !== undefined || query.alias !== undefined
      ? registry.adapters.filter(
          (a) =>
            (query.agent === undefined || a.agent === query.agent) &&
            (query.alias === undefined || a.alias === query.alias)
        )
      : registry.adapters;

  const results = await Promise.all(
    targetAdapters.map(async (adapter) => {
      try {
        const sessions = await adapter.listSessions();
        return { adapter, sessions };
      } catch (error) {
        return { adapter, error };
      }
    })
  );

  const sessions: SessionSummary[] = [];
  const errors: SessionListError[] = [];

  for (const result of results) {
    if ("error" in result) {
      errors.push({
        agent: result.adapter.agent,
        alias: result.adapter.alias,
        message: errorMessage(result.error),
      });
      continue;
    }
    sessions.push(...result.sessions);
  }

  return { sessions, errors };
}
