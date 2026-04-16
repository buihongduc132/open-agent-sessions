import { describe, expect, test } from "bun:test";
import { runSearchCommand, type SearchService, type SearchResult } from "../src/cli/search";
import { type Config } from "../src/config/types";

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true, storage: { mode: "auto" } },
  ],
};

function makeSearchService(result: SearchResult): SearchService {
  return async () => result;
}

function makeSession(overrides: Partial<{
  id: string;
  agent: string;
  alias: string;
  title: string;
}> = {}): Parameters<SearchService>[0] extends never ? never : Parameters<SearchService>[0] extends never ? never : { id: string; agent: string; alias: string; title: string; created_at: string; updated_at: string; message_count: number; storage: string } {
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

// Re-export the session shape for convenience
type SessionShape = {
  id: string;
  agent: string;
  alias: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  storage: string;
};

function makeSessionShape(overrides: Partial<SessionShape> = {}): SessionShape {
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

describe("cli search --exclude-current", () => {
  test("exclude_current_flag_removes_current_session_from_results", async () => {
    const CURRENT_SESSION_ID = "current-session-abc";
    const OTHER_SESSION_ID = "other-session-xyz";

    const result = await runSearchCommand({
      text: "grit",
      config: baseConfig,
      currentSessionId: CURRENT_SESSION_ID,
      excludeCurrent: true,
      searchSessions: makeSearchService({
        sessions: [
          // The mock returns the current session as the #1 match (the bug scenario)
          makeSessionShape({
            id: CURRENT_SESSION_ID,
            title: "grit refactoring session",
          }),
          makeSessionShape({
            id: OTHER_SESSION_ID,
            title: "legacy grit codebase",
          }),
        ],
        errors: [],
      }),
    });

    expect(result.exitCode).toBe(0);
    // The current session must NOT appear in output
    expect(result.stdout).not.toContain(CURRENT_SESSION_ID);
    // The other session must still appear
    expect(result.stdout).toContain(OTHER_SESSION_ID);
  });

  test("exclude_current_flag_returns_no_sessions_when_only_match_was_current", async () => {
    const CURRENT_SESSION_ID = "current-only-match";

    const result = await runSearchCommand({
      text: "unique-current-only-topic",
      config: baseConfig,
      currentSessionId: CURRENT_SESSION_ID,
      excludeCurrent: true,
      searchSessions: makeSearchService({
        sessions: [
          makeSessionShape({
            id: CURRENT_SESSION_ID,
            title: "unique-current-only-topic",
          }),
        ],
        errors: [],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No sessions found");
  });

  test("without_exclude_current_current_session_is_included", async () => {
    const CURRENT_SESSION_ID = "current-session-abc";

    const result = await runSearchCommand({
      text: "grit",
      config: baseConfig,
      // Note: no currentSessionId / excludeCurrent — current session should be included
      searchSessions: makeSearchService({
        sessions: [
          makeSessionShape({
            id: CURRENT_SESSION_ID,
            title: "grit refactoring session",
          }),
        ],
        errors: [],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(CURRENT_SESSION_ID);
  });
});

describe("cli search --exclude-session", () => {
  test("exclude_session_flag_removes_specific_id", async () => {
    const EXCLUDED_ID = "exclude-me-999";
    const KEEP_ID = "keep-me-111";

    const result = await runSearchCommand({
      text: "test",
      config: baseConfig,
      excludeSession: [EXCLUDED_ID],
      searchSessions: makeSearchService({
        sessions: [
          makeSessionShape({ id: EXCLUDED_ID, title: "Exclude This Session" }),
          makeSessionShape({ id: KEEP_ID, title: "Keep This Session" }),
        ],
        errors: [],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(`(${EXCLUDED_ID})`);
    expect(result.stdout).toContain(`(${KEEP_ID})`);
  });

  test("exclude_multiple_sessions", async () => {
    const EXCLUDED_1 = "exclude-first";
    const EXCLUDED_2 = "exclude-second";
    const KEEP_ID = "keep-me";

    const result = await runSearchCommand({
      text: "test",
      config: baseConfig,
      excludeSession: [EXCLUDED_1, EXCLUDED_2],
      searchSessions: makeSearchService({
        sessions: [
          makeSessionShape({ id: EXCLUDED_1, title: "First Excluded" }),
          makeSessionShape({ id: EXCLUDED_2, title: "Second Excluded" }),
          makeSessionShape({ id: KEEP_ID, title: "Keep Me" }),
        ],
        errors: [],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(`(${EXCLUDED_1})`);
    expect(result.stdout).not.toContain(`(${EXCLUDED_2})`);
    expect(result.stdout).toContain(`(${KEEP_ID})`);
  });

  test("exclude_nonexistent_session_is_graceful", async () => {
    const result = await runSearchCommand({
      text: "test",
      config: baseConfig,
      excludeSession: ["nonexistent-session-id-12345"],
      searchSessions: makeSearchService({
        sessions: [
          makeSessionShape({ id: "real-session-001", title: "Real Session" }),
        ],
        errors: [],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Real Session");
  });

  test("exclude_current_combined_with_exclude_session", async () => {
    const CURRENT_ID = "current-session-abc";
    const EXCLUDED_ID = "exclude-me-999";
    const KEEP_ID = "keep-me-111";

    const result = await runSearchCommand({
      text: "test",
      config: baseConfig,
      currentSessionId: CURRENT_ID,
      excludeCurrent: true,
      excludeSession: [EXCLUDED_ID],
      searchSessions: makeSearchService({
        sessions: [
          makeSessionShape({ id: CURRENT_ID, title: "Current Session" }),
          makeSessionShape({ id: EXCLUDED_ID, title: "Excluded Session" }),
          makeSessionShape({ id: KEEP_ID, title: "Kept Session" }),
        ],
        errors: [],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(`(${CURRENT_ID})`);
    expect(result.stdout).not.toContain(`(${EXCLUDED_ID})`);
    expect(result.stdout).toContain(`(${KEEP_ID})`);
  });

  test("exclude_current_with_boolean_and_search", async () => {
    const CURRENT_ID = "current-session-abc";
    const OTHER_ID = "other-session-xyz";

    const result = await runSearchCommand({
      text: "error AND fix",
      config: baseConfig,
      currentSessionId: CURRENT_ID,
      excludeCurrent: true,
      searchSessions: makeSearchService({
        sessions: [
          makeSessionShape({ id: CURRENT_ID, title: "error AND fix in current" }),
          makeSessionShape({ id: OTHER_ID, title: "error AND fix in other" }),
        ],
        errors: [],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(`(${CURRENT_ID})`);
    expect(result.stdout).toContain(`(${OTHER_ID})`);
  });

  test("exclude_current_with_boolean_or_search", async () => {
    const CURRENT_ID = "current-session-abc";
    const OTHER_ID = "other-session-xyz";

    const result = await runSearchCommand({
      text: "refactor OR legacy",
      config: baseConfig,
      currentSessionId: CURRENT_ID,
      excludeCurrent: true,
      searchSessions: makeSearchService({
        sessions: [
          makeSessionShape({ id: CURRENT_ID, title: "refactor session" }),
          makeSessionShape({ id: OTHER_ID, title: "legacy codebase" }),
        ],
        errors: [],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(`(${CURRENT_ID})`);
    expect(result.stdout).toContain(`(${OTHER_ID})`);
  });
});