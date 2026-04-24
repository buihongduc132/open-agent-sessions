import { describe, expect, test } from "bun:test";
import { searchSessions, searchSessionsWithErrors } from "../src/core/search";
import type { Adapter, AdapterRegistry, SessionSummary } from "../src/core/types";
import type { AgentKind } from "../src/config/types";

function makeStubAdapter(overrides: Partial<Adapter> & { agent: AgentKind; alias: string }): Adapter {
  return {
    version: "1.0.0",
    listSessions: async () => [],
    ...overrides,
  } as Adapter;
}

function makeStubRegistry(adapters: Adapter[]): AdapterRegistry {
  return { adapters };
}

describe("src/core/search.ts coverage", () => {
  test("searchSessions delegates to searchSessionsWithErrors", async () => {
    const session: SessionSummary = {
      id: "s1",
      agent: "opencode",
      alias: "a1",
      title: "Title 1",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T01:00:00Z",
      message_count: 0,
      storage: "db",
    };
    const adapter = makeStubAdapter({
      agent: "opencode",
      alias: "a1",
      searchSessions: async () => [session],
    });
    const registry = makeStubRegistry([adapter]);

    const results = await searchSessions(registry, { text: "Title" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s1");
  });

  test("searchSessionsWithErrors filters by agent", async () => {
    const a1 = makeStubAdapter({
      agent: "opencode",
      alias: "a1",
      searchSessions: async () => [{ id: "s1", agent: "opencode", alias: "a1", title: "T1", created_at: "X", updated_at: "X", message_count: 0, storage: "db" }],
    });
    const a2 = makeStubAdapter({
      agent: "codex",
      alias: "a2",
      searchSessions: async () => [{ id: "s2", agent: "codex", alias: "a2", title: "T2", created_at: "X", updated_at: "X", message_count: 0, storage: "other" }],
    });
    const registry = makeStubRegistry([a1, a2]);

    const result = await searchSessionsWithErrors(registry, { text: "T", agent: "opencode" });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe("s1");
    expect(result.errors).toHaveLength(0);
  });

  test("searchSessionsWithErrors fallback to listSessions and manual filter", async () => {
    const session: SessionSummary = {
      id: "match-me",
      agent: "opencode",
      alias: "a1",
      title: "Find this",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T01:00:00Z",
      message_count: 0,
      storage: "db",
    };
    const adapter = makeStubAdapter({
      agent: "opencode",
      alias: "a1",
      searchSessions: undefined, // No searchSessions support
      listSessions: async () => [session, { ...session, id: "no", title: "no" }],
    });
    const registry = makeStubRegistry([adapter]);

    const result = await searchSessionsWithErrors(registry, { text: "Find" });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe("match-me");
  });

  test("searchSessionsWithErrors handles adapter search errors", async () => {
    const adapter = makeStubAdapter({
      agent: "opencode",
      alias: "fail",
      searchSessions: async () => { throw new Error("Search failed"); },
    });
    const registry = makeStubRegistry([adapter]);

    const result = await searchSessionsWithErrors(registry, { text: "any" });
    expect(result.sessions).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].agent).toBe("opencode");
    expect(result.errors[0].alias).toBe("fail");
    expect(result.errors[0].message).toContain("Search failed");
  });

  test("searchSessionsWithErrors handles adapter list errors in fallback", async () => {
    const adapter = makeStubAdapter({
      agent: "codex",
      alias: "fail-list",
      searchSessions: undefined,
      listSessions: async () => { throw new Error("List failed"); },
    });
    const registry = makeStubRegistry([adapter]);

    const result = await searchSessionsWithErrors(registry, { text: "any" });
    expect(result.sessions).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("List failed");
  });

  test("searchSessionsWithErrors sorts by updated_at desc", async () => {
    const s1: SessionSummary = {
      id: "old",
      agent: "opencode",
      alias: "a1",
      title: "T1",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T01:00:00Z",
      message_count: 0,
      storage: "db",
    };
    const s2: SessionSummary = {
      id: "new",
      agent: "opencode",
      alias: "a1",
      title: "T2",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T02:00:00Z",
      message_count: 0,
      storage: "db",
    };
    const adapter = makeStubAdapter({
      agent: "opencode",
      alias: "a1",
      searchSessions: async () => [s1, s2],
    });
    const registry = makeStubRegistry([adapter]);

    const result = await searchSessionsWithErrors(registry, { text: "T" });
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].id).toBe("new");
    expect(result.sessions[1].id).toBe("old");
  });

  test("searchSessionsWithErrors fallback matches on ID as well as title", async () => {
     const session: SessionSummary = {
      id: "target-id",
      agent: "opencode",
      alias: "a1",
      title: "Something Else",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T01:00:00Z",
      message_count: 0,
      storage: "db",
    };
    const adapter = makeStubAdapter({
      agent: "opencode",
      alias: "a1",
      searchSessions: undefined,
      listSessions: async () => [session],
    });
    const registry = makeStubRegistry([adapter]);

    const result = await searchSessionsWithErrors(registry, { text: "target-id" });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe("target-id");
  });
});
