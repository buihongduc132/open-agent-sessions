import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/types";
import {
  configPaths,
  DEFAULT_CONFIG,
  loadConfigFromFile,
  validateConfig,
} from "../config/index";
import { CliResult } from "./types";

/**
 * Resolve the list of searched config file paths by expanding `~` to the
 * real home directory and prepending the current working directory.
 */
export function resolvedConfigPaths(cwd: string): string[] {
  return configPaths.map((p) => {
    if (p.startsWith("~/")) {
      return join(homedir(), p.slice(2));
    }
    return join(cwd, p);
  });
}

// ─── runConfigCommand ─────────────────────────────────────────────────────────

/**
 * `oas config` — inspect, validate, or list the paths of the loaded config.
 *
 * @param args  Raw argument list after the `config` subcommand token.
 *              e.g.  ["--show"]  or  ["--validate"]  or  ["--paths"]
 * @param cwd   Current working directory (default: process.cwd()).
 *              Exposed so tests can pass a stable value.
 */
export async function runConfigCommand(
  args: string[],
  cwd = process.cwd()
): Promise<CliResult> {
  const raw = args[0] ?? "";

  switch (raw) {
    case "--show":
      return handleShow(cwd);

    case "--validate":
      return handleValidate(cwd);

    case "--paths":
      return handlePaths(cwd);

    case "--help":
    case "-h":
      return {
        exitCode: 0,
        stdout: USAGE + "\n",
        stderr: "",
      };

    default:
      if (raw.length > 0) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Unknown config subcommand: ${raw}\n\n${USAGE}\n`,
        };
      }
      return {
        exitCode: 0,
        stdout: USAGE + "\n",
        stderr: "",
      };
  }
}

// ─── --show ───────────────────────────────────────────────────────────────────

async function handleShow(cwd: string): Promise<CliResult> {
  const paths = resolvedConfigPaths(cwd);
  let loadedConfig: Config | null = null;
  let loadedFrom: string | null = null;

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        loadedConfig = loadConfigFromFile(path);
        loadedFrom = path;
        break;
      } catch {
        // File exists but is unreadable / invalid — report as a validation
        // error rather than silently falling through to the default.
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Error loading config from ${path}: ${errMessage(
            "YAML parse error"
          )}\n`,
        };
      }
    }
  }

  const config: Config = loadedConfig ?? { ...DEFAULT_CONFIG };
  const activeConfig = loadedConfig !== null;

  const lines: string[] = [];
  lines.push(
    `Configuration${loadedFrom ? ` (loaded from ${loadedFrom})` : " (defaults)"}`
  );
  lines.push("─".repeat(50));
  lines.push("");
  lines.push("Agents:");
  lines.push("");

  if (config.agents.length === 0) {
    lines.push("  (none)");
  } else {
    for (const entry of config.agents) {
      const status = entry.enabled ? "✓" : "✗";
      lines.push(
        `  ${status} ${entry.agent.padEnd(8)} ${entry.alias.padEnd(16)}`
      );
      if (entry.agent === "opencode") {
        const s = (entry as { storage?: { mode?: string; db_path?: string; jsonl_path?: string } })
          .storage;
        if (s) {
          lines.push(`      mode: ${s.mode ?? "auto"}`);
          if (s.db_path) lines.push(`      db_path: ${s.db_path}`);
          if (s.jsonl_path) lines.push(`      jsonl_path: ${s.jsonl_path}`);
        }
      }
    }
  }

  lines.push("");
  lines.push(`Total agents: ${config.agents.length}`);
  lines.push(
    `Enabled: ${config.agents.filter((e) => e.enabled).length} / ${config.agents.length}`
  );
  lines.push("");

  return {
    exitCode: activeConfig ? 0 : 0,
    stdout: lines.join("\n") + "\n",
    stderr: "",
  };
}

// ─── --validate ───────────────────────────────────────────────────────────────

async function handleValidate(cwd: string): Promise<CliResult> {
  const paths = resolvedConfigPaths(cwd);
  let hasConfigFile = false;
  let errors: string[] = [];

  for (const path of paths) {
    if (existsSync(path)) {
      hasConfigFile = true;
      try {
        const config = loadConfigFromFile(path);
        // validateConfig is already called inside loadConfigFromFile, but
        // run it again with a known-good parse to surface any structural
        // issues clearly.
        validateConfig(config);
      } catch (error) {
        errors.push(`${path}: ${errMessage(error)}`);
      }
    }
  }

  if (!hasConfigFile) {
    return {
      exitCode: 0,
      stdout: "No config file found — using defaults (valid).\n",
      stderr: "",
    };
  }

  if (errors.length > 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Config validation errors:\n\n" + errors.join("\n") + "\n",
    };
  }

  return {
    exitCode: 0,
    stdout: "Config is valid.\n",
    stderr: "",
  };
}

// ─── --paths ─────────────────────────────────────────────────────────────────

async function handlePaths(cwd: string): Promise<CliResult> {
  const paths = resolvedConfigPaths(cwd);
  const checked: string[] = [];

  for (const path of paths) {
    const exists = existsSync(path);
    checked.push(`${exists ? "[found] " : "[not found]"} ${path}`);
  }

  const lines = [
    "Config file search order (first match wins):",
    "",
    ...checked,
    "",
    `Current working directory: ${cwd}`,
  ];

  return {
    exitCode: 0,
    stdout: lines.join("\n") + "\n",
    stderr: "",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const USAGE = `Usage: oas config [subcommand]
Inspect, validate, or list config file paths.

Subcommands:
  oas config --show      Print the current merged config (agents, paths, etc.)
  oas config --validate  Validate the config file and print any errors
  oas config --paths     Print all config file paths that would be searched

Run without a subcommand to show this help.`;

function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
