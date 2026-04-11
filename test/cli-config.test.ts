import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigCommand, resolvedConfigPaths } from "../src/cli/config";
import { configPaths, DEFAULT_CONFIG } from "../src/config/index";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "oas-cli-config-"));
}

// ─── resolvedConfigPaths ─────────────────────────────────────────────────────

describe("resolvedConfigPaths", () => {
  test("expands ~/ paths to real home", () => {
    const cwd = "/project";
    const paths = resolvedConfigPaths(cwd);
    expect(paths[2]).toMatch(/^\/.*\.config\/oas\/config\.yaml$/);
    expect(paths[2].startsWith("/")).toBe(true);
    expect(paths[2].includes(".config/oas/")).toBe(true);
  });

  test("prepends cwd for relative paths", () => {
    const cwd = "/project";
    const paths = resolvedConfigPaths(cwd);
    expect(paths[0]).toBe(join(cwd, "oas.config.yaml"));
    expect(paths[1]).toBe(join(cwd, "oas.config.yml"));
  });

  test("returns same count as configPaths", () => {
    const paths = resolvedConfigPaths("/any");
    expect(paths.length).toBe(configPaths.length);
  });
});

// ─── runConfigCommand: --show ────────────────────────────────────────────────

describe("config --show", () => {
  test("shows default config when no config file exists", async () => {
    const tmp = makeTempDir();
    const result = await runConfigCommand(["--show"], tmp);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(defaults)");
    expect(result.stdout).toContain("Total agents:");
    rmSync(tmp, { recursive: true });
  });

  test("shows loaded config path when config file exists", async () => {
    const tmp = makeTempDir();
    const configPath = join(tmp, "oas.config.yaml");
    writeFileSync(
      configPath,
      `agents:\n  - agent: opencode\n    alias: personal\n    enabled: true\n    storage:\n      mode: auto\n`
    );

    const result = await runConfigCommand(["--show"], tmp);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("loaded from");
    expect(result.stdout).toContain(configPath);

    rmSync(tmp, { recursive: true });
  });

  test("prints all agents with status indicators", async () => {
    const tmp = makeTempDir();
    const configPath = join(tmp, "oas.config.yaml");
    writeFileSync(
      configPath,
      `agents:
  - agent: opencode
    alias: personal
    enabled: true
    storage:
      mode: auto
  - agent: codex
    alias: work
    enabled: false
`
    );

    const result = await runConfigCommand(["--show"], tmp);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ opencode personal");
    expect(result.stdout).toContain("✗ codex    work");
    expect(result.stdout).toContain("Enabled: 1 / 2");

    rmSync(tmp, { recursive: true });
  });

  test("shows storage mode for opencode agents", async () => {
    const tmp = makeTempDir();
    const configPath = join(tmp, "oas.config.yaml");
    writeFileSync(
      configPath,
      `agents:
  - agent: opencode
    alias: personal
    enabled: true
    storage:
      mode: db
      db_path: /custom/db/path.db
`
    );

    const result = await runConfigCommand(["--show"], tmp);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mode: db");
    expect(result.stdout).toContain("db_path: /custom/db/path.db");

    rmSync(tmp, { recursive: true });
  });

  test("reports load error when config file is unreadable", async () => {
    const tmp = makeTempDir();
    const configPath = join(tmp, "oas.config.yaml");
    writeFileSync(configPath, "agents:\n  - [invalid yaml\n");

    const result = await runConfigCommand(["--show"], tmp);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error loading config");
    expect(result.stderr).toContain(configPath);

    rmSync(tmp, { recursive: true });
  });
});

// ─── runConfigCommand: --validate ───────────────────────────────────────────

