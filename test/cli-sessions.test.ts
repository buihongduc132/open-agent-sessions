import { describe, expect, test } from "bun:test";
import { runSessionsCommand, type SessionsService } from "../src/cli/sessions";
import { type Config } from "../src/config/types";
import { type SessionSummary } from "../src/core/types";

// ============================================================================
// Test Fixtures
// ============================================================================

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
    { agent: "claude", alias: "team", enabled: false },
  ],
};

function makeSessionsService(
  sessions: SessionSummary[],
  errors: { agent: "opencode" | "codex" | "claude"; alias: string; message: string }[] = [],
  onCall?: (query: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } }) => void
): SessionsService {
  return async (query) => {
    if (onCall) {
      onCall(query);
    }
    return { sessions, errors };
  };
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
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("cli sessions", () => {
  // ==========================================================================
  // AC1: Parse --last 4h (last 4 hours)
  // ==========================================================================
  describe("AC1: --last 4h", () => {
    test("parses --last 4h and passes to service", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        last: "4h",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.timeRange.since).toBeDefined();
      expect(receivedQuery!.timeRange.until).toBeUndefined();
      
      // Verify it's approximately 4 hours ago (within 1 second tolerance)
      const now = Date.now();
      const fourHoursAgo = now - 4 * 60 * 60 * 1000;
      const diff = Math.abs(receivedQuery!.timeRange.since! - fourHoursAgo);
      expect(diff).toBeLessThan(1000);
    });

    test("rejects --last 0h", async () => {
      const result = await runSessionsCommand({
        last: "0h",
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Duration must be positive");
    });

    test("rejects invalid --last format", async () => {
      const result = await runSessionsCommand({
        last: "invalid",
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid time format");
    });
  });

  // ==========================================================================
  // AC2: Parse --last 2d (last 2 days)
  // ==========================================================================
  describe("AC2: --last 2d", () => {
    test("parses --last 2d and passes to service", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        last: "2d",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.timeRange.since).toBeDefined();
      
      // Verify it's approximately 2 days ago
      const now = Date.now();
      const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
      const diff = Math.abs(receivedQuery!.timeRange.since! - twoDaysAgo);
      expect(diff).toBeLessThan(1000);
    });
  });

  // ==========================================================================
  // AC3: Parse --since TIMESTAMP (ISO-8601)
  // ==========================================================================
  describe("AC3: --since TIMESTAMP", () => {
    test("parses --since with ISO-8601 timestamp", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        since: "2024-01-01T00:00:00Z",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.timeRange.since).toBe(new Date("2024-01-01T00:00:00Z").getTime());
    });

    test("rejects invalid --since format", async () => {
      const result = await runSessionsCommand({
        since: "not-a-date",
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid timestamp format");
      expect(result.stderr).toContain("ISO-8601 with timezone required");
    });
  });

  // ==========================================================================
  // AC4: Parse --until TIMESTAMP (ISO-8601)
  // ==========================================================================
  describe("AC4: --until TIMESTAMP", () => {
    test("parses --until with ISO-8601 timestamp", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        until: "2024-01-02T00:00:00Z",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.timeRange.until).toBe(new Date("2024-01-02T00:00:00Z").getTime());
    });
  });

  // ==========================================================================
  // AC5: Combine --since and --until for range
  // ==========================================================================
  describe("AC5: Combine --since and --until", () => {
    test("parses both --since and --until", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        since: "2024-01-01T00:00:00Z",
        until: "2024-01-02T00:00:00Z",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.timeRange.since).toBe(new Date("2024-01-01T00:00:00Z").getTime());
      expect(receivedQuery!.timeRange.until).toBe(new Date("2024-01-02T00:00:00Z").getTime());
    });

    test("rejects --since after --until", async () => {
      const result = await runSessionsCommand({
        since: "2024-01-02T00:00:00Z",
        until: "2024-01-01T00:00:00Z",
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid time range");
      expect(result.stderr).toContain("--since is after --until");
    });

    test("allows --last with --until (combines relative and absolute)", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        last: "1d",
        until: "2024-01-02T00:00:00Z",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.timeRange.until).toBe(new Date("2024-01-02T00:00:00Z").getTime());
      
      // --last 1d with --until should calculate since as 1 day before until
      const expectedSince = new Date("2024-01-02T00:00:00Z").getTime() - 24 * 60 * 60 * 1000;
      expect(receivedQuery!.timeRange.since).toBe(expectedSince);
    });
  });

  // ==========================================================================
  // AC6: Invalid time format → clear error message
  // ==========================================================================
  describe("AC6: Invalid time format", () => {
    test("shows clear error for invalid --last format", async () => {
      const result = await runSessionsCommand({
        last: "5x",
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid time format");
      expect(result.stderr).toContain("4h, 2d, 1w");
      expect(result.stderr).toContain("ISO-8601");
    });

    test("shows clear error for invalid --since format", async () => {
      const result = await runSessionsCommand({
        since: "not-a-timestamp",
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid timestamp format");
      expect(result.stderr).toContain("ISO-8601");
    });
  });

  // ==========================================================================
  // AC7: Default: last 24h, limit 50, text format
  // ==========================================================================
  describe("AC7: Default behavior", () => {
    test("defaults to last 24h when no time filters specified", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.timeRange.since).toBeDefined();
      expect(receivedQuery!.timeRange.until).toBeUndefined();
      
      // Verify it's approximately 24 hours ago
      const now = Date.now();
      const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
      const diff = Math.abs(receivedQuery!.timeRange.since! - twentyFourHoursAgo);
      expect(diff).toBeLessThan(1000);
    });

    test("defaults to limit 50", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.timeRange.limit).toBe(50);
    });

    test("respects custom --limit", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        limit: 100,
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.timeRange.limit).toBe(100);
    });

    test("allows --limit 0 for all sessions", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        limit: 0,
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.timeRange.limit).toBe(0);
    });
  });

  // ==========================================================================
  // AC8: Project-scoped (current directory)
  // ==========================================================================
  describe("AC8: Project-scoped", () => {
    test("passes current working directory to service", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.cwd).toBe(process.cwd());
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================
  describe("Edge Cases", () => {
    test("no sessions in range shows empty result (not error)", async () => {
      const result = await runSessionsCommand({
        since: "2024-01-01T00:00:00Z",
        until: "2024-01-02T00:00:00Z",
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No sessions found");
    });

    test("future timestamps are rejected", async () => {
      const future = new Date(Date.now() + 86400000).toISOString(); // 24 hours in future
      
      const result = await runSessionsCommand({
        since: future,
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Time range cannot be in the future");
    });

    test("future --until is rejected", async () => {
      const future = new Date(Date.now() + 86400000).toISOString(); // 24 hours in future
      
      const result = await runSessionsCommand({
        until: future,
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Time range cannot be in the future");
    });

    test("service errors are shown", async () => {
      const result = await runSessionsCommand({
        config: baseConfig,
        getSessions: makeSessionsService(
          [],
          [{ agent: "opencode", alias: "personal", message: "Database connection failed" }]
        ),
      });

      expect(result.exitCode).toBe(0); // Errors are shown in stderr, but command succeeds
      expect(result.stderr).toContain("[opencode:personal]");
      expect(result.stderr).toContain("Database connection failed");
    });
  });

  // ==========================================================================
  // Output Formatting
  // ==========================================================================
  describe("output formatting", () => {
    test("formats session with title", async () => {
      const sessions = [makeSession({ title: "My Session" })];

      const result = await runSessionsCommand({
        config: baseConfig,
        getSessions: makeSessionsService(sessions),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[opencode:personal]");
      expect(result.stdout).toContain("My Session");
      expect(result.stdout).toContain("session-001");
    });

    test("formats session without title (uses ID only)", async () => {
      const sessions = [makeSession({ title: "" })];

      const result = await runSessionsCommand({
        config: baseConfig,
        getSessions: makeSessionsService(sessions),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[opencode:personal]");
      expect(result.stdout).toContain("session-001");
    });

    test("formats multiple sessions", async () => {
      const sessions = [
        makeSession({ id: "session-001", title: "First" }),
        makeSession({ id: "session-002", title: "Second" }),
      ];

      const result = await runSessionsCommand({
        config: baseConfig,
        getSessions: makeSessionsService(sessions),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("session-001");
      expect(result.stdout).toContain("session-002");
      expect(result.stdout).toContain("First");
      expect(result.stdout).toContain("Second");
    });
  });

  // ==========================================================================
  // Error Cases
  // ==========================================================================
  describe("error cases", () => {
    test("missing config returns error", async () => {
      const result = await runSessionsCommand({
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing config");
    });

    test("service throws error", async () => {
      const result = await runSessionsCommand({
        config: baseConfig,
        getSessions: async () => {
          throw new Error("Unexpected error");
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unexpected error");
    });
  });

  // ==========================================================================
  // Additional Time Format Tests
  // ==========================================================================
  describe("additional time formats", () => {
    test("parses --last 1w (1 week)", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        last: "1w",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      
      // Verify it's approximately 1 week ago
      const now = Date.now();
      const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
      const diff = Math.abs(receivedQuery!.timeRange.since! - oneWeekAgo);
      expect(diff).toBeLessThan(1000);
    });

    test("rejects invalid time unit", async () => {
      const result = await runSessionsCommand({
        last: "5m", // minutes not supported
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid time format");
    });
  });

  // ==========================================================================
  // ISO-8601 Strictness Tests
  // ==========================================================================
  describe("ISO-8601 strictness", () => {
    test("rejects date-only format without timezone", async () => {
      const result = await runSessionsCommand({
        since: "2024-01-01",
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid timestamp format");
      expect(result.stderr).toContain("ISO-8601 with timezone required");
      expect(result.stderr).toContain("Date-only strings");
    });

    test("rejects datetime without timezone", async () => {
      const result = await runSessionsCommand({
        since: "2024-01-01T00:00:00",
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid timestamp format");
      expect(result.stderr).toContain("timezone required");
    });

    test("accepts ISO-8601 with Z timezone", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        since: "2024-01-01T00:00:00Z",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.timeRange.since).toBe(new Date("2024-01-01T00:00:00Z").getTime());
    });

    test("accepts ISO-8601 with timezone offset", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        since: "2024-01-01T05:00:00+05:00",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      // 2024-01-01T05:00:00+05:00 equals 2024-01-01T00:00:00Z
      expect(receivedQuery!.timeRange.since).toBe(new Date("2024-01-01T00:00:00Z").getTime());
    });

    test("accepts ISO-8601 with negative timezone offset", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        since: "2024-01-01T00:00:00-05:00",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      // 2024-01-01T00:00:00-05:00 equals 2024-01-01T05:00:00Z
      expect(receivedQuery!.timeRange.since).toBe(new Date("2024-01-01T05:00:00Z").getTime());
    });

    test("accepts ISO-8601 with milliseconds", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        since: "2024-01-01T00:00:00.123Z",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.timeRange.since).toBe(new Date("2024-01-01T00:00:00.123Z").getTime());
    });

    test("rejects --until with date-only format", async () => {
      const result = await runSessionsCommand({
        until: "2024-01-02",
        config: baseConfig,
        getSessions: makeSessionsService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid timestamp format");
    });
  });

  // ==========================================================================
  // Timezone Handling Tests
  // ==========================================================================
  describe("timezone handling", () => {
    test("relative time (--last) uses local timezone", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        last: "4h",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      
      // Verify it's approximately 4 hours ago in local time
      // Date.now() returns local time in milliseconds since epoch
      const now = Date.now();
      const fourHoursAgo = now - 4 * 60 * 60 * 1000;
      const diff = Math.abs(receivedQuery!.timeRange.since! - fourHoursAgo);
      expect(diff).toBeLessThan(1000);
    });

    test("absolute time preserves timezone from input (UTC)", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        since: "2024-01-01T12:00:00Z",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      
      // The timestamp should be parsed as UTC (12:00:00Z = 12:00:00 UTC)
      const expectedTime = new Date("2024-01-01T12:00:00Z").getTime();
      expect(receivedQuery!.timeRange.since).toBe(expectedTime);
    });

    test("absolute time preserves timezone from input (+ offset)", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        since: "2024-01-01T17:00:00+05:00",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      
      // 2024-01-01T17:00:00+05:00 = 2024-01-01T12:00:00Z
      const expectedTime = new Date("2024-01-01T12:00:00Z").getTime();
      expect(receivedQuery!.timeRange.since).toBe(expectedTime);
    });

    test("absolute time preserves timezone from input (- offset)", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        since: "2024-01-01T07:00:00-05:00",
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      
      // 2024-01-01T07:00:00-05:00 = 2024-01-01T12:00:00Z
      const expectedTime = new Date("2024-01-01T12:00:00Z").getTime();
      expect(receivedQuery!.timeRange.since).toBe(expectedTime);
    });

    test("default 24h uses local timezone", async () => {
      let receivedQuery: { cwd: string; timeRange: { since?: number; until?: number; limit?: number } } | undefined;
      const sessions = [makeSession()];

      const result = await runSessionsCommand({
        config: baseConfig,
        getSessions: makeSessionsService(sessions, [], (query) => {
          receivedQuery = query;
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(receivedQuery).toBeDefined();
      
      // Verify it's approximately 24 hours ago in local time
      const now = Date.now();
      const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
      const diff = Math.abs(receivedQuery!.timeRange.since! - twentyFourHoursAgo);
      expect(diff).toBeLessThan(1000);
    });
  });
});
