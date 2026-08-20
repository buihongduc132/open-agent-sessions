import { AgentEntry, AgentKind, Config } from "../config/types";
import {
  SessionDetail,
  MessageSelectionMode,
  MessageSelectionOptions,
  SessionReadOptions,
} from "../core/types";
import { toCsf, toMarkdown, toText } from "../core/export";
import { CliResult } from "./types";
import {
  formatSessionDetail,
  formatSessionDetailJson,
  type TextFormatterOptions,
} from "./formatters/text";
import type { ReadQuery } from "./formatters/text";
import { resolveConfig, errorResult, errorMessage, type ParseResult, wrapLargeOutput } from "./utils/config";
import {
  isAgentKind,
  formatList,
  validateAlias,
  listAgents,
  aliasesForAgent,
  compareAgents,
  unknownAgentError,
  withLabel,
  normalizeTitle,
} from "./utils/agents";

// Re-export ReadQuery for external use
export type { ReadQuery };

const USAGE = `Usage: oas read --session <session_id> [options]
       oas read --agent <agent> --alias <alias> --id <session_id> [options]

Options:
  --session S     Session ID (supports short forms: session_id, alias:session_id, or agent:alias:session_id)
  --agent A       Agent type (opencode, codex, claude)
  --alias L       Agent alias
  --id I          Session ID
  --first N       First N messages
  --last N        Last N messages (default: 10)
  --all           All messages
  --range S:E     Message range (1-indexed, inclusive)
  --user-only     Show only user messages (composable with --first/--last/--all/--range)
  --tools         Include tool messages (default: hide)
  --verbose       Full detail output (default: compact conversation view)
  --role R        Filter by role (user, assistant, system)
  --format F      Output format: text (default), json, csf, markdown, md
  --output FILE   Write output to file (recommended for large outputs)

Session ID formats:
  - session_id              Uses first enabled agent/alias from config
  - alias:session_id        Uses first agent with matching alias
  - agent:alias:session_id  Full format (explicit)

Output formats:
  text      Plain text (default)
  json      Structured JSON
  csf       Canonical Session Format (JSON) — cross-agent transfer
  markdown  Human-readable Markdown (alias: md)

Either --session or all of --agent, --alias, --id must be specified.
One of --first, --last, --all, --range is required (--user-only is optional and additive).`;

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
  userOnly?: boolean;
  tools?: boolean;
  verbose?: boolean;
  role?: string;
  format?: "text" | "json" | "csf" | "markdown" | "md";
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
  // Validate --format is either "text", "json", "csf", "markdown", or "md" when provided
  if (options.format !== undefined) {
    const validFormats = ["text", "json", "csf", "markdown", "md"];
    if (!validFormats.includes(options.format)) {
      return errorResult(`Invalid --format value: must be one of: ${validFormats.join(", ")}.`);
    }
  }

  // Resolve config
  const configResult = resolveConfig(options, USAGE);
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
    userOnly: selectionResult.value.userOnly,
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

  // Format output (R-16: CSF, R-17: markdown/text)
  const formatterOptions: TextFormatterOptions = {
    showTools: options.tools,
    verbose: options.verbose,
  };
  let stdout: string;
  if (options.format === "json") {
    stdout = formatSessionDetailJson(detail, formatterOptions);
  } else if (options.format === "csf") {
    stdout = JSON.stringify(toCsf(detail), null, 2) + "\n";
  } else if (options.format === "markdown" || options.format === "md") {
    stdout = toMarkdown(detail) + "\n";
  } else if (options.format === "text") {
    stdout = toText(detail) + "\n";
  } else {
    // Default: text formatter (original behavior)
    stdout = formatSessionDetail(detail, target, formatterOptions) + "\n";
  }
  
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
      return errorResult(`Failed to write to file: ${errorMessage(error)}`);
    }
  }
  
  // Warn if output is large and might be truncated by subprocess buffer
  return wrapLargeOutput(stdout);
}

// Config resolution: imported from ./utils/config

// ============================================================================
// Target Resolution
// ============================================================================

