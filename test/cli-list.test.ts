import { describe, expect, test } from "bun:test";
import { runListCommand, type ListService } from "../src/cli/list";
import { loadConfigFromFile } from "../src/config/load";
import { type Config } from "../src/config/types";
import { type SessionListQuery, type SessionListResult } from "../src/core/list";

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
    { agent: "claude", alias: "team", enabled: false },
  ],
};

function makeListService(result: SessionListResult): ListService {
  return async () => result;
}

describe("cli list", () => {
  test("prints [agent:alias] rows and falls back to id for missing title", async () => {
    const list = makeListService({
      sessions: [
        {
          id: "oc-200",
          agent: "opencode",
          alias: "personal",
          title: "Design doc",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
          message_count: 2,
          storage: "db",
        },
        {
          id: "cx-100",
          agent: "codex",
          alias: "work",
          title: "",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
          message_count: 2,
          storage: "other",
        },
      ],
      errors: [],
    });

    const result = await runListCommand({ config: baseConfig, list });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[opencode:personal]");
    expect(result.stdout).toContain("[codex:work]");
    expect(result.stdout).toContain("oc-200");
    expect(result.stdout).toContain("cx-100");
  });

  test("unknown agent lists available agents", async () => {
    const result = await runListCommand({
      agent: "claude",
      config: baseConfig,
      list: makeListService({ sessions: [], errors: [] }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown agent");
    expect(result.stderr).toContain("opencode");
    expect(result.stderr).toContain("codex");
  });

  test("unknown alias lists available aliases", async () => {
    const result = await runListCommand({
      alias: "unknown",
      config: baseConfig,
      list: makeListService({ sessions: [], errors: [] }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown alias");
    expect(result.stderr).toContain("work");
    expect(result.stderr).toContain("personal");
  });

  test("empty results return empty-state message", async () => {
    const result = await runListCommand({
      config: baseConfig,
      list: makeListService({ sessions: [], errors: [] }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No sessions");
  });

  test("empty results with adapter errors still return empty-state message", async () => {
    const result = await runListCommand({
      config: baseConfig,
      list: makeListService({
        sessions: [],
        errors: [
          {
            agent: "codex",
            alias: "work",
            message: "adapter error",
          },
        ],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No sessions");
    expect(result.stderr).toContain("[codex:work]");
  });

  test("partial adapter failures do not block output", async () => {
    const list = makeListService({
      sessions: [
        {
          id: "oc-300",
          agent: "opencode",
          alias: "personal",
          title: "Roadmap",
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
          message: "adapter error",
        },
      ],
    });

    const result = await runListCommand({ config: baseConfig, list });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("oc-300");
    expect(result.stderr).toContain("[codex:work]");
  });

  test("missing config file returns a clear error", async () => {
    const result = await runListCommand({
      configPath: "/tmp/does-not-exist.yml",
      loadConfig: loadConfigFromFile,
      list: makeListService({ sessions: [], errors: [] }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Config file not found");
  });

  test("passes query filters to list service", async () => {
    let received: SessionListQuery | undefined;
    const list: ListService = async (query) => {
      received = query;
      return { sessions: [], errors: [] };
    };

    await runListCommand({
      agent: "codex",
      alias: "work",
      q: "triage",
      config: baseConfig,
      list,
    });

    expect(received).toEqual({ agent: "codex", alias: "work", q: "triage" });
  });

  test("empty query is normalized to undefined", async () => {
    let received: SessionListQuery | undefined;
    const list: ListService = async (query) => {
      received = query;
      return { sessions: [], errors: [] };
    };

    await runListCommand({
      q: "   ",
      config: baseConfig,
      list,
    });

    expect(received).toEqual({ agent: undefined, alias: undefined, q: undefined });
  });
});
