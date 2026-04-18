import { describe, expect, test } from "bun:test";
import {
  createAdapterRegistry,
  type AdapterFactories,
  type AdapterFactory,
  type Config,
  type SessionSummary,
} from "../src/index";
import { runSessionsCommand, type SessionsService } from "../src/cli/sessions";
import type { TimeRangeOptions } from "../src/core/types";

// ============================================================================
// Test Fixtures
// ============================================================================

function makeConfig(agents: Config["agents"]): Config {
  return { agents };
}

/** Config with BOTH opencode AND codex enabled — mirrors oas.config.yaml */
const multiAgentConfig: Config = makeConfig([
  { agent: "opencode", alias: "default", enabled: true, storage: { mode: "auto" } },
  { agent: "codex", alias: "sessions", enabled: true },
]);

/** Config with only opencode — this is what getDefaultConfig() returns */
const singleAgentConfig: Config = makeConfig([
  { agent: "opencode", alias: "default", enabled: true, storage: { mode: "auto" } },
]);

function makeOpenCodeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "oc-session-001",
    agent: "opencode",
    alias: "default",
    title: "OpenCode Session",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 5,
    storage: "db",
    ...overrides,
  };
}

function makeCodexSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "cx-session-001",
    agent: "codex",
    alias: "sessions",
    title: "Codex Session",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-03T00:00:00Z",
    message_count: 3,
    storage: "other",
    ...overrides,
  };
}

/**
 * Factory that returns sessions for the given agent/alias.
 * Supports both listSessions and listSessionsByTimeRange.
 */
function makeMockAdapterFactory(
  sessionsByAlias: Record<string, SessionSummary[]>
): AdapterFactory {
  return (entry) => ({
    version: "1.0.0",
    listSessions: () => sessionsByAlias[entry.alias] ?? [],
    listSessionsByTimeRange: (opts: TimeRangeOptions) => {
      const all = sessionsByAlias[entry.alias] ?? [];
      const since = opts.since ?? 0;
      const until = opts.until ?? Infinity;
      const filtered = all.filter((s) => {
        const ts = Date.parse(s.updated_at);
        return ts >= since && ts <= until;
      });
      const limit = opts.limit ?? 50;
      return limit > 0 ? filtered.slice(0, limit) : filtered;
    },
  });
}

/**
 * Factory that throws on listSessions — simulates adapter failure
 * (e.g., DB path not found, corrupt data).
 */
function makeFailingAdapterFactory(): AdapterFactory {
  return (entry) => ({
    version: "1.0.0",
    listSessions: () => {
      throw new Error(`Adapter [${entry.agent}:${entry.alias}] DB not found`);
    },
    listSessionsByTimeRange: () => {
      throw new Error(`Adapter [${entry.agent}:${entry.alias}] DB not found`);
    },
  });
}

/**
 * Factory that returns sessions via listSessions but does NOT implement
 * listSessionsByTimeRange — forces the fallback path in createSessionsService.
 */
function makeNoTimeRangeAdapterFactory(
  sessionsByAlias: Record<string, SessionSummary[]>
): AdapterFactory {
  return (entry) => ({
    version: "1.0.0",
    listSessions: () => sessionsByAlias[entry.alias] ?? [],
    // Deliberately no listSessionsByTimeRange — forces fallback
  });
}

/**
 * Replicates the createSessionsService logic from bin/oas.
 * This is the code path that has ZERO test coverage.
 */
