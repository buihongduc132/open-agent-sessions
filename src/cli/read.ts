import { AgentEntry, AgentKind, Config } from "../config/types";
import {
  SessionDetail,
  MessageSelectionMode,
  MessageSelectionOptions,
  SessionReadOptions,
} from "../core/types";
import { CliResult } from "./types";
import {
  formatSessionDetail,
  formatSessionDetailJson,
  type TextFormatterOptions,
} from "./formatters/text";
import type { ReadQuery } from "./formatters/text";

// Re-export ReadQuery for external use
export type { ReadQuery };

const USAGE = `Usage: oas read --session <agent:alias:session_id> [options]
       oas read --agent <agent> --alias <alias> --id <session_id> [options]

Options:
  --session S     Session ID in format agent:alias:session_id
  --agent A       Agent type (opencode, codex, claude)
  --alias L       Agent alias
  --id I          Session ID
  --first N       First N messages
  --last N        Last N messages (default: 10)
  --all           All messages
  --range S:E     Message range (1-indexed, inclusive)
  --tools         Include tool messages (default: hide)
  --role R        Filter by role (user, assistant, system)
  --format F      Output format: text (default) or json
  --output FILE   Write output to file (recommended for large outputs)

Either --session or all of --agent, --alias, --id must be specified.
Only one of --first, --last, --all, --range may be specified.`;

// ============================================================================
// Types
// ============================================================================

export type ReadService = (
  query: ReadQuery,
  options: SessionReadOptions
) => Promise<SessionDetail | null>;

export type ReadOptions = {
  session?: string;
  agent?: string;
  alias?: string;
  id?: string;
  first?: number;
  last?: number;
  all?: boolean;
  range?: string;
  tools?: boolean;
  role?: string;
  format?: "text" | "json";
  output?: string;
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
  getSession: ReadService;
};

// ============================================================================
// Main Command
// ============================================================================

