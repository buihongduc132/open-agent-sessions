import { describe, expect, test } from "bun:test";
import { runDetailCommand, type DetailService } from "../src/cli/detail";
import { loadConfigFromFile } from "../src/config/load";
import { type Config } from "../src/config/types";
import { type SessionDetail } from "../src/core/types";

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
    { agent: "claude", alias: "team", enabled: false },
  ],
};

function makeDetailService(detail: SessionDetail | null): DetailService {
  return async () => detail;
}

describe("cli detail", () => {
  test("prints header and stable fields with trimmed title", async () => {
    const detail: SessionDetail = {
      id: "cx-100",
      agent: "codex",
      alias: "work",
      title: "  Sprint plan  ",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      message_count: 0,
      storage: "other",
    };

    const result = await runDetailCommand({
      agent: "codex",
      alias: "work",
      id: "cx-100",
      config: baseConfig,
      getSession: makeDetailService(detail),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "Session [codex:work]",
        "agent: codex",
        "alias: work",
        "id: cx-100",
        "title: Sprint plan",
        "created_at: 2024-01-01T00:00:00Z",
        "updated_at: 2024-01-02T00:00:00Z",
        "message_count: 0",
        "storage: other",
        "",
      ].join("\n")
    );
  });

  test("falls back to id when title is blank", async () => {
    const detail: SessionDetail = {
      id: "cx-200",
      agent: "codex",
      alias: "work",
      title: "   ",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      message_count: 2,
      storage: "other",
    };

    const result = await runDetailCommand({
      session: "codex:work:cx-200",
      config: baseConfig,
      getSession: makeDetailService(detail),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("title: cx-200");
  });

  test("renders storage value for opencode detail (db preferred)", async () => {
    const detail: SessionDetail = {
      id: "oc-900",
      agent: "opencode",
      alias: "personal",
      title: "Storage check",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      message_count: 1,
      storage: "db",
    };

    const result = await runDetailCommand({
      session: "opencode:personal:oc-900",
      config: baseConfig,
      getSession: makeDetailService(detail),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("storage: db");
  });

  test("renders clone metadata with placeholders for missing fields", async () => {
    const detail: SessionDetail = {
      id: "oc-300",
      agent: "opencode",
      alias: "personal",
      title: "Clone",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      message_count: 5,
      storage: "db",
      clone: {
        src: { agent: "codex", session_id: "cx-300", version: "codex@1.0" },
        dst: { agent: "opencode", session_id: "oc-300" },
      },
    };

    const result = await runDetailCommand({
      session: "opencode:personal:oc-300",
      config: baseConfig,
      getSession: makeDetailService(detail),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("src.agent: codex");
    expect(result.stdout).toContain("src.session_id: cx-300");
    expect(result.stdout).toContain("src.version: codex@1.0");
    expect(result.stdout).toContain("dst.agent: opencode");
    expect(result.stdout).toContain("dst.session_id: oc-300");
    expect(result.stdout).toContain("dst.version: -");
  });

  test("missing config returns error and does not call getSession", async () => {
    let called = false;
    const result = await runDetailCommand({
      session: "codex:work:cx-100",
      getSession: async () => {
        called = true;
        return null;
      },
    });

    expect(called).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing config");
  });

  test("config object takes precedence over configPath", async () => {
    let called = false;
    const result = await runDetailCommand({
      session: "codex:work:cx-100",
      config: baseConfig,
      configPath: "/tmp/does-not-exist.yml",
      loadConfig: () => {
        called = true;
        throw new Error("should not be called");
      },
      getSession: makeDetailService({
        id: "cx-100",
        agent: "codex",
        alias: "work",
        title: "Plan",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        message_count: 1,
        storage: "other",
      }),
    });

    expect(called).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  test("invalid config path surfaces load error", async () => {
    const result = await runDetailCommand({
      session: "codex:work:cx-100",
      configPath: "/tmp/does-not-exist.yml",
      loadConfig: loadConfigFromFile,
      getSession: makeDetailService(null),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Config file not found");
  });

  test("unknown agent lists available agents", async () => {
    const result = await runDetailCommand({
      session: "unknown:cx-100",
      config: baseConfig,
      getSession: makeDetailService(null),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown agent");
    expect(result.stderr).toContain("opencode");
    expect(result.stderr).toContain("codex");
  });

  test("unknown alias lists available aliases for agent", async () => {
    const result = await runDetailCommand({
      session: "codex:unknown:cx-100",
      config: baseConfig,
      getSession: makeDetailService(null),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown alias");
    expect(result.stderr).toContain("work");
  });

  test("invalid --session format with empty segment shows usage", async () => {
    const result = await runDetailCommand({
      session: "codex:work:",
      config: baseConfig,
      getSession: makeDetailService(null),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --session value");
    expect(result.stderr).toContain("Usage:");
  });

  test("alias inference works when unique", async () => {
    let received: { agent: string; alias: string; id: string } | undefined;
    const getSession: DetailService = async (query) => {
      received = query;
      return {
        id: query.id,
        agent: "codex",
        alias: query.alias,
        title: "Item",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        message_count: 1,
        storage: "other",
      };
    };

    await runDetailCommand({
      session: "codex:cx-900",
      config: baseConfig,
      getSession,
    });

    expect(received).toEqual({ agent: "codex", alias: "work", id: "cx-900" });
  });

  test("alias inference errors when ambiguous", async () => {
    const config: Config = {
      agents: [
        { agent: "codex", alias: "work", enabled: true },
        { agent: "codex", alias: "play", enabled: true },
      ],
    };

    const result = await runDetailCommand({
      session: "codex:cx-100",
      config,
      getSession: makeDetailService(null),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Alias required for codex");
    expect(result.stderr).toContain("work");
    expect(result.stderr).toContain("play");
  });

  test("missing session returns labeled error and no stdout", async () => {
    const result = await runDetailCommand({
      session: "codex:work:cx-404",
      config: baseConfig,
      getSession: makeDetailService(null),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[codex:work]");
    expect(result.stderr).toContain("Session not found");
  });

  test("getSession errors are labeled and do not emit stdout", async () => {
    const result = await runDetailCommand({
      session: "codex:work:cx-500",
      config: baseConfig,
      getSession: async () => {
        throw new Error("read failed");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[codex:work]");
    expect(result.stderr).toContain("read failed");
  });
});
