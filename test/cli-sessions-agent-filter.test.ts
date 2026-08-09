import { describe, expect, test } from "bun:test";
import { runSessionsCommand, type SessionsService, type SessionsQuery } from "../src/cli/sessions";
import { type Config } from "../src/config/types";
import { type SessionSummary } from "../src/core/types";

// ============================================================================
// Test Fixtures
// ============================================================================

const baseConfig: Config = {
  agents: [
    { agent: "pi", alias: "omo", enabled: true },
    { agent: "zcode", alias: "work", enabled: true },
    { agent: "codex", alias: "side", enabled: true },
  ],
};

// Mock service that mimics createSessionsService: returns all sessions,
// then post-filters by agent/alias (as the real service will do after fix).
function makeFilteringService(allSessions: SessionSummary[]): SessionsService {
  return async (query: SessionsQuery) => {
    let results = allSessions;
    if (query.agent !== undefined) {
      results = results.filter((s) => s.agent === query.agent);
    }
    if (query.alias !== undefined) {
      results = results.filter((s) => s.alias === query.alias);
    }
    return { sessions: results, errors: [] };
  };
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-001",
    agent: "pi",
    alias: "omo",
    title: "Test Session",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 5,
    storage: "db",
    ...overrides,
  };
}

const allSessions: SessionSummary[] = [
  makeSession({ id: "pi-1", agent: "pi", alias: "omo", title: "Pi OMO Session" }),
  makeSession({ id: "pi-2", agent: "pi", alias: "pi", title: "Pi Pi Session" }),
  makeSession({ id: "zc-1", agent: "zcode", alias: "work", title: "Zcode Work Session" }),
  makeSession({ id: "cx-1", agent: "codex", alias: "side", title: "Codex Side Session" }),
];

// ============================================================================
// Tests — RED phase. These will fail against current code because
// runSessionsCommand drops --agent/--alias (SessionsQuery lacks fields).
// ============================================================================

describe("cli sessions --agent/--alias filter", () => {
  test("--agent pi returns ONLY pi sessions (no zcode/codex)", async () => {
    const result = await runSessionsCommand({
      agent: "pi",
      last: "8h",
      config: baseConfig,
      getSessions: makeFilteringService(allSessions),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi-1");
    expect(result.stdout).toContain("pi-2");
    expect(result.stdout).not.toContain("zc-1");
    expect(result.stdout).not.toContain("cx-1");
  });

  test("--agent zcode returns ONLY zcode sessions", async () => {
    const result = await runSessionsCommand({
      agent: "zcode",
      last: "8h",
      config: baseConfig,
      getSessions: makeFilteringService(allSessions),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("zc-1");
    expect(result.stdout).not.toContain("pi-1");
    expect(result.stdout).not.toContain("pi-2");
    expect(result.stdout).not.toContain("cx-1");
  });

  test("--alias omo filters by alias (returns pi-omo only)", async () => {
    const result = await runSessionsCommand({
      alias: "omo",
      last: "8h",
      config: baseConfig,
      getSessions: makeFilteringService(allSessions),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi-1");
    expect(result.stdout).not.toContain("pi-2");
    expect(result.stdout).not.toContain("zc-1");
    expect(result.stdout).not.toContain("cx-1");
  });

  test("--agent pi --alias omo combines both filters", async () => {
    const result = await runSessionsCommand({
      agent: "pi",
      alias: "omo",
      last: "8h",
      config: baseConfig,
      getSessions: makeFilteringService(allSessions),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi-1");
    expect(result.stdout).not.toContain("pi-2");
    expect(result.stdout).not.toContain("zc-1");
    expect(result.stdout).not.toContain("cx-1");
  });

  test("no filter returns sessions from all agents (regression)", async () => {
    const result = await runSessionsCommand({
      last: "8h",
      config: baseConfig,
      getSessions: makeFilteringService(allSessions),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi-1");
    expect(result.stdout).toContain("pi-2");
    expect(result.stdout).toContain("zc-1");
    expect(result.stdout).toContain("cx-1");
  });

  test("invalid --agent returns error", async () => {
    const result = await runSessionsCommand({
      agent: "nonexistent",
      last: "8h",
      config: baseConfig,
      getSessions: makeFilteringService(allSessions),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("unknown agent");
  });

  test("agent/alias passed to service query", async () => {
    let receivedQuery: SessionsQuery | undefined;

    const result = await runSessionsCommand({
      agent: "pi",
      alias: "omo",
      last: "8h",
      config: baseConfig,
      getSessions: async (query) => {
        receivedQuery = query;
        return makeFilteringService(allSessions)(query);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(receivedQuery).toBeDefined();
    expect(receivedQuery!.agent).toBe("pi");
    expect(receivedQuery!.alias).toBe("omo");
  });
});