export async function runReadCommand(options: ReadOptions): Promise<CliResult> {
  // Validate --format is either "text" or "json" when provided
  if (options.format !== undefined) {
    if (options.format !== "text" && options.format !== "json") {
      return errorResult(`Invalid --format value: must be 'text' or 'json'.`);
    }
  }

  // Resolve config
  const configResult = resolveConfig(options);
  if (!configResult.ok) {
    return errorResult(configResult.error);
  }

  const enabledEntries = configResult.value.agents.filter((entry) => entry.enabled);

  // Resolve target (agent, alias, session id)
  const targetResult = resolveTarget(options, enabledEntries);
  if (!targetResult.ok) {
    return errorResult(targetResult.error);
  }

  const target = targetResult.value;

  // Parse message selection options
  const selectionResult = parseSelectionOptions(options);
  if (!selectionResult.ok) {
    return errorResult(selectionResult.error);
  }

  // Validate and parse role filter
  let role: "user" | "assistant" | "system" | undefined;
  if (options.role) {
    const validRoles = ["user", "assistant", "system"] as const;
    if (!validRoles.includes(options.role as typeof validRoles[number])) {
      return errorResult(
        `Invalid --role value: ${options.role}. Must be one of: ${validRoles.join(", ")}.`
      );
    }
    role = options.role as typeof validRoles[number];
  }

  // Build read options
  const readOptions: SessionReadOptions = {
    mode: options.tools ? "all_with_tools" : "all_no_tools",
    selection: selectionResult.value,
    role,
  };

  // Fetch session detail
  let detail: SessionDetail | null;
  try {
    detail = await options.getSession(target, readOptions);
  } catch (error) {
    return errorResult(withLabel(target, errorMessage(error)));
  }

  if (!detail) {
    return errorResult(withLabel(target, `Session not found: ${target.id}`));
  }

  // Format output
  const formatterOptions: TextFormatterOptions = {
    showTools: options.tools,
  };
  const stdout = options.format === "json"
    ? formatSessionDetailJson(detail, formatterOptions)
    : formatSessionDetail(detail, target, formatterOptions) + "\n";
  
  // Write to file if --output specified
  if (options.output) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const outputPath = path.resolve(options.output);
    try {
      fs.writeFileSync(outputPath, stdout, "utf-8");
      return {
        exitCode: 0,
        stdout: "",
        stderr: `Output written to: ${outputPath}\n`,
      };
    } catch (error) {
      return errorResult(`Failed to write to file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // Warn if output is large and might be truncated by subprocess buffer
  if (stdout.length > 60000) {
    const stderr = `Warning: Large output (${stdout.length} bytes). For reliable piping, use --output flag.\n`;
    return {
      exitCode: 0,
      stdout,
      stderr,
    };
  }
  
  return {
    exitCode: 0,
    stdout,
    stderr: "",
  };
}

// ============================================================================
// Config Resolution
// ============================================================================

type ConfigResult = { ok: true; value: Config } | { ok: false; error: string };

function resolveConfig(options: {
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
}): ConfigResult {
  if (options.config) {
    return { ok: true, value: options.config };
  }

  if (options.configPath && options.loadConfig) {
    try {
      return { ok: true, value: options.loadConfig(options.configPath) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  return { ok: false, error: `Missing config. ${USAGE}` };
}

// ============================================================================
// Target Resolution
// ============================================================================

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function resolveTarget(
  options: {
    session?: string;
    agent?: string;
    alias?: string;
    id?: string;
  },
  entries: AgentEntry[]
): ParseResult<ReadQuery> {
  if (options.session) {
    return parseSessionSpec(options.session, entries);
  }

  const agent = options.agent?.trim();
  const alias = options.alias?.trim();
  const id = options.id?.trim();

  if (!agent || !alias || !id) {
    return { ok: false, error: `Invalid arguments. ${USAGE}` };
  }

  return parseExplicitTarget(agent, alias, id, entries);
}

function parseSessionSpec(spec: string, entries: AgentEntry[]): ParseResult<ReadQuery> {
  const splitResult = splitSpec(spec);
  if (!splitResult.ok) {
    return { ok: false, error: splitResult.error };
  }
  const parts = splitResult.value;

  // AC8: Full session ID required (no short form in v1)
  // Must be exactly 3 parts: agent:alias:session_id
  if (parts.length !== 3) {
    return {
      ok: false,
      error: `Invalid --session value "${spec}". Full session ID required: agent:alias:session_id. ${USAGE}`,
    };
  }

  const agent = parts[0].trim() as AgentKind;
  if (!isAgentKind(agent) || !listAgents(entries).includes(agent)) {
    return { ok: false, error: unknownAgentError(agent, entries) };
  }

  const alias = parts[1].trim();
  const sessionId = parts[2].trim();

  const aliasValidation = validateAlias(agent, alias, entries);
  if (!aliasValidation.ok) {
    return { ok: false, error: aliasValidation.error };
  }

  return { ok: true, value: { agent, alias, id: sessionId } };
}

function parseExplicitTarget(
  agentValue: string,
  aliasValue: string,
  idValue: string,
  entries: AgentEntry[]
): ParseResult<ReadQuery> {
  const agent = agentValue as AgentKind;
  if (!isAgentKind(agent) || !listAgents(entries).includes(agent)) {
    return { ok: false, error: unknownAgentError(agent, entries) };
  }

  const aliasValidation = validateAlias(agent, aliasValue, entries);
  if (!aliasValidation.ok) {
    return { ok: false, error: aliasValidation.error };
  }

  return {
    ok: true,
    value: { agent, alias: aliasValue, id: idValue },
  };
}

function splitSpec(spec: string): ParseResult<string[]> {
  const parts = spec.split(":");
  if (parts.some((part) => part.trim().length === 0)) {
    return { ok: false, error: `Invalid --session value "${spec}". ${USAGE}` };
  }
  return { ok: true, value: parts };
}

// ============================================================================
// Selection Options Parsing
// ============================================================================

function parseSelectionOptions(
  options: ReadOptions
): ParseResult<MessageSelectionOptions> {
  // Count how many selection modes are specified
  const modes: string[] = [];
  if (options.first !== undefined) modes.push("--first");
  if (options.last !== undefined) modes.push("--last");
  if (options.all) modes.push("--all");
  if (options.range !== undefined) modes.push("--range");

  // AC6: Error on conflicting flags
  if (modes.length > 1) {
    return {
      ok: false,
      error: `Cannot use ${modes.join(" and ")} together. Choose one. ${USAGE}`,
    };
  }

  // AC1: Parse --first N
  if (options.first !== undefined) {
    if (typeof options.first !== "number" || isNaN(options.first)) {
      return {
        ok: false,
        error: `Invalid --first value: must be a number.`,
      };
    }
    if (options.first <= 0) {
      return {
        ok: false,
        error: `Invalid --first value: ${options.first}. Must be a positive number.`,
      };
    }
    return {
      ok: true,
      value: { mode: "first", count: options.first },
    };
  }

  // AC2: Parse --last N (default 10)
  if (options.last !== undefined) {
    if (typeof options.last !== "number" || isNaN(options.last)) {
      return {
        ok: false,
        error: `Invalid --last value: must be a number.`,
      };
    }
    if (options.last <= 0) {
      return {
        ok: false,
        error: `Invalid --last value: ${options.last}. Must be a positive number.`,
      };
    }
    return {
      ok: true,
      value: { mode: "last", count: options.last },
    };
  }

  // AC3: Parse --all
  if (options.all) {
    return {
      ok: true,
      value: { mode: "all" },
    };
  }

  // AC4: Parse --range START:END
  if (options.range !== undefined) {
    return parseRange(options.range);
  }

  // Default: last 10 messages
  return {
    ok: true,
    value: { mode: "last", count: 10 },
  };
}

function parseRange(rangeStr: string): ParseResult<MessageSelectionOptions> {
  const parts = rangeStr.split(":");
  if (parts.length !== 2) {
    return {
      ok: false,
      error: `Invalid --range format "${rangeStr}". Expected START:END (e.g., --range 1:10).`,
    };
  }

  const startStr = parts[0].trim();
  const endStr = parts[1].trim();

  if (!startStr || !endStr) {
    return {
      ok: false,
      error: `Invalid --range format "${rangeStr}". START and END must be non-empty.`,
    };
  }

  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);

  // AC7: Error on invalid ranges
  if (isNaN(start) || isNaN(end)) {
    return {
      ok: false,
      error: `Invalid --range values "${rangeStr}". START and END must be numbers.`,
    };
  }

  if (start <= 0) {
    return {
      ok: false,
      error: `Invalid --range: start (${start}) must be >= 1.`,
    };
  }

  if (end <= 0) {
    return {
      ok: false,
      error: `Invalid --range: end (${end}) must be >= 1.`,
    };
  }

  if (start > end) {
    return {
      ok: false,
      error: `Invalid --range: start (${start}) > end (${end}).`,
    };
  }

  return {
    ok: true,
    value: { mode: "range", start, end },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function validateAlias(
  agent: AgentKind,
  alias: string,
  entries: AgentEntry[]
): ParseResult<string> {
  const aliases = aliasesForAgent(agent, entries);
  if (!aliases.includes(alias)) {
    return {
      ok: false,
      error: `Unknown alias "${alias}" for ${agent}. Available aliases: ${formatList(aliases)}`,
    };
  }
  return { ok: true, value: alias };
}

function listAgents(entries: AgentEntry[]): AgentKind[] {
  const seen = new Set<AgentKind>();
  for (const entry of entries) {
    seen.add(entry.agent);
  }
  return Array.from(seen).sort(compareAgents);
}

function aliasesForAgent(agent: AgentKind, entries: AgentEntry[]): string[] {
  return entries
    .filter((entry) => entry.agent === agent)
    .map((entry) => entry.alias)
    .sort((a, b) => a.localeCompare(b));
}

function compareAgents(a: AgentKind, b: AgentKind): number {
  const order: Record<AgentKind, number> = {
    opencode: 0,
    codex: 1,
    claude: 2,
  };
  return order[a] - order[b];
}

function unknownAgentError(agent: string, entries: AgentEntry[]): string {
  const available = listAgents(entries);
  return `Unknown agent "${agent}". Available agents: ${formatList(available)}`;
}

function formatList(values: string[]): string {
  if (values.length === 0) {
    return "(none)";
  }
  return values.join(", ");
}

function normalizeTitle(title: string, id: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : id;
}

function withLabel(target: ReadQuery, message: string): string {
  const label = `[${target.agent}:${target.alias}]`;
  if (message.includes(label)) {
    return message;
  }
  return `${label} ${message}`;
}

function isAgentKind(agent: string): agent is AgentKind {
  return agent === "opencode" || agent === "codex" || agent === "claude";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

function errorResult(message: string): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${message}\n`,
  };
}
