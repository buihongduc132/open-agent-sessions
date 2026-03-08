import { describe, expect, test } from "bun:test";
import { listSessions, type SessionListQuery } from "../src/core/list";
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
});
