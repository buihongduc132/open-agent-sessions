import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfigFromFile,
  parseConfigText,
  resolveOpenCodeStorage,
} from "../src/index";

function tempPath(): string {
  return mkdtempSync(join(tmpdir(), "oas-config-"));
}

describe("config loader", () => {
  test("empty file yields empty config", () => {
    const config = parseConfigText("\n\n");
    expect(config.agents).toEqual([]);
  });

  test("null YAML yields empty config", () => {
    const config = parseConfigText("null\n");
    expect(config.agents).toEqual([]);
  });

  test("top-level list is rejected", () => {
    expect(() => parseConfigText("- opencode\n")).toThrow(
      /top-level must be a mapping/i
    );
  });

  test("top-level scalar is rejected", () => {
    expect(() => parseConfigText("opencode\n")).toThrow(
      /top-level must be a mapping/i
    );
  });

  test("missing agents yields empty config", () => {
    const config = parseConfigText("foo: bar\n");
    expect(config.agents).toEqual([]);
  });

  test("agents must be a list", () => {
    expect(() => parseConfigText("agents: {}\n")).toThrow(/agents.*list/i);
  });

  test("enabled defaults to true", () => {
    const config = parseConfigText(`agents:\n  - agent: codex\n    alias: work\n`);
    expect(config.agents[0].enabled).toBe(true);
  });

  test("enabled must be boolean", () => {
    expect(() =>
      parseConfigText(`agents:\n  - agent: codex\n    alias: work\n    enabled: "yes"\n`)
    ).toThrow(/enabled must be a boolean/i);
  });

  test("agent entries must be mappings", () => {
    expect(() => parseConfigText(`agents:\n  - codex\n`)).toThrow(
      /agent entry must be a mapping/i
    );
  });

  test("agent is required", () => {
    expect(() =>
      parseConfigText(`agents:\n  - alias: work\n`)
    ).toThrow(/agent must be one of/i);
  });

  test("alias is required", () => {
    expect(() =>
      parseConfigText(`agents:\n  - agent: codex\n`)
    ).toThrow(/alias must be a non-empty string/i);
  });

  test("alias must be non-empty", () => {
    expect(() =>
      parseConfigText(`agents:\n  - agent: codex\n    alias: ""\n`)
    ).toThrow(/alias must be non-empty/i);
  });

  test("agent entries are validated and sorted", () => {
    const config = parseConfigText(`agents:\n  - agent: codex\n    alias: work\n  - agent: opencode\n    alias: alpha\n    enabled: false\n`);
    expect(config.agents.length).toBe(2);
    expect(config.agents[0].agent).toBe("opencode");
    expect(config.agents[0].alias).toBe("alpha");
    expect(config.agents[0].enabled).toBe(false);
    expect(config.agents[1].agent).toBe("codex");
  });

  test("non-opencode entries allow extra keys", () => {
    const config = parseConfigText(
      `agents:\n  - agent: codex\n    alias: work\n    path: /tmp/codex\n    note: extra\n`
    );
    const entry = config.agents[0] as Record<string, unknown>;
    expect(entry.path).toBe("/tmp/codex");
    expect(entry.note).toBe("extra");
  });

  test("alias whitespace is rejected", () => {
    expect(() =>
      parseConfigText(`agents:\n  - agent: codex\n    alias: " work"\n`)
    ).toThrow(/whitespace/i);
  });

  test("unknown agent is rejected", () => {
    expect(() =>
      parseConfigText(`agents:\n  - agent: other\n    alias: work\n`)
    ).toThrow(/agent must be one of/i);
  });

  test("duplicate alias is rejected", () => {
    expect(() =>
      parseConfigText(`agents:\n  - agent: codex\n    alias: work\n  - agent: opencode\n    alias: work\n`)
    ).toThrow(/duplicate alias/i);
  });

  test("storage validation rejects invalid mode", () => {
    expect(() =>
      parseConfigText(`agents:\n  - agent: opencode\n    alias: main\n    storage:\n      mode: bad\n`)
    ).toThrow(/storage\.mode/i);
  });

  test("storage defaults to auto when omitted", () => {
    const config = parseConfigText(`agents:\n  - agent: opencode\n    alias: main\n`);
    expect(config.agents[0].agent).toBe("opencode");
    expect((config.agents[0] as any).storage?.mode).toBe("auto");
  });

  test("storage validation rejects empty paths", () => {
    expect(() =>
      parseConfigText(`agents:\n  - agent: opencode\n    alias: main\n    storage:\n      db_path: ""\n`)
    ).toThrow(/storage\.db_path/i);
  });

  test("storage validation rejects empty jsonl_path", () => {
    expect(() =>
      parseConfigText(`agents:\n  - agent: opencode\n    alias: main\n    storage:\n      jsonl_path: "  "\n`)
    ).toThrow(/storage\.jsonl_path/i);
  });

  test("duplicate YAML keys are rejected", () => {
    expect(() => parseConfigText("agents: []\nagents: []\n")).toThrow(
      /duplicate/i
    );
  });

  test("missing config file path includes path", () => {
    const missingPath = join(tempPath(), "missing.yml");
    expect(() => loadConfigFromFile(missingPath)).toThrow(missingPath);
  });

  test("config path must be a file", () => {
    const dir = tempPath();
    expect(() => loadConfigFromFile(dir)).toThrow(dir);
  });

  test("entry context appears in validation errors", () => {
    expect(() =>
      parseConfigText(`agents:\n  - agent: codex\n    alias: work\n    enabled: nope\n`)
    ).toThrow(/agents\[0\].*codex:work/i);
  });

  test("invalid YAML includes source path", () => {
    const dir = tempPath();
    const filePath = join(dir, "bad.yml");
    writeFileSync(filePath, "agents: [\n", "utf8");
    expect(() => loadConfigFromFile(filePath)).toThrow(filePath);
  });

  test("invalid YAML includes line/column when available", () => {
    const err = () => parseConfigText("agents: [\n");
    expect(err).toThrow(/line/i);
  });
});