describe("config --validate", () => {
  test("returns valid when no config file exists", async () => {
    const tmp = makeTempDir();
    const result = await runConfigCommand(["--validate"], tmp);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No config file found");
    rmSync(tmp, { recursive: true });
  });

  test("returns valid when config file is well-formed", async () => {
    const tmp = makeTempDir();
    const configPath = join(tmp, "oas.config.yaml");
    writeFileSync(
      configPath,
      `agents:
  - agent: opencode
    alias: personal
    enabled: true
    storage:
      mode: auto
`
    );

    const result = await runConfigCommand(["--validate"], tmp);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("valid");

    rmSync(tmp, { recursive: true });
  });

  test("returns error for invalid YAML", async () => {
    const tmp = makeTempDir();
    const configPath = join(tmp, "oas.config.yaml");
    writeFileSync(configPath, "agents:\n  - [broken\n");

    const result = await runConfigCommand(["--validate"], tmp);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("YAML");
    expect(result.stderr).toContain(configPath);

    rmSync(tmp, { recursive: true });
  });

  test("returns error for duplicate agent aliases", async () => {
    const tmp = makeTempDir();
    const configPath = join(tmp, "oas.config.yaml");
    writeFileSync(
      configPath,
      `agents:
  - agent: opencode
    alias: personal
    enabled: true
    storage:
      mode: auto
  - agent: codex
    alias: personal
    enabled: true
`
    );

    const result = await runConfigCommand(["--validate"], tmp);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("duplicate alias");

    rmSync(tmp, { recursive: true });
  });
});

// ─── runConfigCommand: --paths ────────────────────────────────────────────────

describe("config --paths", () => {
  test("prints all paths with found/not-found markers", async () => {
    const tmp = makeTempDir();
    const result = await runConfigCommand(["--paths"], tmp);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[not found]");
    expect(result.stdout).toContain("oas.config.yaml");
    expect(result.stdout).toContain("oas.config.yml");
    expect(result.stdout).toMatch(/\.config\/oas\/config\.yaml/);
    expect(result.stdout).toContain("Current working directory:");
    rmSync(tmp, { recursive: true });
  });

  test("marks existing files as [found]", async () => {
    const tmp = makeTempDir();
    const configPath = join(tmp, "oas.config.yaml");
    writeFileSync(configPath, "agents: []\n");

    const result = await runConfigCommand(["--paths"], tmp);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\[\s*found\]\s*.*oas\.config\.yaml/);
    expect(result.stdout).toMatch(/\[not found\]/);

    rmSync(tmp, { recursive: true });
  });
});

// ─── runConfigCommand: --help / unknown ──────────────────────────────────────

describe("config help and unknown subcommands", () => {
  test("--help prints usage and exits 0", async () => {
    const result = await runConfigCommand(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: oas config");
    expect(result.stdout).toContain("--show");
    expect(result.stdout).toContain("--validate");
    expect(result.stdout).toContain("--paths");
  });

  test("-h prints usage and exits 0", async () => {
    const result = await runConfigCommand(["-h"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: oas config");
  });

  test("unknown subcommand returns exit 1 with error", async () => {
    const result = await runConfigCommand(["--badflag"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown config subcommand");
    expect(result.stderr).toContain("--badflag");
    expect(result.stderr).toContain("Usage: oas config");
  });

  test("no args prints usage and exits 0", async () => {
    const result = await runConfigCommand([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: oas config");
  });
});

// ─── DEFAULT_CONFIG and configPaths exports ──────────────────────────────────

describe("config module exports", () => {
  test("DEFAULT_CONFIG has expected shape", () => {
    expect(DEFAULT_CONFIG.agents).toBeDefined();
    expect(Array.isArray(DEFAULT_CONFIG.agents)).toBe(true);
    expect(DEFAULT_CONFIG.agents.length).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.agents[0]!.agent).toBe("opencode");
    expect(DEFAULT_CONFIG.agents[0]!.alias).toBe("default");
    expect(DEFAULT_CONFIG.agents[0]!.enabled).toBe(true);
  });

  test("configPaths has exactly 4 entries", () => {
    expect(configPaths).toHaveLength(4);
    expect(configPaths).toContain("oas.config.yaml");
    expect(configPaths).toContain("oas.config.yml");
    expect(configPaths).toContain("~/.config/oas/config.yaml");
    expect(configPaths).toContain("~/.config/oas/config.yml");
  });
});