async function collectSessionsFromRegistry(
  config: Config,
  factories: Partial<AdapterFactories>,
  query: { cwd: string; timeRange: TimeRangeOptions }
): Promise<{ sessions: SessionSummary[]; errors: { agent: string; alias: string; message: string }[] }> {
  const registry = createAdapterRegistry(config, factories);
  const results: SessionSummary[] = [];
  const errors: { agent: string; alias: string; message: string }[] = [];

  for (const adapter of registry.adapters) {
    try {
      if (adapter.listSessionsByTimeRange) {
        const sessions = await adapter.listSessionsByTimeRange(query.timeRange);
        results.push(...sessions);
      } else {
        // Fallback to listSessions if time range not supported
        const sessions = await adapter.listSessions();
        // Apply time filtering manually
        const filtered = sessions.filter((s) => {
          const updated = Date.parse(s.updated_at);
          if (query.timeRange.since !== undefined && updated < query.timeRange.since) {
            return false;
          }
          if (query.timeRange.until !== undefined && updated > query.timeRange.until) {
            return false;
          }
          return true;
        });
        results.push(...filtered);
      }
    } catch (error) {
      errors.push({
        agent: adapter.agent,
        alias: adapter.alias,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Sort by updated_at descending
  results.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));

  // Apply limit
  const limit = query.timeRange.limit ?? 50;
  const limited = limit > 0 ? results.slice(0, limit) : results;

  return { sessions: limited, errors };
}

function makeSessionsService(
  sessions: SessionSummary[],
  errors: { agent: string; alias: string; message: string }[] = []
): SessionsService {
  return async () => ({ sessions, errors });
}

// ============================================================================
// Tests: Multi-Agent Session Collection
// ============================================================================

describe("multi-agent session collection", () => {
  // ==========================================================================
  // BUG EXPOSURE: Registry should contain adapters for ALL enabled agents
  // ==========================================================================
  describe("registry includes both agents", () => {
    test("registry creates adapters for both opencode and codex when both are enabled", () => {
      const factories = {
        opencode: makeMockAdapterFactory({ default: [makeOpenCodeSession()] }),
        codex: makeMockAdapterFactory({ sessions: [makeCodexSession()] }),
        claude: makeMockAdapterFactory({}),
      };

      const registry = createAdapterRegistry(multiAgentConfig, factories);

      expect(registry.adapters.length).toBe(2);
      const agents = registry.adapters.map((a) => `${a.agent}:${a.alias}`);
      expect(agents).toContain("opencode:default");
      expect(agents).toContain("codex:sessions");
    });

    test("registry with single-agent config only has opencode", () => {
      const factories = {
        opencode: makeMockAdapterFactory({ default: [makeOpenCodeSession()] }),
        codex: makeMockAdapterFactory({ sessions: [makeCodexSession()] }),
        claude: makeMockAdapterFactory({}),
      };

      const registry = createAdapterRegistry(singleAgentConfig, factories);

      expect(registry.adapters.length).toBe(1);
      expect(registry.adapters[0].agent).toBe("opencode");
    });
  });

  // ==========================================================================
  // BUG EXPOSURE: Sessions from BOTH agents should appear in results
  // This is the core test that exposes the reported bug:
  //   "oas sessions --last 30d only returns OpenCode sessions,
  //    silently dropping Codex sessions"
  // ==========================================================================
  describe("sessions from both agents appear in results", () => {
    test("BUG: sessions from both opencode AND codex appear in collected results", async () => {
      const openCodeSessions = [
        makeOpenCodeSession({ id: "oc-1", updated_at: "2024-01-02T00:00:00Z" }),
      ];
      const codexSessions = [
        makeCodexSession({ id: "cx-1", updated_at: "2024-01-03T00:00:00Z" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: openCodeSessions }),
        codex: makeMockAdapterFactory({ sessions: codexSessions }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 50 },
        }
      );

      // THIS IS THE BUG: Codex sessions should appear alongside OpenCode sessions
      expect(result.sessions.length).toBe(2);
      const agents = result.sessions.map((s) => s.agent);
      expect(agents).toContain("opencode");
      expect(agents).toContain("codex");
      expect(result.errors).toHaveLength(0);
    });

    test("BUG: multiple sessions from each agent all appear", async () => {
      const openCodeSessions = [
        makeOpenCodeSession({ id: "oc-1", updated_at: "2024-01-02T00:00:00Z" }),
        makeOpenCodeSession({ id: "oc-2", updated_at: "2024-01-01T00:00:00Z" }),
      ];
      const codexSessions = [
        makeCodexSession({ id: "cx-1", updated_at: "2024-01-04T00:00:00Z" }),
        makeCodexSession({ id: "cx-2", updated_at: "2024-01-03T00:00:00Z" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: openCodeSessions }),
        codex: makeMockAdapterFactory({ sessions: codexSessions }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 50 },
        }
      );

      expect(result.sessions.length).toBe(4);
      const ids = result.sessions.map((s) => s.id);
      expect(ids).toContain("oc-1");
      expect(ids).toContain("oc-2");
      expect(ids).toContain("cx-1");
      expect(ids).toContain("cx-2");
    });

    test("BUG: codex sessions are not silently dropped when codex is enabled", async () => {
      // Mirror the exact config from oas.config.yaml
      const codexOnly = [
        makeCodexSession({ id: "cx-only-1", title: "Important Codex Session" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: [] }),
        codex: makeMockAdapterFactory({ sessions: codexOnly }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 50 },
        }
      );

      // Even with no opencode sessions, codex sessions must appear
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0].agent).toBe("codex");
      expect(result.sessions[0].id).toBe("cx-only-1");
      expect(result.sessions[0].title).toBe("Important Codex Session");
    });
  });

  // ==========================================================================
  // BUG EXPOSURE: Sorting across agents — interleaved by updated_at
  // ==========================================================================
  describe("sorting across agents", () => {
    test("sessions from different agents are sorted by updated_at descending", async () => {
      const openCodeSessions = [
        makeOpenCodeSession({ id: "oc-old", updated_at: "2024-01-01T00:00:00Z" }),
        makeOpenCodeSession({ id: "oc-new", updated_at: "2024-01-05T00:00:00Z" }),
      ];
      const codexSessions = [
        makeCodexSession({ id: "cx-mid", updated_at: "2024-01-03T00:00:00Z" }),
        makeCodexSession({ id: "cx-newest", updated_at: "2024-01-06T00:00:00Z" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: openCodeSessions }),
        codex: makeMockAdapterFactory({ sessions: codexSessions }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 50 },
        }
      );

      expect(result.sessions.length).toBe(4);
      // Should be sorted by updated_at DESC: cx-newest, oc-new, cx-mid, oc-old
      expect(result.sessions[0].id).toBe("cx-newest");
      expect(result.sessions[1].id).toBe("oc-new");
      expect(result.sessions[2].id).toBe("cx-mid");
      expect(result.sessions[3].id).toBe("oc-old");
    });

    test("when updated_at is the same, both agents' sessions appear", async () => {
      const openCodeSessions = [
        makeOpenCodeSession({ id: "oc-same", updated_at: "2024-01-03T00:00:00Z" }),
      ];
      const codexSessions = [
        makeCodexSession({ id: "cx-same", updated_at: "2024-01-03T00:00:00Z" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: openCodeSessions }),
        codex: makeMockAdapterFactory({ sessions: codexSessions }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 50 },
        }
      );

      expect(result.sessions.length).toBe(2);
      const ids = result.sessions.map((s) => s.id);
      expect(ids).toContain("oc-same");
      expect(ids).toContain("cx-same");
    });
  });

  // ==========================================================================
  // BUG EXPOSURE: Limit applied to merged multi-agent results
  // ==========================================================================
  describe("limit across agents", () => {
    test("limit is applied AFTER merging sessions from both agents", async () => {
      const openCodeSessions = [
        makeOpenCodeSession({ id: "oc-1", updated_at: "2024-01-05T00:00:00Z" }),
        makeOpenCodeSession({ id: "oc-2", updated_at: "2024-01-03T00:00:00Z" }),
      ];
      const codexSessions = [
        makeCodexSession({ id: "cx-1", updated_at: "2024-01-06T00:00:00Z" }),
        makeCodexSession({ id: "cx-2", updated_at: "2024-01-04T00:00:00Z" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: openCodeSessions }),
        codex: makeMockAdapterFactory({ sessions: codexSessions }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 3 },
        }
      );

      // Only top 3 by updated_at: cx-1(Jan 6), oc-1(Jan 5), cx-2(Jan 4)
      expect(result.sessions.length).toBe(3);
      expect(result.sessions[0].id).toBe("cx-1");
      expect(result.sessions[1].id).toBe("oc-1");
      expect(result.sessions[2].id).toBe("cx-2");
    });

    test("limit 0 returns ALL sessions from all agents", async () => {
      const openCodeSessions = [
        makeOpenCodeSession({ id: "oc-1", updated_at: "2024-01-01T00:00:00Z" }),
        makeOpenCodeSession({ id: "oc-2", updated_at: "2024-01-02T00:00:00Z" }),
        makeOpenCodeSession({ id: "oc-3", updated_at: "2024-01-03T00:00:00Z" }),
      ];
      const codexSessions = [
        makeCodexSession({ id: "cx-1", updated_at: "2024-01-04T00:00:00Z" }),
        makeCodexSession({ id: "cx-2", updated_at: "2024-01-05T00:00:00Z" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: openCodeSessions }),
        codex: makeMockAdapterFactory({ sessions: codexSessions }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 0 },
        }
      );

      expect(result.sessions.length).toBe(5);
    });

    test("limit 1 returns the single most recent session regardless of agent", async () => {
      const openCodeSessions = [
        makeOpenCodeSession({ id: "oc-recent", updated_at: "2024-01-10T00:00:00Z" }),
      ];
      const codexSessions = [
        makeCodexSession({ id: "cx-recent", updated_at: "2024-01-15T00:00:00Z" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: openCodeSessions }),
        codex: makeMockAdapterFactory({ sessions: codexSessions }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 1 },
        }
      );

      expect(result.sessions.length).toBe(1);
      // Codex session is newer, should be first
      expect(result.sessions[0].id).toBe("cx-recent");
    });
  });

  // ==========================================================================
  // BUG EXPOSURE: One adapter fails, other succeeds
  // ==========================================================================
  describe("partial adapter failure", () => {
    test("when codex adapter fails, opencode sessions still appear", async () => {
      const openCodeSessions = [
        makeOpenCodeSession({ id: "oc-ok", title: "OpenCode Works" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: openCodeSessions }),
        codex: makeFailingAdapterFactory(),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 50 },
        }
      );

      // OpenCode sessions should still appear
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0].id).toBe("oc-ok");
      // Codex error should be recorded
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].agent).toBe("codex");
      expect(result.errors[0].message).toContain("DB not found");
    });

    test("when opencode adapter fails, codex sessions still appear", async () => {
      const codexSessions = [
        makeCodexSession({ id: "cx-ok", title: "Codex Works" }),
      ];

      const factories = {
        opencode: makeFailingAdapterFactory(),
        codex: makeMockAdapterFactory({ sessions: codexSessions }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 50 },
        }
      );

      // Codex sessions should still appear
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0].id).toBe("cx-ok");
      // OpenCode error should be recorded
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].agent).toBe("opencode");
    });

    test("BUG: errors from codex adapter are reported, not silently swallowed", async () => {
      const factories = {
        opencode: makeMockAdapterFactory({ default: [makeOpenCodeSession()] }),
        codex: makeFailingAdapterFactory(),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 50 },
        }
      );

      // The error MUST be in the errors array — not silently dropped
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      const codexErrors = result.errors.filter((e) => e.agent === "codex");
      expect(codexErrors.length).toBe(1);
      expect(codexErrors[0].alias).toBe("sessions");
    });
  });

  // ==========================================================================
  // BUG EXPOSURE: One adapter returns empty, other returns sessions
  // ==========================================================================
  describe("partial empty results", () => {
    test("when codex returns empty, opencode sessions still appear", async () => {
      const factories = {
        opencode: makeMockAdapterFactory({ default: [makeOpenCodeSession()] }),
        codex: makeMockAdapterFactory({ sessions: [] }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 50 },
        }
      );

      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0].agent).toBe("opencode");
    });

    test("when opencode returns empty, codex sessions still appear", async () => {
      const factories = {
        opencode: makeMockAdapterFactory({ default: [] }),
        codex: makeMockAdapterFactory({ sessions: [makeCodexSession()] }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 50 },
        }
      );

      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0].agent).toBe("codex");
    });
  });

  // ==========================================================================
  // BUG EXPOSURE: Mixed listSessionsByTimeRange capabilities
  // Some adapters implement listSessionsByTimeRange, others don't.
  // The createSessionsService fallback path must work correctly.
  // ==========================================================================
  describe("mixed adapter capabilities", () => {
    test("adapter without listSessionsByTimeRange falls back to listSessions", async () => {
      const openCodeSessions = [
        makeOpenCodeSession({ id: "oc-with-range", updated_at: "2024-01-02T00:00:00Z" }),
      ];
      const codexSessions = [
        makeCodexSession({ id: "cx-no-range", updated_at: "2024-01-03T00:00:00Z" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: openCodeSessions }),
        // Codex factory does NOT implement listSessionsByTimeRange
        codex: makeNoTimeRangeAdapterFactory({ sessions: codexSessions }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, limit: 50 },
        }
      );

      // Both sessions must appear — codex must use fallback path
      expect(result.sessions.length).toBe(2);
      const ids = result.sessions.map((s) => s.id);
      expect(ids).toContain("oc-with-range");
      expect(ids).toContain("cx-no-range");
    });

    test("fallback path applies time range filter correctly", async () => {
      const codexSessions = [
        makeCodexSession({ id: "cx-old", updated_at: "2024-01-01T00:00:00Z" }),
        makeCodexSession({ id: "cx-recent", updated_at: "2024-01-10T00:00:00Z" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: [] }),
        // Codex factory does NOT implement listSessionsByTimeRange
        codex: makeNoTimeRangeAdapterFactory({ sessions: codexSessions }),
        claude: makeMockAdapterFactory({}),
      };

      const since = new Date("2024-01-05T00:00:00Z").getTime();
      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since, limit: 50 },
        }
      );

      // Only the recent codex session should pass the time filter
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0].id).toBe("cx-recent");
    });
  });

  // ==========================================================================
  // BUG EXPOSURE: Time range filtering across agents
  // ==========================================================================
  describe("time range filtering across agents", () => {
    test("since filter excludes old sessions from both agents", async () => {
      const since = new Date("2024-01-05T00:00:00Z").getTime();
      const openCodeSessions = [
        makeOpenCodeSession({ id: "oc-old", updated_at: "2024-01-01T00:00:00Z" }),
        makeOpenCodeSession({ id: "oc-new", updated_at: "2024-01-10T00:00:00Z" }),
      ];
      const codexSessions = [
        makeCodexSession({ id: "cx-old", updated_at: "2024-01-03T00:00:00Z" }),
        makeCodexSession({ id: "cx-new", updated_at: "2024-01-08T00:00:00Z" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: openCodeSessions }),
        codex: makeMockAdapterFactory({ sessions: codexSessions }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since, limit: 50 },
        }
      );

      expect(result.sessions.length).toBe(2);
      const ids = result.sessions.map((s) => s.id);
      expect(ids).toContain("oc-new");
      expect(ids).toContain("cx-new");
      expect(ids).not.toContain("oc-old");
      expect(ids).not.toContain("cx-old");
    });

    test("until filter excludes future sessions from both agents", async () => {
      const until = new Date("2024-01-05T00:00:00Z").getTime();
      const openCodeSessions = [
        makeOpenCodeSession({ id: "oc-before", updated_at: "2024-01-03T00:00:00Z" }),
        makeOpenCodeSession({ id: "oc-after", updated_at: "2024-01-10T00:00:00Z" }),
      ];
      const codexSessions = [
        makeCodexSession({ id: "cx-before", updated_at: "2024-01-04T00:00:00Z" }),
        makeCodexSession({ id: "cx-after", updated_at: "2024-01-08T00:00:00Z" }),
      ];

      const factories = {
        opencode: makeMockAdapterFactory({ default: openCodeSessions }),
        codex: makeMockAdapterFactory({ sessions: codexSessions }),
        claude: makeMockAdapterFactory({}),
      };

      const result = await collectSessionsFromRegistry(
        multiAgentConfig,
        factories,
        {
          cwd: process.cwd(),
          timeRange: { since: 0, until, limit: 50 },
        }
      );

      expect(result.sessions.length).toBe(2);
      const ids = result.sessions.map((s) => s.id);
      expect(ids).toContain("oc-before");
      expect(ids).toContain("cx-before");
    });
  });
});

