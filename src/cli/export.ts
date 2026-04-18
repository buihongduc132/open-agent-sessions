import { AgentEntry, AgentKind, Config } from "../config/types";
import { SessionDetail, SessionReadOptions } from "../core/types";
import { toCsf, toMarkdown, toText } from "../core/export";
import { CliResult } from "./types";
import { errorResult, errorMessage, type ParseResult, wrapLargeOutput } from "./utils/config";
import {
  isAgentKind,
  formatList,
  validateAlias,
  unknownAgentError,
  withLabel,
  splitSpec,
} from "./utils/agents";

const USAGE = `Usage: oas export <session-ref> [options]
       oas export --from <agent:alias> --id <session-id> [options]

Options:
  --from SPEC       Session reference (agent:alias:session_id, alias:session_id, or session_id)
  --format FORMAT   Output format: csf (default), markdown, text
  --output FILE     Write output to file instead of stdout

Session ref formats:
  - session_id               Uses first enabled agent/alias from config
  - alias:session_id        Uses first agent with matching alias
  - agent:alias:session_id  Full format (explicit)

Output formats:
  csf       Canonical Session Format (structured JSON) — default
  markdown  Human-readable Markdown
  text      Plain text

Either <session-ref> positional or all of --from must be specified.`;

// ============================================================================
// Types
// ============================================================================

export type ExportService = (
  query: ExportQuery,
  options?: SessionReadOptions
) => Promise<SessionDetail | null>;

export type ExportQuery = {
  agent: string;
  alias: string;
  id: string;
};

export type ExportOptions = {
  /** Positional session-ref argument */
  sessionRef?: string;
  /** --from SPEC: agent:alias:session_id, alias:session_id, or session_id */
  from?: string;
  /** --format FORMAT: csf (default), markdown, text */
  format?: "csf" | "markdown" | "text";
  /** --output FILE: write to file instead of stdout */
  output?: string;
  config?: Config;
  getSession: ExportService;
};

// ============================================================================
// Main Command
// ============================================================================

export async function runExportCommand(options: ExportOptions): Promise<CliResult> {
  // Validate --format
  if (options.format !== undefined) {
    const validFormats = ["csf", "markdown", "text"];
    if (!validFormats.includes(options.format)) {
      return errorResult(
        `Invalid --format value: must be one of ${validFormats.join(", ")}.`
      );
    }
  }

  // Resolve config
  if (!options.config) {
    return errorResult(`Missing config. ${USAGE}`);
  }

  const enabledEntries = options.config.agents.filter((entry) => entry.enabled);

  if (enabledEntries.length === 0) {
    return errorResult("No enabled agents in config.");
  }

  // Resolve session target from --from or positional
  const spec = options.from ?? options.sessionRef;
  if (!spec) {
    return errorResult(`Missing session reference. ${USAGE}`);
  }

  const targetResult = parseSessionSpec(spec, enabledEntries);
  if (!targetResult.ok) {
    return errorResult(targetResult.error);
  }

  const target = targetResult.value;
  const format = options.format ?? "csf";

  // Fetch session detail
  let detail: SessionDetail | null;
  try {
    detail = await options.getSession(target, {});
  } catch (error) {
    return errorResult(withLabel(target, errorMessage(error)));
  }

  if (!detail) {
    return errorResult(withLabel(target, `Session not found: ${target.id}`));
  }

  // Format output
  let stdout: string;
  try {
    stdout = formatDetail(detail, format);
  } catch (error) {
    return errorResult(
      `Export format error: ${errorMessage(error)}`
    );
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
      return errorResult(
        `Failed to write to file: ${errorMessage(error)}`
      );
    }
  }

  // Warn if output is large
  return wrapLargeOutput(stdout);
}

// ============================================================================
// Session Spec Parsing
// ============================================================================

function parseSessionSpec(
  spec: string,
  entries: AgentEntry[]
): ParseResult<ExportQuery> {
  const parts = splitSpec(spec);

  // session_id only → infer agent + alias from first enabled entry
  if (parts.length === 1) {
    const entry = entries[0];
    return { ok: true, value: { agent: entry.agent, alias: entry.alias, id: parts[0] } };
  }

  // alias:session_id → infer agent from matching alias
  if (parts.length === 2) {
    const matchingEntry = entries.find((e) => e.alias === parts[0]);
    if (!matchingEntry) {
      const available = [...new Set(entries.map((e) => e.alias))].sort();
      return {
        ok: false,
        error: `Unknown alias "${parts[0]}". Available aliases: ${formatList(available)}`,
      };
    }
    return {
      ok: true,
      value: { agent: matchingEntry.agent, alias: parts[0], id: parts[1] },
    };
  }

  // agent:alias:session_id → full format
  if (parts.length === 3) {
    const agent = parts[0] as AgentKind;
    if (!isAgentKind(agent)) {
      return { ok: false, error: unknownAgentError(agent, entries) };
    }
    const aliasValidation = validateAlias(agent, parts[1], entries);
    if (!aliasValidation.ok) {
      return { ok: false, error: aliasValidation.error };
    }
    return { ok: true, value: { agent, alias: parts[1], id: parts[2] } };
  }

  return {
    ok: false,
    error: `Invalid session reference "${spec}". ${USAGE}`,
  };
}

// ============================================================================
// Formatting
// ============================================================================

function formatDetail(detail: SessionDetail, format: "csf" | "markdown" | "text"): string {
  switch (format) {
    case "csf":
      return JSON.stringify(toCsf(detail), null, 2) + "\n";
    case "markdown":
      return toMarkdown(detail) + "\n";
    case "text":
      return toText(detail) + "\n";
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

// Helpers: imported from ./utils/config and ./utils/agents
