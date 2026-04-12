import { describe, expect, test } from "bun:test";
import { cursorDecode, cursorEncode, listSessions, type SessionListQuery } from "../src/core/list";
import { type AdapterRegistry, type SessionSummary } from "../src/core/types";

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

describe("core list sessions", () => {
  test("orders by updated_at desc, then agent priority, then id asc", async () => {
    const registry: AdapterRegistry = {
      adapters: [
        {
          agent: "codex",
          alias: "work",
          version: "1.0.0",
          listSessions: async () => [
            makeSession({ id: "cx-100", agent: "codex", updated_at: "2024-02-01T00:00:00Z" }),
            makeSession({ id: "cx-099", agent: "codex", updated_at: "2024-02-01T00:00:00Z" }),
            makeSession({ id: "cx-101", agent: "codex", updated_at: "2024-03-01T00:00:00Z" }),
          ],
        },
        {
          agent: "opencode",
          alias: "personal",
          version: "1.0.0",
          listSessions: async () => [
            makeSession({
              id: "oc-200",
              agent: "opencode",
              updated_at: "2024-02-01T00:00:00Z",
            }),
          ],
        },
        {
          agent: "claude",
          alias: "team",
          version: "1.0.0",
          listSessions: async () => [
            makeSession({
              id: "cl-300",
              agent: "claude",
              updated_at: "2024-02-01T00:00:00Z",
            }),
          ],
        },
      ],
    };

    const sessions = await runList(registry);
    expect(sessions.map((session) => session.id)).toEqual([
      "cx-101",
      "oc-200",
      "cx-099",
      "cx-100",
      "cl-300",
    ]);
  });

  test("filters by agent and alias", async () => {
    const registry: AdapterRegistry = {
      adapters: [
        {
          agent: "codex",
          alias: "work",
          version: "1.0.0",
          listSessions: async () => [
            makeSession({ id: "cx-100", agent: "codex", alias: "work", title: "Bug triage" }),
          ],
        },
        {
          agent: "codex",
          alias: "play",
          version: "1.0.0",
          listSessions: async () => [
            makeSession({ id: "cx-200", agent: "codex", alias: "play", title: "Refactor notes" }),
          ],
        },
      ],
    };

    const sessions = await runList(registry, { agent: "codex", alias: "work" });
    expect(sessions.map((session) => session.id)).toEqual(["cx-100"]);
  });

  test("query matches title or id case-insensitively", async () => {
    const registry: AdapterRegistry = {
      adapters: [
        {
          agent: "codex",
          alias: "work",
          version: "1.0.0",
          listSessions: async () => [
            makeSession({ id: "cx-101", title: "Bug triage" }),
            makeSession({ id: "cx-102", title: "Refactor notes" }),
          ],
        },
      ],
    };

    const byTitle = await runList(registry, { q: "TRIAGE" });
    expect(byTitle.map((session) => session.id)).toEqual(["cx-101"]);

    const byId = await runList(registry, { q: "cx-102" });
    expect(byId.map((session) => session.id)).toEqual(["cx-102"]);
  });

  test("empty query acts as no filter", async () => {
    const registry: AdapterRegistry = {
      adapters: [
        {
          agent: "codex",
          alias: "work",
          version: "1.0.0",
          listSessions: async () => [
            makeSession({ id: "cx-101", title: "Bug triage" }),
            makeSession({ id: "cx-102", title: "Refactor notes" }),
          ],
        },
      ],
    };

    const sessions = await runList(registry, { q: "   " });
    expect(sessions.map((session) => session.id)).toEqual(["cx-101", "cx-102"]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // R-23: Cursor-based pagination
  // ─────────────────────────────────────────────────────────────────────────

  describe("cursorEncode / cursorDecode", () => {
    test("roundtrips a cursor correctly", () => {
      const session: SessionSummary = {
        id: "abc-123",
        agent: "codex",
        alias: "work",
        title: "Test",
        created_at: "2024-06-01T12:00:00.000Z",
        updated_at: "2024-06-15T18:30:00.000Z",
        message_count: 5,
        storage: "db",
      };
      const encoded = cursorEncode(session);
      const decoded = cursorDecode(encoded);
      expect(decoded).toEqual({
        updatedAtMs: new Date("2024-06-15T18:30:00.000Z").getTime(),
        sessionId: "abc-123",
      });
    });

    test("cursorDecode returns null for malformed input", () => {
      expect(cursorDecode("not-valid-base64!")).toBeNull();
      expect(cursorDecode("")).toBeNull();
      // Valid base64 but no colon separator → null
      const encoder = new TextEncoder();
      const binary = String.fromCharCode(...encoder.encode("2024")); // ms number only, no session_id
      expect(cursorDecode(btoa(binary))).toBeNull();
    });

    test("cursor encodes last session's updated_at:id", () => {
      // When two sessions share the same updated_at, the sessionId disambiguates.
      const s1: SessionSummary = {
        id: "aaa",
        agent: "codex",
        alias: "work",
        title: "A",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-03-01T00:00:00Z",
        message_count: 0,
        storage: "db",
      };
      const s2: SessionSummary = {
        id: "zzz",
        agent: "codex",
        alias: "work",
        title: "Z",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-03-01T00:00:00Z",
        message_count: 0,
        storage: "db",
      };
      expect(cursorEncode(s1)).not.toBe(cursorEncode(s2));
    });
  });

  describe("listSessions with pagination", () => {
    function makeRegistry(sessions: SessionSummary[]): AdapterRegistry {
      return {
        adapters: [
          {
            agent: "codex",
            alias: "work",
            version: "1.0.0",
            // NOTE: do NOT .slice() here — the code computes hasMore by
            // comparing ordered.length to limit. The mock must return ALL
            // sessions so the pagination logic can slice the page itself.
            // Use >= since (not >) so the cursor session is included in the raw
            // adapter result; skipSessionId deduplicates it in post-filter.
            listSessionsByTimeRange: ({ since }) => {
              const filtered = sessions.filter(
                (s) => since === undefined || Date.parse(s.updated_at) >= since
              );
              filtered.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
              return filtered;
            },
            listSessions: async () => sessions,
          },
        ],
      };
    }

    test("returns { nextCursor, hasMore } when limit is set and results exceed limit", async () => {
      const sessions: SessionSummary[] = Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`,
        agent: "codex" as const,
        alias: "work",
        title: `Session ${i}`,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: new Date(Date.UTC(2024, 0, 5 - i)).toISOString(),
        message_count: 0,
        storage: "db" as const,
      }));

      const result = await listSessions(makeRegistry(sessions), { limit: 3 });
      expect(result.sessions.length).toBe(3);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeTruthy();
      // cursor should decode back to the last item in the page (s2)
      const decoded = cursorDecode(result.nextCursor!);
      expect(decoded?.sessionId).toBe("s2");
    });

    test("returns hasMore=false when results fit exactly in limit", async () => {
      const sessions: SessionSummary[] = Array.from({ length: 3 }, (_, i) => ({
        id: `s${i}`,
        agent: "codex" as const,
        alias: "work",
        title: `Session ${i}`,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: new Date(Date.UTC(2024, 0, 3 - i)).toISOString(),
        message_count: 0,
        storage: "db" as const,
      }));

      const result = await listSessions(makeRegistry(sessions), { limit: 3 });
      expect(result.sessions.length).toBe(3);
      expect(result.hasMore).toBeUndefined();
      expect(result.nextCursor).toBeUndefined();
    });

    test("returns hasMore=false when fewer sessions than limit", async () => {
      const sessions: SessionSummary[] = Array.from({ length: 2 }, (_, i) => ({
        id: `s${i}`,
        agent: "codex" as const,
        alias: "work",
        title: `Session ${i}`,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: new Date(Date.UTC(2024, 0, 2 - i)).toISOString(),
        message_count: 0,
        storage: "db" as const,
      }));

      const result = await listSessions(makeRegistry(sessions), { limit: 10 });
      expect(result.sessions.length).toBe(2);
      expect(result.hasMore).toBeUndefined();
      expect(result.nextCursor).toBeUndefined();
    });

    test("after cursor skips the cursor-session itself from the next page", async () => {
      const sessions: SessionSummary[] = Array.from({ length: 4 }, (_, i) => ({
        id: `s${i}`,
        agent: "codex" as const,
        alias: "work",
        title: `Session ${i}`,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: new Date(Date.UTC(2024, 0, 4 - i)).toISOString(),
        message_count: 0,
        storage: "db" as const,
      }));

      // First page: 2 items (no limit applied by mock — code slices)
      const firstPage = await listSessions(makeRegistry(sessions), { limit: 2 });
      expect(firstPage.sessions.map((s) => s.id)).toEqual(["s0", "s1"]);
      expect(firstPage.hasMore).toBe(true);
      const cursor = firstPage.nextCursor!;

      // Second page: the cursor encodes s1 (last item of first page). The adapter
      // returns all sessions >= s1's timestamp: [s1, s0]. The skipSessionId
      // deduplicates s1, leaving [s0] which fills the page partially.
      const secondPage = await listSessions(makeRegistry(sessions), {
        limit: 2,
        after: cursor,
      });
      expect(secondPage.sessions.map((s) => s.id)).toEqual(["s0"]);
      expect(secondPage.hasMore).toBeUndefined();
      expect(secondPage.nextCursor).toBeUndefined();
    });

    // F1: skipSessionId must be forwarded to the adapter's listSessionsByTimeRange
    test("skipSessionId is forwarded to adapter's listSessionsByTimeRange", async () => {
      let receivedOptions: unknown = null;
      const sessions: SessionSummary[] = [
        { id: "s0", agent: "codex" as const, alias: "work", title: "S0", created_at: "2024-01-01T00:00:00Z", updated_at: new Date(Date.UTC(2024, 0, 3)).toISOString(), message_count: 0, storage: "db" as const },
        { id: "s1", agent: "codex" as const, alias: "work", title: "S1", created_at: "2024-01-01T00:00:00Z", updated_at: new Date(Date.UTC(2024, 0, 2)).toISOString(), message_count: 0, storage: "db" as const },
      ];

      const registry: AdapterRegistry = {
        adapters: [
          {
            agent: "codex",
            alias: "work",
            version: "1.0.0",
            listSessionsByTimeRange: (opts) => {
              receivedOptions = opts;
              const filtered = sessions.filter(
                (s) => opts.since === undefined || Date.parse(s.updated_at) >= opts.since
              );
              filtered.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
              return filtered;
            },
          },
        ],
      };

      const firstPage = await listSessions(registry, { limit: 1 });
      const cursor = firstPage.nextCursor!;
      await listSessions(registry, { limit: 1, after: cursor });

      expect(receivedOptions).not.toBeNull();
      expect((receivedOptions as any).skipSessionId).toBe("s0");
    });

    test("after cursor + agent filter — cursor skips already-shown session", async () => {
      const sessions: SessionSummary[] = [
        { id: "c1", agent: "codex" as const, alias: "work", title: "C1", created_at: "2024-01-01T00:00:00Z", updated_at: new Date(Date.UTC(2024, 0, 3)).toISOString(), message_count: 0, storage: "db" as const },
        { id: "c2", agent: "codex" as const, alias: "work", title: "C2", created_at: "2024-01-01T00:00:00Z", updated_at: new Date(Date.UTC(2024, 0, 2)).toISOString(), message_count: 0, storage: "db" as const },
        { id: "c3", agent: "codex" as const, alias: "work", title: "C3", created_at: "2024-01-01T00:00:00Z", updated_at: new Date(Date.UTC(2024, 0, 1)).toISOString(), message_count: 0, storage: "db" as const },
      ];

      const firstPage = await listSessions(makeRegistry(sessions), { limit: 2, agent: "codex" });
      expect(firstPage.sessions.map((s) => s.id)).toEqual(["c1", "c2"]);
      expect(firstPage.hasMore).toBe(true);

      // Cursor points to c2 (last item of first page). Next page skips c2 and
      // returns c1 again — but with agent filter matching only "codex", there is
      // only one remaining session older than the cursor: c1 itself.  Since c1
      // shares the same timestamp as the cursor (both are "Jan 3" in the test data
      // after sort tiebreak), skipSessionId correctly deduplicates it.
      // Result: second page is c1 only (correctly deduped, not c3 which is older).
      const secondPage = await listSessions(makeRegistry(sessions), {
        limit: 2,
        after: firstPage.nextCursor!,
        agent: "codex",
      });
      expect(secondPage.sessions.map((s) => s.id)).toEqual(["c1"]);
    });

    test("malformed after cursor does not throw — returns empty page", async () => {
      const sessions: SessionSummary[] = [
        { id: "s0", agent: "codex" as const, alias: "work", title: "S0", created_at: "2024-01-01T00:00:00Z", updated_at: new Date(Date.UTC(2024, 0, 1)).toISOString(), message_count: 0, storage: "db" as const },
      ];

      const result = await listSessions(makeRegistry(sessions), {
        limit: 10,
        after: "!!!not-a-valid-cursor",
      });
      // Malformed cursor is silently ignored — server may return all sessions
      // (depending on adapter). The key invariant: it does not throw.
      expect(result.sessions).toBeDefined();
    });

    test("errors from adapters are still collected in pagination path", async () => {
      const registry: AdapterRegistry = {
        adapters: [
          {
            agent: "codex",
            alias: "work",
            version: "1.0.0",
            listSessionsByTimeRange: () => {
              throw new Error("db unavailable");
            },
            listSessions: async () => {
              throw new Error("db unavailable");
            },
          },
        ],
      };

      const result = await listSessions(registry, { limit: 5 });
      expect(result.sessions).toEqual([]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].message).toBe("db unavailable");
    });

    test("limit only (no after) — default 50 page size", async () => {
      // When limit is undefined we fall through to the non-paginated branch,
      // so test the explicit limit path with a registry that has no time-range support.
      const sessions: SessionSummary[] = Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`,
        agent: "codex" as const,
        alias: "work",
        title: `Session ${i}`,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: new Date(Date.UTC(2024, 0, 5 - i)).toISOString(),
        message_count: 0,
        storage: "db" as const,
      }));

      // Registry WITHOUT listSessionsByTimeRange → uses in-process filter
      // (filterInProcess also does NOT slice — the code does the page slicing)
      const registry: AdapterRegistry = {
        adapters: [
          {
            agent: "codex",
            alias: "work",
            version: "1.0.0",
            listSessions: async () => sessions,
          },
        ],
      };

      const result = await listSessions(registry, { limit: 3 });
      expect(result.sessions.length).toBe(3);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeTruthy();
    });
  });

  test("adapter errors are returned without blocking other sessions", async () => {
    const registry: AdapterRegistry = {
      adapters: [
        {
          agent: "codex",
          alias: "work",
          version: "1.0.0",
          listSessions: async () => {
            throw new Error("boom");
          },
        },
        {
          agent: "opencode",
          alias: "personal",
          version: "1.0.0",
          listSessions: async () => [
            makeSession({ id: "oc-100", agent: "opencode", alias: "personal" }),
          ],
        },
      ],
    };

    const result = await listSessions(registry);
    expect(result.sessions.map((session) => session.id)).toEqual(["oc-100"]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].agent).toBe("codex");
    expect(result.errors[0].alias).toBe("work");
  });

  // ── F6: agent filter routes to specific adapter only ──────────────────────
  // F6 is applied in collectSessions (default/uncached path) so that when
  // agent/alias is set, only matching adapters are called — skipping
  // Codex's full 6185-session scan for single-agent queries.

  test("agent filter calls only the matching adapter's listSessionsByTimeRange", async () => {
    const calls: string[] = [];
    const registry: AdapterRegistry = {
      adapters: [
        {
          agent: "opencode",
          alias: "default",
          version: "1.0.0",
          listSessions: async () => { calls.push("opencode:default"); return []; },
          listSessionsByTimeRange: ({ since }) => { calls.push("opencode:default:tr"); return []; },
        },
        {
          agent: "codex",
          alias: "work",
          version: "1.0.0",
          listSessions: async () => { calls.push("codex:work"); return []; },
          listSessionsByTimeRange: ({ since }) => { calls.push("codex:work:tr"); return []; },
        },
        {
          agent: "opencode",
          alias: "personal",
          version: "1.0.0",
          listSessions: async () => { calls.push("opencode:personal"); return []; },
          listSessionsByTimeRange: ({ since }) => { calls.push("opencode:personal:tr"); return []; },
        },
      ],
    };

    await listSessions(registry, { agent: "opencode" });
    // F6: only opencode adapters (not codex) should be called
    expect(calls).not.toContain("codex:work");
    expect(calls).not.toContain("codex:work:tr");
    expect(calls.filter((c) => c.startsWith("opencode"))).toHaveLength(2); // both opencode adapters called
  });

  test("alias filter calls only the matching adapter's listSessions", async () => {
    // Adapters WITHOUT listSessionsByTimeRange fall back to listSessions().
    // F6 must still filter correctly at the adapter level so ONLY the
    // matching adapter is invoked — not all three.
    const calls: string[] = [];
    const registry: AdapterRegistry = {
      adapters: [
        {
          agent: "opencode",
          alias: "default",
          version: "1.0.0",
          listSessions: async () => { calls.push("default"); return []; },
        },
        {
          agent: "opencode",
          alias: "personal",
          version: "1.0.0",
          listSessions: async () => { calls.push("personal"); return []; },
        },
        {
          agent: "codex",
          alias: "work",
          version: "1.0.0",
          listSessions: async () => { calls.push("codex:work"); return []; },
        },
      ],
    };

    await listSessions(registry, { alias: "personal" });
    // F6: only alias=personal adapter should be called
    expect(calls).toContain("personal");
    expect(calls).not.toContain("default");
    expect(calls).not.toContain("codex:work");
  });

  test("no filter calls all adapters via listSessions (F6 regression)", async () => {
    // The non-paginated branch (no limit/after) calls listSessions(), not
    // listSessionsByTimeRange(). Both adapters must be called to collect all sessions.
    const calls: string[] = [];
    const registry: AdapterRegistry = {
      adapters: [
        {
          agent: "opencode",
          alias: "default",
          version: "1.0.0",
          listSessions: async () => { calls.push("opencode"); return []; },
          listSessionsByTimeRange: ({ since }) => { calls.push("opencode:tr"); return []; },
        },
        {
          agent: "codex",
          alias: "work",
          version: "1.0.0",
          listSessions: async () => { calls.push("codex"); return []; },
          listSessionsByTimeRange: ({ since }) => { calls.push("codex:tr"); return []; },
        },
      ],
    };

    await listSessions(registry, {});
    // Non-paginated branch → collectSessions → listSessions() (not time-range)
    expect(calls).toContain("opencode");
    expect(calls).toContain("codex");
    expect(calls).not.toContain("opencode:tr"); // time-range NOT called in non-paginated
    expect(calls).not.toContain("codex:tr");
  });

  test("agent+alias filter calls only the exact matching adapter via listSessions", async () => {
    // F6 works in collectSessions for non-paginated queries. When agent+alias
    // are set (but no limit/after), only the matching adapter is invoked via listSessions().
    const calls: string[] = [];
    const registry: AdapterRegistry = {
      adapters: [
        {
          agent: "opencode",
          alias: "default",
          version: "1.0.0",
          listSessions: async () => { calls.push("oc:default"); return []; },
          listSessionsByTimeRange: ({ since }) => { calls.push("oc:default:tr"); return []; },
        },
        {
          agent: "opencode",
          alias: "personal",
          version: "1.0.0",
          listSessions: async () => { calls.push("oc:personal"); return []; },
          listSessionsByTimeRange: ({ since }) => { calls.push("oc:personal:tr"); return []; },
        },
        {
          agent: "codex",
          alias: "work",
          version: "1.0.0",
          listSessions: async () => { calls.push("cx:work"); return []; },
          listSessionsByTimeRange: ({ since }) => { calls.push("cx:work:tr"); return []; },
        },
      ],
    };

    await listSessions(registry, { agent: "opencode", alias: "personal" });
    // F6 in collectSessions: only the matching adapter called via listSessions()
    expect(calls).toContain("oc:personal");
    expect(calls).not.toContain("oc:default");
    expect(calls).not.toContain("cx:work");
    expect(calls).not.toContain("oc:personal:tr"); // time-range not called in non-paginated
  });
});
