import { describe, expect, test } from "bun:test";
import { runSearchCommand, type SearchService, type SearchResult } from "../src/cli/search";
import { type Config } from "../src/config/types";

import { loadConfigFromFile } from "../src/config/load";

import { SessionSummary } from "../src/core/types";

import { SearchError } from "../src/cli/search";

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
  ],
};

function makeSearchService(result: SearchResult): SearchService {
  return async () => result;
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-001",
    agent: "opencode",
    alias: "personal",
    title: "Test Session",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 5,
    storage: "db",
    ...overrides,
  }
}

describe("cli search", () => {
  test("requires --text argument", async () => {
    const result = await runSearchCommand({
      config: baseConfig,
      searchSessions: makeSearchService({ sessions: [], errors: [] }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing required argument: --text");
  });

  test("rejects empty --text argument", async () => {
    const result = await runSearchCommand({
      text: "   ",
      config: baseConfig,
      searchSessions: makeSearchService({ sessions: [], errors: [] }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing required argument: --text");
  });

  test("prints 'No sessions found' for empty results", async () => {
    const result = await runSearchCommand({
      text: "nonexistent",
      config: baseConfig,
      searchSessions: makeSearchService({ sessions: [], errors: [] }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No sessions found");
  });

  test("prints session rows with [agent:alias] format", async () => {
    const result = await runSearchCommand({
      text: "error",
      config: baseConfig,
      searchSessions: makeSearchService({
        sessions: [
          {
            id: "oc-200",
            agent: "opencode",
            alias: "personal",
            title: "Fix error in production",
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-02T00:00:00Z",
            message_count: 5,
            storage: "db",
          },
        ],
        errors: [],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[opencode:personal]");
    expect(result.stdout).toContain("Fix error in production");
    expect(result.stdout).toContain("oc-200");
  });

  test("falls back to id when title is empty", async () => {
    const result = await runSearchCommand({
      text: "query",
      config: baseConfig,
      searchSessions: makeSearchService({
        sessions: [
          {
            id: "cx-100",
            agent: "codex",
            alias: "work",
            title: "",
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-02T00:00:00Z",
            message_count: 1,
            storage: "other",
          },
        ],
        errors: [],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[codex:work]");
    expect(result.stdout).toContain("cx-100");
    // Should not show empty title
    expect(result.stdout).not.toContain("[codex:work]  (cx-100)");
  });

  test("prints errors to stderr but still returns sessions", async () => {
    const result = await runSearchCommand({
      text: "test",
      config: baseConfig,
      searchSessions: makeSearchService({
        sessions: [
          {
            id: "oc-200",
            agent: "opencode",
            alias: "personal",
            title: "Test session",
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-02T00:00:00Z",
            message_count: 1,
            storage: "db",
          },
        ],
        errors: [
          {
            agent: "codex",
            alias: "work",
            message: "Failed to search: permission denied",
          },
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Test session");
    expect(result.stderr).toContain("codex:work");
    expect(result.stderr).toContain("permission denied");
  });

  test("handles service errors gracefully", async () => {
    const result = await runSearchCommand({
      text: "test",
      config: baseConfig,
      searchSessions: async () => {
        throw new Error("Service unavailable");
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Service unavailable");
  });

  // Additional tests for coverage improvement

  describe("config resolution", () => {
    test("returns error when config is missing", async () => {
      const result = await runSearchCommand({
        text: "test",
        searchSessions: makeSearchService({ sessions: [], errors: [] }),
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing config");
    });
  });

  describe("error handling", () => {
    test("handles non-Error exceptions", async () => {
      const result = await runSearchCommand({
        text: "test",
        config: baseConfig,
        searchSessions: async () => {
          throw "String error";
        },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("String error");
    });

    test("handles unknown error types", async () => {
      const result = await runSearchCommand({
        text: "test",
        config: baseConfig,
        searchSessions: async () => {
          throw { custom: "object" };
        },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown error");
    });
  });

  describe("multiple sessions and errors", () => {
    test("handles multiple sessions", async () => {
      const result = await runSearchCommand({
        text: "test",
        config: baseConfig,
        searchSessions: makeSearchService({
          sessions: [
            {
              id: "session-1",
              agent: "opencode",
              alias: "personal",
              title: "First Session",
              created_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-02T00:00:00Z",
              message_count: 5,
              storage: "db",
            },
            {
              id: "session-2",
              agent: "codex",
              alias: "work",
              title: "Second Session",
              created_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-02T00:00:00Z",
              message_count: 3,
              storage: "other",
            },
          ],
          errors: [],
        }),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("First Session");
      expect(result.stdout).toContain("Second Session");
    });

    test("handles multiple errors", async () => {
      const result = await runSearchCommand({
        text: "test",
        config: baseConfig,
        searchSessions: makeSearchService({
          sessions: [
            {
              id: "session-1",
              agent: "opencode",
              alias: "personal",
              title: "Session",
              created_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-02T00:00:00Z",
              message_count: 1,
              storage: "db",
            },
          ],
          errors: [
            {
              agent: "codex",
              alias: "work",
              message: "Connection failed",
            },
            {
              agent: "opencode",
              alias: "other",
              message: "Timeout",
            },
          ],
        })
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Connection failed");
      expect(result.stderr).toContain("Timeout");
    });

    test("error message already contains label", async () => {
      const result = await runSearchCommand({
        text: "test",
        config: baseConfig,
        searchSessions: makeSearchService({
          sessions: [],
          errors: [
            {
              agent: "opencode",
              alias: "personal",
              message: "[opencode:personal] Already labeled error",
            },
          ],
        })
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("[opencode:personal] Already labeled error");
      // Should not duplicate the label
      expect(result.stderr).not.toContain("[opencode:personal] [opencode:personal]");
    });
  });
});