describe("open code storage resolution", () => {
  test("auto prefers db when both exist", () => {
    const entry = {
      agent: "opencode",
      alias: "main",
      enabled: true,
      storage: { mode: "auto" },
    } as const;
    const resolved = resolveOpenCodeStorage(
      entry,
      { dbPath: "/db", jsonlPath: "/jsonl" },
      { exists: (path) => path === "/db" || path === "/jsonl" }
    );
    expect(resolved.mode).toBe("db");
    expect(resolved.path).toBe("/db");
  });

  test("auto falls back to jsonl", () => {
    const entry = {
      agent: "opencode",
      alias: "main",
      enabled: true,
      storage: { mode: "auto" },
    } as const;
    const resolved = resolveOpenCodeStorage(
      entry,
      { dbPath: "/db", jsonlPath: "/jsonl" },
      { exists: (path) => path === "/jsonl" }
    );
    expect(resolved.mode).toBe("jsonl");
    expect(resolved.path).toBe("/jsonl");
  });

  test("auto errors when both missing", () => {
    const entry = {
      agent: "opencode",
      alias: "main",
      enabled: true,
      storage: { mode: "auto" },
    } as const;
    expect(() =>
      resolveOpenCodeStorage(
        entry,
        { dbPath: "/db", jsonlPath: "/jsonl" },
        { exists: () => false }
      )
    ).toThrow(/storage not found.*\/db.*\/jsonl/i);
  });

  test("db mode requires db", () => {
    const entry = {
      agent: "opencode",
      alias: "main",
      enabled: true,
      storage: { mode: "db" },
    } as const;
    expect(() =>
      resolveOpenCodeStorage(
        entry,
        { dbPath: "/db", jsonlPath: "/jsonl" },
        { exists: (path) => path === "/jsonl" }
      )
    ).toThrow(/DB not found/i);
  });

  test("db mode uses db when both exist", () => {
    const entry = {
      agent: "opencode",
      alias: "main",
      enabled: true,
      storage: { mode: "db" },
    } as const;
    const resolved = resolveOpenCodeStorage(
      entry,
      { dbPath: "/db", jsonlPath: "/jsonl" },
      { exists: () => true }
    );
    expect(resolved.mode).toBe("db");
    expect(resolved.path).toBe("/db");
  });

  test("jsonl mode requires jsonl", () => {
    const entry = {
      agent: "opencode",
      alias: "main",
      enabled: true,
      storage: { mode: "jsonl" },
    } as const;
    expect(() =>
      resolveOpenCodeStorage(
        entry,
        { dbPath: "/db", jsonlPath: "/jsonl" },
        { exists: (path) => path === "/db" }
      )
    ).toThrow(/JSONL not found/i);
  });

  test("jsonl mode uses jsonl when both exist", () => {
    const entry = {
      agent: "opencode",
      alias: "main",
      enabled: true,
      storage: { mode: "jsonl" },
    } as const;
    const resolved = resolveOpenCodeStorage(
      entry,
      { dbPath: "/db", jsonlPath: "/jsonl" },
      { exists: () => true }
    );
    expect(resolved.mode).toBe("jsonl");
    expect(resolved.path).toBe("/jsonl");
  });
});
