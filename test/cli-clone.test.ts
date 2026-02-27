import { describe, expect, test } from "bun:test";
import { runCloneCommand } from "../src/cli/clone";
import { Config } from "../src/config/types";

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
    { agent: "claude", alias: "team", enabled: false },
  ],
};

describe("cli clone", () => {
  test("prints new destination id on success", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("oc-new");
    expect(result.stderr).toBe("");
  });

  test("unknown alias lists available aliases", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "opencode:unknown",
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown");
    expect(result.stderr).toContain("personal");
  });

  test("unsupported direction returns not supported", async () => {
    const result = await runCloneCommand({
      from: "opencode:oc-200",
      to: "codex:work",
      config: baseConfig,
      clone: async () => ({ destinationId: "cx-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("not supported");
  });

  test("clone errors are surfaced", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-404",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => {
        throw new Error("source session not found");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("source session not found");
  });

  test("invalid --from format shows usage", async () => {
    const result = await runCloneCommand({
      from: "codex",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });

  test("alias omission requires unambiguous config", async () => {
    const config: Config = {
      agents: [
        { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
        { agent: "codex", alias: "work", enabled: true },
        { agent: "codex", alias: "play", enabled: true },
      ],
    };

    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "opencode:personal",
      config,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Alias required");
    expect(result.stderr).toContain("work");
    expect(result.stderr).toContain("play");
  });
});
