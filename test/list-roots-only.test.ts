import { describe, expect, test } from "bun:test";
import { cursorDecode, listSessions, type SessionListQuery } from "../src/core/list";
import { type AdapterRegistry, type SessionSummary } from "../src/core/types";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s1",
    agent: "codex",
    alias: "work",
    title: "Untitled",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 0,
    storage: "other",
    ...overrides,
  };
}

async function runList(
  registry: AdapterRegistry,
  query?: SessionListQuery
): Promise<SessionSummary[]> {
  const result = await listSessions(registry, query);
  return result.sessions;
}

/**
 * Creates a single-adapter registry backed by an in-memory array.
 * Supports both listSessions (non-paginated) and listSessionsByTimeRange (paginated).
 */
function makeRegistry(sessions: SessionSummary[]): AdapterRegistry {
  return {
    adapters: [
      {
        agent: "codex",
        alias: "work",
        version: "1.0.0",
        listSessions: async () => sessions,
        listSessionsByTimeRange: ({ since }) => {
          const filtered = sessions.filter(
            (s) => since === undefined || Date.parse(s.updated_at) >= since
          );
          filtered.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
          return filtered;
        },
      },
    ],
  };
}

// ── Tests (worst-first) ──────────────────────────────────────────────────

describe("roots-only session filtering", () => {
  // ── Zone 3: Multi-component interaction — filter + limit ─────────────
  // This is the most critical test: rootsOnly must apply BEFORE limit.
  // If the implementation applies limit first, it would return 5 sessions
  // (which might include children) instead of only the 2 root sessions.
  test("rootsOnly filter applies BEFORE limit", async () => {
    //#given 2 root sessions + 8 child sessions (10 total), limit=5
    const roots = [
      makeSession({ id: "root-1", updated_at: "2024-03-01T00:00:00Z" }),
      makeSession({ id: "root-2", updated_at: "2024-02-01T00:00:00Z" }),
    ];
    const children = Array.from({ length: 8 }, (_, i) =>
      makeSession({
        id: `child-${i}`,
        updated_at: new Date(Date.UTC(2024, 0, 8 - i)).toISOString(),
        parentSessionId: "root-1",
      })
    );
    const registry = makeRegistry([...roots, ...children]);

    //#when
    const result = await listSessions(registry, { limit: 5 });

    //#then rootsOnly defaults to true → only 2 roots returned, NOT 5
    expect(result.sessions.length).toBe(2);
    expect(result.sessions.map((s) => s.id)).toEqual(["root-1", "root-2"]);
    // No child sessions in result
    expect(result.sessions.every((s) => s.parentSessionId === undefined)).toBe(true);
  });

  // ── Zone 4: Default behavior (undefined rootsOnly) ──────────────────
  // When rootsOnly is not explicitly set, default is true (roots only).
  test("DEFAULT (rootsOnly undefined) returns only roots — excludes children", async () => {
    //#given 2 root sessions + 2 child sessions
    const registry = makeRegistry([
      makeSession({ id: "root-1", updated_at: "2024-03-01T00:00:00Z" }),
      makeSession({ id: "root-2", updated_at: "2024-02-01T00:00:00Z" }),
      makeSession({
        id: "child-1",
        updated_at: "2024-04-01T00:00:00Z",
        parentSessionId: "root-1",
      }),
      makeSession({
        id: "child-2",
        updated_at: "2024-03-15T00:00:00Z",
        parentSessionId: "root-2",
      }),
    ]);

    //#when default query (no rootsOnly specified)
    const sessions = await runList(registry);

    //#then only root sessions returned (sorted by updated_at desc)
    expect(sessions.length).toBe(2);
    expect(sessions.map((s) => s.id)).toEqual(["root-1", "root-2"]);
    expect(sessions.every((s) => s.parentSessionId === undefined)).toBe(true);
  });

  // ── Zone 3: Explicit false overrides the default ────────────────────
  test("rootsOnly: false returns all sessions including children", async () => {
    //#given same 2 roots + 2 children
    const registry = makeRegistry([
      makeSession({ id: "root-1", updated_at: "2024-03-01T00:00:00Z" }),
      makeSession({ id: "root-2", updated_at: "2024-02-01T00:00:00Z" }),
      makeSession({
        id: "child-1",
        updated_at: "2024-04-01T00:00:00Z",
        parentSessionId: "root-1",
      }),
      makeSession({
        id: "child-2",
        updated_at: "2024-03-15T00:00:00Z",
        parentSessionId: "root-2",
      }),
    ]);

    //#when rootsOnly: false
    const sessions = await runList(registry, { rootsOnly: false });

    //#then all 4 sessions returned (sorted by updated_at desc)
    expect(sessions.length).toBe(4);
    expect(sessions.map((s) => s.id)).toEqual(["child-1", "child-2", "root-1", "root-2"]);
  });

  // ── Zone 5: Cursor pagination with roots-only ───────────────────────
  // State mutation across pages: rootsOnly must be consistent across
  // paginated results — each page has only roots, pages don't overlap.
  test("cursor pagination with rootsOnly — pages contain only roots", async () => {
    //#given 20 root + 20 child sessions interleaved by time
    const allSessions: SessionSummary[] = [];
    for (let i = 0; i < 20; i++) {
      // root at day 40-i, child at day 40-i + 0.5
      allSessions.push(
        makeSession({
          id: `root-${i}`,
          updated_at: new Date(Date.UTC(2024, 0, 40 - i)).toISOString(),
        })
      );
      allSessions.push(
        makeSession({
          id: `child-${i}`,
          updated_at: new Date(Date.UTC(2024, 0, 40 - i, 12)).toISOString(),
          parentSessionId: `root-${i}`,
        })
      );
    }
    const registry = makeRegistry(allSessions);

    //#when page through with limit=5
    const page1 = await listSessions(registry, { limit: 5 });

    //#then page1 has 5 roots only, no children
    expect(page1.sessions.every((s) => s.parentSessionId === undefined)).toBe(true);
    expect(page1.sessions.length).toBe(5);
    expect(page1.hasMore).toBe(true);

    // Page 2
    const page2 = await listSessions(registry, {
      limit: 5,
      after: page1.nextCursor!,
    });
    expect(page2.sessions.every((s) => s.parentSessionId === undefined)).toBe(true);
    expect(page2.sessions.length).toBe(5);

    // Pages don't overlap
    const page1Ids = new Set(page1.sessions.map((s) => s.id));
    const page2Ids = page2.sessions.map((s) => s.id);
    expect(page2Ids.every((id) => !page1Ids.has(id))).toBe(true);

    // Page 3
    const page3 = await listSessions(registry, {
      limit: 5,
      after: page2.nextCursor!,
    });
    expect(page3.sessions.every((s) => s.parentSessionId === undefined)).toBe(true);
    expect(page3.sessions.length).toBe(5);

    // Pages 1-2-3 all disjoint
    const page3Ids = page3.sessions.map((s) => s.id);
    expect(page3Ids.every((id) => !page1Ids.has(id))).toBe(true);
    const page2IdSet = new Set(page2Ids);
    expect(page3Ids.every((id) => !page2IdSet.has(id))).toBe(true);
  });

  // ── Zone 3: rootsOnly + agent filter interaction ────────────────────
  test("rootsOnly with agent filter still excludes children", async () => {
    //#given 2 agents, each with a root + child
    const registry: AdapterRegistry = {
      adapters: [
        {
          agent: "codex",
          alias: "work",
          version: "1.0.0",
          listSessions: async () => [
            makeSession({ id: "cx-root", agent: "codex", updated_at: "2024-03-01T00:00:00Z" }),
            makeSession({
              id: "cx-child",
              agent: "codex",
              updated_at: "2024-04-01T00:00:00Z",
              parentSessionId: "cx-root",
            }),
          ],
        },
        {
          agent: "opencode",
          alias: "default",
          version: "1.0.0",
          listSessions: async () => [
            makeSession({
              id: "oc-root",
              agent: "opencode",
              updated_at: "2024-03-01T00:00:00Z",
            }),
            makeSession({
              id: "oc-child",
              agent: "opencode",
              updated_at: "2024-04-01T00:00:00Z",
              parentSessionId: "oc-root",
            }),
          ],
        },
      ],
    };

    //#when agent=codex with default rootsOnly
    const sessions = await runList(registry, { agent: "codex" });

    //#then only the codex root returned, child excluded
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("cx-root");
    expect(sessions[0].parentSessionId).toBeUndefined();
  });

  // ── Zone 1: Session without parentSessionId field ──────────────────
  // A session object that never had parentSessionId set (field absent)
  // must be treated as a root session.
  test("session without parentSessionId field is treated as root", async () => {
    //#given a session with parentSessionId field deleted
    const rootNoField = makeSession({ id: "root-no-field", updated_at: "2024-03-01T00:00:00Z" });
    // Delete the field entirely to simulate a session that never had it
    delete (rootNoField as Partial<SessionSummary>).parentSessionId;

    const child = makeSession({
      id: "child-1",
      updated_at: "2024-04-01T00:00:00Z",
      parentSessionId: "root-no-field",
    });

    const registry = makeRegistry([rootNoField, child]);

    //#when default query (rootsOnly implied true)
    const sessions = await runList(registry);

    //#then session without parentSessionId shows as root, child excluded
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("root-no-field");
  });
});
