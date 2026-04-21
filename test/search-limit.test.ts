import { describe, expect, test } from "bun:test";
import { runSearchCommand, type SearchService, type SearchOptions } from "../src/cli/search";
import { type Config } from "../src/config/types";
import { type SearchQuery, type SessionSummary } from "../src/core/types";

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
  ],
};

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

function makeSessions(count: number): SessionSummary[] {
  return Array.from({ length: count }, (_, i) =>
    makeSession({
      id: `session-${String(i).padStart(3, "0")}`,
      title: `Session ${i}`,
    }),
  );
}

/** Creates a searchService that captures the SearchQuery it receives. */
function capturingSearchService(
  sessions: SessionSummary[] = [],
): { service: SearchService; captured: () => SearchQuery | undefined } {
  let captured: SearchQuery | undefined;
  const service: SearchService = async (query) => {
    captured = query;
    return { sessions, errors: [] };
  };
  return { service, captured: () => captured };
}

describe("search limit + time range", () => {
  // 1. SearchOptions accepts limit and passes it to the SearchQuery
  test("SearchOptions accepts limit and passes it to search query", async () => {
    //#given a search service that captures the query
    const { service, captured } = capturingSearchService([makeSession()]);

    //#when running search with limit: 5
    await runSearchCommand({
      text: "test",
      config: baseConfig,
      limit: 5,
      searchSessions: service,
    });

    //#then the search service receives a SearchQuery with limit: 5
    expect(captured()?.limit).toBe(5);
  });

  // 2. SearchOptions accepts since/until and passes timeRange to SearchQuery
  test("SearchOptions accepts since/until and passes timeRange to search query", async () => {
    //#given a search service that captures the query
    const { service, captured } = capturingSearchService([makeSession()]);
    const since = 1704067200000; // 2024-01-01T00:00:00Z ms
    const until = 1704153600000; // 2024-01-02T00:00:00Z ms

    //#when running search with since and until
    await runSearchCommand({
      text: "test",
      config: baseConfig,
      since,
      until,
      searchSessions: service,
    });

    //#then the search service receives a SearchQuery with timeRange
    expect(captured()?.timeRange?.since).toBe(since);
    expect(captured()?.timeRange?.until).toBe(until);
  });

  // 3. SearchOptions accepts both limit and time range simultaneously
  test("SearchOptions accepts both limit and time range simultaneously", async () => {
    //#given a search service that captures the query
    const { service, captured } = capturingSearchService([makeSession()]);
    const since = 1704067200000;

    //#when running search with both limit and since
    await runSearchCommand({
      text: "test",
      config: baseConfig,
      limit: 10,
      since,
      searchSessions: service,
    });

    //#then both limit and timeRange are forwarded to the SearchQuery
    expect(captured()?.limit).toBe(10);
    expect(captured()?.timeRange?.since).toBe(since);
  });

  // 4. Backward compat — SearchQuery works without limit/timeRange
  test("SearchQuery works without limit or timeRange (backward compat)", () => {
    //#given a SearchQuery with only required fields
    const query: SearchQuery = { text: "test", cwd: "/home/user/project" };

    //#then limit and timeRange are undefined (optional fields default)
    expect(query.limit).toBeUndefined();
    expect(query.timeRange).toBeUndefined();
  });

  // 5. CLI integration — --limit flag slices displayed results
  test("CLI --limit flag slices results to specified count", async () => {
    //#given a search service returning 10 sessions
    const tenSessions = makeSessions(10);
    const searchService: SearchService = async () => ({
      sessions: tenSessions,
      errors: [],
    });

    //#when running search with limit: 5
    const result = await runSearchCommand({
      text: "session",
      config: baseConfig,
      limit: 5,
      searchSessions: searchService,
    });

    //#then only 5 sessions appear in the output
    expect(result.exitCode).toBe(0);
    const outputLines = result.stdout.trim().split("\n").filter((l) => l.length > 0);
    expect(outputLines.length).toBe(5);
  });
});