// ParseResult: imported from ./utils/config

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

  // Support three formats:
  // 1. session_id (1 part) - infer agent/alias from config
  // 2. alias:session_id (2 parts) - infer agent from config
  // 3. agent:alias:session_id (3 parts) - full format
  
  if (parts.length === 1) {
    // Format: session_id - use first enabled agent/alias
    return resolveFromSessionIdOnly(parts[0], entries);
  }
  
  if (parts.length === 2) {
    // Format: alias:session_id - find agent with matching alias
    return resolveFromAliasSessionId(parts[0], parts[1], entries);
  }

  if (parts.length === 3) {
    // Format: agent:alias:session_id - full format
    return resolveFromFullSpec(parts[0], parts[1], parts[2], entries);
  }

  return {
    ok: false,
    error: `Invalid --session value "${spec}". Expected format: session_id, alias:session_id, or agent:alias:session_id. ${USAGE}`,
  };
}

/**
 * Resolve session_id only format.
 * Uses first enabled agent and its first alias from config.
 */
function resolveFromSessionIdOnly(sessionId: string, entries: AgentEntry[]): ParseResult<ReadQuery> {
  if (entries.length === 0) {
    return { ok: false, error: `No enabled agents in config. ${USAGE}` };
  }

  // Use first enabled entry
  const entry = entries[0];
  return { ok: true, value: { agent: entry.agent, alias: entry.alias, id: sessionId } };
}

/**
 * Resolve alias:session_id format.
 * Finds first agent with matching alias.
 */
function resolveFromAliasSessionId(alias: string, sessionId: string, entries: AgentEntry[]): ParseResult<ReadQuery> {
  const matchingEntry = entries.find((e) => e.alias === alias);
  
  if (!matchingEntry) {
    const availableAliases = [...new Set(entries.map((e) => e.alias))].sort();
    return {
      ok: false,
      error: `Unknown alias "${alias}". Available aliases: ${formatList(availableAliases)}`,
    };
  }

  return { ok: true, value: { agent: matchingEntry.agent, alias, id: sessionId } };
}

/**
 * Resolve full agent:alias:session_id format.
 */
function resolveFromFullSpec(agentStr: string, alias: string, sessionId: string, entries: AgentEntry[]): ParseResult<ReadQuery> {
  const agent = agentStr as AgentKind;
  if (!isAgentKind(agent) || !listAgents(entries).includes(agent)) {
    return { ok: false, error: unknownAgentError(agent, entries) };
  }

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
  // Count how many primary selection modes are specified
  const modes: string[] = [];
  if (options.first !== undefined) modes.push("--first");
  if (options.last !== undefined) modes.push("--last");
  if (options.all) modes.push("--all");
  if (options.range !== undefined) modes.push("--range");

  // AC6: Error on conflicting primary modes (--user-only is additive, not exclusive)
  if (modes.length > 1) {
    return {
      ok: false,
      error: `Cannot use ${modes.join(" and ")} together. Choose one. ${USAGE}`,
    };
  }

  // Determine userOnly (additive flag, not a selection mode)
  const userOnly = options.userOnly ? true : undefined;

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
      value: { mode: "first", count: options.first, userOnly },
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
      value: { mode: "last", count: options.last, userOnly },
    };
  }

  // AC3: Parse --all
  if (options.all) {
    return {
      ok: true,
      value: { mode: "all", userOnly },
    };
  }

  // AC4: Parse --range START:END
  if (options.range !== undefined) {
    return parseRange(options.range, userOnly);
  }

  // Parse --user-only alone — defaults to last 10 user messages
  if (options.userOnly) {
    return {
      ok: true,
      value: { mode: "last", count: 10, userOnly: true },
    };
  }

  // Default: last 10 messages
  return {
    ok: true,
    value: { mode: "last", count: 10 },
  };
}

function parseRange(rangeStr: string, userOnly?: boolean): ParseResult<MessageSelectionOptions> {
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
    value: { mode: "range", start, end, userOnly },
  };
}

// ============================================================================
// Helpers
// ============================================================================

// Helpers: imported from ./utils/config and ./utils/agents
