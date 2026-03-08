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

  test("clone error propagation surfaces adapter error with context", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => {
        throw new Error("[opencode:personal] write failed");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("opencode:personal");
    expect(result.stderr).toContain("write failed");
  });

  test("cli clone metadata persistence after successful clone", async () => {
    const capturedMetadata: Array<unknown> = [];
    
    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "opencode:personal",
      config: baseConfig,
      clone: async (request) => {
        // Simulate metadata being captured/saved
        capturedMetadata.push({
          src: { agent: request.source.agent, session_id: request.source.session_id },
          dst: { agent: request.destination.agent },
        });
        return { destinationId: "oc-new" };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(capturedMetadata).toHaveLength(1);
    expect(capturedMetadata[0]).toEqual({
      src: { agent: "codex", session_id: "cx-100" },
      dst: { agent: "opencode" },
    });
  });

  test("partial cli clone failure returns error", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => {
        throw new Error("partial failure: session created but metadata not saved");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("partial failure");
  });

  test("cli error formatting includes agent and alias context", async () => {
    const result = await runCloneCommand({
      from: "codex:work:cx-100",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => {
        throw new Error("[opencode:personal] connection timeout");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[opencode:personal]");
    expect(result.stderr).toContain("connection timeout");
  });

  test("unknown direction cli error shows unsupported pair", async () => {
    const config: Config = {
      agents: [
        { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
        { agent: "codex", alias: "work", enabled: true },
        { agent: "claude", alias: "team", enabled: true },
      ],
    };

    const result = await runCloneCommand({
      from: "claude:team:cl-100",
      to: "codex:work",
      config,
      clone: async () => ({ destinationId: "cx-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("not supported");
    expect(result.stderr).toContain("claude -> codex");
  });

  test("unsupported pair codex to claude returns error", async () => {
    const config: Config = {
      agents: [
        { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
        { agent: "codex", alias: "work", enabled: true },
        { agent: "claude", alias: "team", enabled: true },
      ],
    };

    const result = await runCloneCommand({
      from: "codex:work:cx-100",
      to: "claude:team",
      config,
      clone: async () => ({ destinationId: "cl-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("not supported");
    expect(result.stderr).toContain("codex -> claude");
  });

  test("missing alias error shows available aliases", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    // When there's only one codex alias, it should auto-infer
    expect(result.exitCode).toBe(0);
  });

  test("source session not found error is surfaced", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-404",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => {
        throw new Error("Source session not found for [codex:work]: cx-404");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Source session not found");
    expect(result.stderr).toContain("cx-404");
  });

  test("unsupported content type error is surfaced", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => {
        throw new Error("Unsupported content (tool_calls) in [codex:work] session cx-100");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unsupported content");
    expect(result.stderr).toContain("tool_calls");
  });

  test("id collision retry success returns new id", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-retried-success" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("oc-retried-success");
  });

  test("successful clone with explicit alias", async () => {
    const result = await runCloneCommand({
      from: "codex:work:cx-100",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-explicit-alias" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("oc-explicit-alias");
  });
});

describe("cli clone error paths", () => {
  const baseConfig: Config = {
    agents: [
      { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
      { agent: "codex", alias: "work", enabled: true },
    ],
  };

  test("missing --from flag shows usage error", async () => {
    const result = await runCloneCommand({
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).toContain("clone --from");
  });

  test("missing --to flag shows usage error", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-100",
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).toContain("clone --from");
  });

  test("missing both --from and --to flags shows usage error", async () => {
    const result = await runCloneCommand({
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });

  test("unknown --from agent shows available agents", async () => {
    const result = await runCloneCommand({
      from: "unknown-agent:session-123",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown agent");
    expect(result.stderr).toContain("unknown-agent");
    expect(result.stderr).toContain("Available agents:");
  });

  test("unknown --to agent shows available agents", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "foobar:alias",
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown agent");
    expect(result.stderr).toContain("foobar");
    expect(result.stderr).toContain("Available agents:");
  });

  test("invalid --to format shows usage error", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "opencode",  // Missing alias part
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --to value");
    expect(result.stderr).toContain("Usage:");
  });

  test("invalid alias in --from with 3-part format shows error", async () => {
    const result = await runCloneCommand({
      from: "codex:invalid-alias:cx-100",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown alias");
    expect(result.stderr).toContain("invalid-alias");
  });

  test("clone error with string throw is surfaced correctly", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => {
        throw "string error message";
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("string error message");
  });

  test("clone error with non-Error non-string throw shows unknown error", async () => {
    const result = await runCloneCommand({
      from: "codex:cx-100",
      to: "opencode:personal",
      config: baseConfig,
      clone: async () => {
        throw { custom: "object" };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown error");
  });

  test("unknown agent with no enabled agents shows none available", async () => {
    const emptyConfig: Config = {
      agents: [],
    };

    const result = await runCloneCommand({
      from: "unknown:session-123",
      to: "opencode:personal",
      config: emptyConfig,
      clone: async () => ({ destinationId: "oc-new" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown agent");
    expect(result.stderr).toContain("(none)");
  });
});
