/**
 * REQ-SIM-03: `oas similar` CLI command
 *
 * Finds sessions similar to the given session, ranked by hybrid similarity score.
 */

import type { AgentKind, Config } from "../config/types";
import type { SimilarSessionResult } from "../similarity/search";
import { CliResult } from "./types";

const USAGE = `Usage: oas similar <session-id> [options]

Options:
  --top N         Maximum results to return (default: 5)
  --format FORMAT  Output format: text (default) or json

Find sessions similar to the given session using hybrid similarity search
(sqlite-vec + FTS5). Results are ranked by Reciprocal Rank Fusion score.

Examples:
  oas similar abc123                    Find top 5 similar sessions
  oas similar abc123 --top 10          Find top 10 similar sessions
  oas similar abc123 --format json      Output as JSON`;

export type SimilarQuery = {
  agent: AgentKind;
  alias: string;
  id: string;
};

export type SimilarService = (
  query: SimilarQuery,
  topK?: number
) => Promise<SimilarSessionResult[]>;

export async function runSimilarCommand(options: {
  sessionId?: string;
  agent?: string;
  alias?: string;
  id?: string;
  top?: number;
  format?: "text" | "json";
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
  findSimilar: SimilarService;
}): Promise<CliResult> {
  // Resolve config
  const configResult = resolveConfig(options);
  if (!configResult.ok) {
    return errorResult(configResult.error);
  }

  const enabledEntries = configResult.value.agents.filter((e) => e.enabled);
  const targetResult = resolveTarget(options, enabledEntries);
  if (!targetResult.ok) {
    return errorResult(targetResult.error);
  }

  const target = targetResult.value;
  const topK = options.top ?? 5;

  let results: SimilarSessionResult[];
  try {
    results = await options.findSimilar(target, topK);
  } catch (error) {
    return errorResult(withLabel(target, errorMessage(error)));
  }

  if (results.length === 0) {
    return {
      exitCode: 0,
      stdout: `No similar sessions found for: ${target.id}\n`,
      stderr: "",
    };
  }

  const format = options.format ?? "text";
  if (format === "json") {
    const stdout = JSON.stringify(results, null, 2);
    return { exitCode: 0, stdout, stderr: "" };
  }

  // text format (default)
  const lines: string[] = [];
  lines.push(`Similar sessions for: ${target.id}`);
  lines.push(`Found ${results.length} similar session(s):`);
  lines.push("");

  for (const result of results) {
    const scoreStr = result.score.toFixed(4);
    const matchTypeStr = result.matchType.padEnd(12);
    const chunksStr = String(result.matchedChunks).padStart(4);
    lines.push(
      `  [rank ${result.rank}] ${matchTypeStr}  score=${scoreStr}  chunks=${chunksStr}  ${result.title || result.sessionId}`
    );
    lines.push(`              session_id: ${result.sessionId}`);
    lines.push("");
  }

  return {
    exitCode: 0,
    stdout: lines.join("\n") + "\n",
    stderr: "",
  };
}

// ─── Config Resolution ─────────────────────────────────────────────────────────

type ConfigResult = { ok: true; value: Config } | { ok: false; error: string };

function resolveConfig(options: {
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
}): ConfigResult {
  if (options.config) return { ok: true, value: options.config };

  if (options.configPath && options.loadConfig) {
    try {
      return { ok: true, value: options.loadConfig(options.configPath) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  return { ok: false, error: `Missing config. ${USAGE}` };
}

// ─── Target Resolution ─────────────────────────────────────────────────────────

type Target = { agent: AgentKind; alias: string; id: string };

type TargetResult = { ok: true; value: Target } | { ok: false; error: string };

function resolveTarget(
  options: { sessionId?: string; agent?: string; alias?: string; id?: string },
  enabledEntries: Config["agents"]
): TargetResult {
  // Support positional session-id: `oas similar <session-id>`
  // or explicit agent/alias/id flags
  const sessionId =
    options.sessionId ?? options.id;

  if (!sessionId) {
    return { ok: false, error: `Missing session ID. ${USAGE}` };
  }

  // Use first opencode entry by default (OpenCode is the primary adapter for similarity)
  const opencodeEntry = enabledEntries.find((e) => e.agent === "opencode");
  if (!opencodeEntry) {
    return {
      ok: false,
      error: `No OpenCode agent configured. Similarity search requires OpenCode adapter.`
    };
  }

  return {
    ok: true,
    value: {
      agent: opencodeEntry.agent,
      alias: opencodeEntry.alias,
      id: sessionId,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function errorResult(message: string): CliResult {
  return { exitCode: 1, stdout: "", stderr: `${message}\n` };
}

function withLabel(target: Target, message: string): string {
  const label = `[${target.agent}:${target.alias}]`;
  return message.includes(label) ? message : `${label} ${message}`;
}