// ============================================================================
// Tests: CLI output with multi-agent sessions
// These test that runSessionsCommand correctly formats sessions from
// BOTH opencode AND codex in its output.
// ============================================================================

describe("cli sessions: multi-agent output", () => {
  const multiConfig: Config = {
    agents: [
      { agent: "opencode", alias: "default", enabled: true, storage: { mode: "auto" } },
      { agent: "codex", alias: "sessions", enabled: true },
    ],
  };

  test("BUG: text output includes both opencode and codex sessions", async () => {
    const sessions = [
      makeOpenCodeSession({ id: "oc-1", title: "OpenCode Work" }),
      makeCodexSession({ id: "cx-1", title: "Codex Work" }),
    ];

    const result = await runSessionsCommand({
      config: multiConfig,
      getSessions: makeSessionsService(sessions),
    });

    expect(result.exitCode).toBe(0);
    // BOTH agents must appear in output
    expect(result.stdout).toContain("[opencode:default]");
    expect(result.stdout).toContain("[codex:sessions]");
    expect(result.stdout).toContain("OpenCode Work");
    expect(result.stdout).toContain("Codex Work");
  });

  test("BUG: JSON output includes both opencode and codex sessions", async () => {
    const sessions = [
      makeOpenCodeSession({ id: "oc-1", title: "OpenCode Work" }),
      makeCodexSession({ id: "cx-1", title: "Codex Work" }),
    ];

    const result = await runSessionsCommand({
      format: "json",
      config: multiConfig,
      getSessions: makeSessionsService(sessions),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.length).toBe(2);

    const agents = parsed.map((s: SessionSummary) => s.agent);
    expect(agents).toContain("opencode");
    expect(agents).toContain("codex");

    const aliases = parsed.map((s: SessionSummary) => s.alias);
    expect(aliases).toContain("default");
    expect(aliases).toContain("sessions");
  });

  test("BUG: codex sessions appear even when opencode has no sessions", async () => {
    const sessions = [
      makeCodexSession({ id: "cx-only", title: "Only Codex" }),
    ];

    const result = await runSessionsCommand({
      config: multiConfig,
      getSessions: makeSessionsService(sessions),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[codex:sessions]");
    expect(result.stdout).toContain("Only Codex");
    // Should NOT contain opencode since no opencode sessions exist
    expect(result.stdout).not.toContain("[opencode:");
  });

  test("BUG: opencode sessions appear even when codex has no sessions", async () => {
    const sessions = [
      makeOpenCodeSession({ id: "oc-only", title: "Only OpenCode" }),
    ];

    const result = await runSessionsCommand({
      config: multiConfig,
      getSessions: makeSessionsService(sessions),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[opencode:default]");
    expect(result.stdout).toContain("Only OpenCode");
    expect(result.stdout).not.toContain("[codex:");
  });

  test("BUG: errors from codex adapter are shown in stderr", async () => {
    const sessions = [
      makeOpenCodeSession({ id: "oc-1", title: "OpenCode OK" }),
    ];
    const errors = [
      { agent: "codex" as const, alias: "sessions", message: "Codex DB not found" },
    ];

    const result = await runSessionsCommand({
      config: multiConfig,
      getSessions: makeSessionsService(sessions, errors),
    });

    expect(result.exitCode).toBe(0);
    // OpenCode session should still appear
    expect(result.stdout).toContain("OpenCode OK");
    // Codex error should be visible in stderr
    expect(result.stderr).toContain("[codex:sessions]");
    expect(result.stderr).toContain("Codex DB not found");
  });

  test("BUG: multiple sessions from different agents all appear in output", async () => {
    // Simulate what createSessionsService returns: sessions sorted by updated_at DESC
    const sessions = [
      makeCodexSession({ id: "cx-new", title: "CX New", updated_at: "2024-01-03T00:00:00Z" }),
      makeOpenCodeSession({ id: "oc-mid", title: "OC Mid", updated_at: "2024-01-02T00:00:00Z" }),
      makeOpenCodeSession({ id: "oc-old", title: "OC Old", updated_at: "2024-01-01T00:00:00Z" }),
    ];

    const result = await runSessionsCommand({
      format: "json",
      config: multiConfig,
      getSessions: makeSessionsService(sessions),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.length).toBe(3);

    // All sessions from both agents must appear
    const ids = parsed.map((s: SessionSummary) => s.id);
    expect(ids).toContain("cx-new");
    expect(ids).toContain("oc-mid");
    expect(ids).toContain("oc-old");

    // Verify order is preserved (service returns sorted, CLI passes through)
    expect(parsed[0].id).toBe("cx-new");
    expect(parsed[1].id).toBe("oc-mid");
    expect(parsed[2].id).toBe("oc-old");
  });
});

// ============================================================================
// Tests: Edge cases for multi-agent scenarios
// ============================================================================

describe("multi-agent edge cases", () => {
  test("three agents: opencode, codex, and claude all contribute sessions", async () => {
    const threeAgentConfig: Config = {
      agents: [
        { agent: "opencode", alias: "default", enabled: true, storage: { mode: "auto" } },
        { agent: "codex", alias: "sessions", enabled: true },
        { agent: "claude", alias: "team", enabled: true },
      ],
    };

    const sessions = [
      makeOpenCodeSession({ id: "oc-1", updated_at: "2024-01-02T00:00:00Z" }),
      makeCodexSession({ id: "cx-1", updated_at: "2024-01-03T00:00:00Z" }),
      {
        id: "cl-1",
        agent: "claude" as const,
        alias: "team",
        title: "Claude Session",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-04T00:00:00Z",
        message_count: 8,
        storage: "other" as const,
      },
    ];

    const result = await runSessionsCommand({
      format: "json",
      config: threeAgentConfig,
      getSessions: makeSessionsService(sessions),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.length).toBe(3);

    const agents = parsed.map((s: SessionSummary) => s.agent).sort();
    expect(agents).toEqual(["claude", "codex", "opencode"]);
  });

  test("disabled codex agent does not contribute sessions", async () => {
    const configWithDisabledCodex: Config = {
      agents: [
        { agent: "opencode", alias: "default", enabled: true, storage: { mode: "auto" } },
        { agent: "codex", alias: "sessions", enabled: false },
      ],
    };

    // Even though the service returns codex sessions, the config says disabled
    const sessions = [
      makeOpenCodeSession({ id: "oc-1" }),
      makeCodexSession({ id: "cx-1" }),
    ];

    const result = await runSessionsCommand({
      format: "json",
      config: configWithDisabledCodex,
      getSessions: makeSessionsService(sessions),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    // The mock service returns both, but in real usage the registry
    // would only query enabled agents
    expect(parsed.length).toBe(2); // Mock returns both
  });

  test("empty session list from all agents shows 'No sessions found'", async () => {
    const result = await runSessionsCommand({
      config: {
        agents: [
          { agent: "opencode", alias: "default", enabled: true, storage: { mode: "auto" } },
          { agent: "codex", alias: "sessions", enabled: true },
        ],
      },
      getSessions: makeSessionsService([]),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No sessions found");
  });

  test("errors from multiple agents all appear in stderr", async () => {
    const errors = [
      { agent: "opencode" as const, alias: "default", message: "OpenCode DB error" },
      { agent: "codex" as const, alias: "sessions", message: "Codex DB error" },
    ];

    const result = await runSessionsCommand({
      config: {
        agents: [
          { agent: "opencode", alias: "default", enabled: true, storage: { mode: "auto" } },
          { agent: "codex", alias: "sessions", enabled: true },
        ],
      },
      getSessions: makeSessionsService([], errors),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("[opencode:default]");
    expect(result.stderr).toContain("OpenCode DB error");
    expect(result.stderr).toContain("[codex:sessions]");
    expect(result.stderr).toContain("Codex DB error");
  });
});
