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

describe("CLI clone: coverage boost", () => {
  describe("missing required arguments", () => {
    test("missing --from shows usage", async () => {
      const result = await runCloneCommand({
        to: "opencode:personal",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Usage:");
    });

    test("missing --to shows usage", async () => {
      const result = await runCloneCommand({
        from: "codex:cx-100",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Usage:");
    });

    test("missing both --from and --to shows usage", async () => {
      const result = await runCloneCommand({
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Usage:");
    });
  });

  describe("unknown agent errors", () => {
    test("unknown agent in --from", async () => {
      const result = await runCloneCommand({
        from: "unknown:cx-100",
        to: "opencode:personal",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown agent");
      expect(result.stderr).toContain("unknown");
      expect(result.stderr).toContain("opencode");
      expect(result.stderr).toContain("codex");
    });

    test("unknown agent in --to", async () => {
      const result = await runCloneCommand({
        from: "codex:cx-100",
        to: "unknown:personal",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown agent");
      expect(result.stderr).toContain("unknown");
    });
  });

  describe("alias validation in --from with 3-part spec", () => {
    test("valid 3-part spec with correct alias", async () => {
      const result = await runCloneCommand({
        from: "codex:work:cx-100",
        to: "opencode:personal",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("oc-new");
    });

    test("invalid alias in 3-part spec", async () => {
      const result = await runCloneCommand({
        from: "codex:invalid:cx-100",
        to: "opencode:personal",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown alias");
      expect(result.stderr).toContain("invalid");
      expect(result.stderr).toContain("work");
    });

    test("2-part spec with single alias succeeds", async () => {
      const result = await runCloneCommand({
        from: "codex:cx-100",
        to: "opencode:personal",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("oc-new");
    });
  });

  describe("invalid --to format", () => {
    test("--to with 3 parts shows error", async () => {
      const result = await runCloneCommand({
        from: "codex:cx-100",
        to: "opencode:personal:extra",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --to value");
    });

    test("--to with 1 part shows error", async () => {
      const result = await runCloneCommand({
        from: "codex:cx-100",
        to: "opencode",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --to value");
    });
  });

  describe("unknown agent in --to", () => {
    test("non-existent agent in --to", async () => {
      const result = await runCloneCommand({
        from: "codex:cx-100",
        to: "nonexistent:alias",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown agent");
      expect(result.stderr).toContain("nonexistent");
    });
  });

  describe("inferAlias edge cases", () => {
    test("no enabled agents shows (none)", async () => {
      const config: Config = {
        agents: [
          { agent: "codex", alias: "work", enabled: false },
        ],
      };

      const result = await runCloneCommand({
        from: "codex:cx-100",
        to: "opencode:personal",
        config,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("(none)");
    });
  });

  describe("formatList with empty array", () => {
    test("empty alias list shows (none)", async () => {
      const config: Config = {
        agents: [
          { agent: "codex", alias: "work", enabled: false },
          { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
        ],
      };

      const result = await runCloneCommand({
        from: "codex:invalid:cx-100",
        to: "opencode:personal",
        config,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("(none)");
    });
  });

  describe("errorMessage edge cases", () => {
    test("clone service throws string error", async () => {
      const result = await runCloneCommand({
        from: "codex:cx-100",
        to: "opencode:personal",
        config: baseConfig,
        clone: async () => {
          throw "String error from clone service";
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("String error from clone service");
    });

    test("clone service throws unknown error type", async () => {
      const result = await runCloneCommand({
        from: "codex:cx-100",
        to: "opencode:personal",
        config: baseConfig,
        clone: async () => {
          throw { code: "INTERNAL_ERROR", details: "Something went wrong" };
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown error");
    });

    test("clone service throws Error instance", async () => {
      const result = await runCloneCommand({
        from: "codex:cx-100",
        to: "opencode:personal",
        config: baseConfig,
        clone: async () => {
          throw new Error("Standard error message");
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Standard error message");
    });
  });

  describe("splitSpec edge cases", () => {
    test("splitSpec filters empty segments", async () => {
      const result = await runCloneCommand({
        from: "codex::cx-100",
        to: "opencode:personal",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("oc-new");
    });

    test("splitSpec with trailing colon", async () => {
      let receivedRequest: any;
      
      const result = await runCloneCommand({
        from: "codex:work:",
        to: "opencode:personal",
        config: baseConfig,
        clone: async (req) => {
          receivedRequest = req;
          return { destinationId: "oc-new" };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(receivedRequest.source.session_id).toBe("work");
      expect(receivedRequest.source.alias).toBe("work");
    });

    test("splitSpec with leading colon", async () => {
      const result = await runCloneCommand({
        from: ":work:cx-100",
        to: "opencode:personal",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
    });
  });

  describe("clone direction validation", () => {
    test("unsupported direction: opencode -> codex", async () => {
      const result = await runCloneCommand({
        from: "opencode:personal:oc-200",
        to: "codex:work",
        config: baseConfig,
        clone: async () => ({ destinationId: "cx-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not supported");
      expect(result.stderr).toContain("opencode -> codex");
    });

    test("unsupported direction: claude -> opencode", async () => {
      const config: Config = {
        agents: [
          { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
          { agent: "claude", alias: "team", enabled: true },
        ],
      };

      const result = await runCloneCommand({
        from: "claude:team:cl-100",
        to: "opencode:personal",
        config,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not supported");
      expect(result.stderr).toContain("claude -> opencode");
    });

    test("valid clone with correct direction", async () => {
      const result = await runCloneCommand({
        from: "codex:work:cx-100",
        to: "opencode:personal",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new-123" }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("oc-new-123");
      expect(result.stderr).toBe("");
    });
  });

  describe("destination alias validation", () => {
    test("destination alias validation", async () => {
      const result = await runCloneCommand({
        from: "codex:cx-100",
        to: "opencode:invalid-alias",
        config: baseConfig,
        clone: async () => ({ destinationId: "oc-new" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown alias");
      expect(result.stderr).toContain("invalid-alias");
      expect(result.stderr).toContain("personal");
    });
  });

  describe("integration scenarios", () => {
    test("full clone workflow with 2-part spec", async () => {
      let receivedRequest: any;
      
      const result = await runCloneCommand({
        from: "codex:cx-100",
        to: "opencode:personal",
        config: baseConfig,
        clone: async (req) => {
          receivedRequest = req;
          return { destinationId: "oc-cloned-123" };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("oc-cloned-123");
      expect(receivedRequest.source.agent).toBe("codex");
      expect(receivedRequest.source.alias).toBe("work");
      expect(receivedRequest.source.session_id).toBe("cx-100");
      expect(receivedRequest.destination.agent).toBe("opencode");
      expect(receivedRequest.destination.alias).toBe("personal");
    });

    test("full clone workflow with 3-part spec", async () => {
      let receivedRequest: any;
      
      const result = await runCloneCommand({
        from: "codex:work:cx-200",
        to: "opencode:personal",
        config: baseConfig,
        clone: async (req) => {
          receivedRequest = req;
          return { destinationId: "oc-cloned-456" };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("oc-cloned-456");
      expect(receivedRequest.source.agent).toBe("codex");
      expect(receivedRequest.source.alias).toBe("work");
      expect(receivedRequest.source.session_id).toBe("cx-200");
    });

    test("disabled agent is not available", async () => {
      const config: Config = {
        agents: [
          { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
          { agent: "codex", alias: "work", enabled: false },
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
    });
  });
});
