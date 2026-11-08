/**
 * REQ-SIM-03: `oas similar` CLI command
 *
 * Finds sessions similar to the given session, ranked by hybrid similarity score.
 */

import type { AgentKind, Config } from "../config/types";
import type { SimilarSessionResult } from "../similarity/search";
import { CliResult } from "./types";
import { resolveConfig, errorResult, errorMessage } from "./utils/config";
import { withLabel, isAgentKind } from "./utils/agents";
import { isCapabilityUnsupported, CAPABILITY_UNSUPPORTED_EXIT } from "../core/errors";

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

/**
 * BUG-7: Probes the enabled adapters to find which one actually owns a
 * session id. Returns the owning agent+alias, or undefined when the id
 * resolves nowhere. Injected by the CLI entrypoint (registry-backed).
 */
export type SimilarOwnerResolver = (
  sessionId: string
) => Promise<{ agent: AgentKind; alias: string } | undefined>;

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
  resolveSessionOwner?: SimilarOwnerResolver;
}): Promise<CliResult> {
  // Resolve config
  const configResult = resolveConfig(options, USAGE);
  if (!configResult.ok) {
    return errorResult(configResult.error);
  }

  const enabledEntries = configResult.value.agents.filter((e) => e.enabled);
  const targetResult = await resolveTarget(options, enabledEntries, options.resolveSessionOwner);
  if (!targetResult.ok) {
    return errorResult(targetResult.error);
  }

  const target = targetResult.value;
  const topK = options.top ?? 5;

  let results: SimilarSessionResult[];
  try {
    results = await options.findSimilar(target, topK);
  } catch (error) {
    if (isCapabilityUnsupported(error)) {
      return {
        exitCode: CAPABILITY_UNSUPPORTED_EXIT,
        stdout: "",
        stderr: withLabel(target, errorMessage(error)) + "\n",
      };
    }
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

// Config/target resolution: imported from ./utils/config and ./utils/agents

// ─── Target Resolution ─────────────────────────────────────────────────────────

type Target = { agent: AgentKind; alias: string; id: string };

type TargetResult = { ok: true; value: Target } | { ok: false; error: string };

async function resolveTarget(
  options: { sessionId?: string; agent?: string; alias?: string; id?: string },
  enabledEntries: Config["agents"],
  resolveSessionOwner?: SimilarOwnerResolver
): Promise<TargetResult> {
  // Support positional session-id: `oas similar <session-id>`
  // or explicit agent/alias/id flags
  const sessionId =
    options.sessionId ?? options.id;

  if (!sessionId) {
    return { ok: false, error: `Missing session ID. ${USAGE}` };
  }

  const opencodeEntry = enabledEntries.find((e) => e.agent === "opencode");

  // BUG-7: an explicit agent/alias wins — never silently reroute to opencode.
  if (options.agent?.trim()) {
    const agent = options.agent.trim();
    if (!isAgentKind(agent)) {
      return { ok: false, error: `Unknown agent "${agent}".` };
    }
    const entry = enabledEntries.find((e) => e.agent === agent);
    if (!entry) {
      return { ok: false, error: `Agent "${agent}" is not enabled in config.` };
    }
    const alias = options.alias?.trim() ?? entry.alias;
    const aliasEntry = enabledEntries.find((e) => e.agent === agent && e.alias === alias);
    if (!aliasEntry) {
      return { ok: false, error: `Unknown alias "${alias}" for ${agent}.` };
    }
    return { ok: true, value: { agent, alias: aliasEntry.alias, id: sessionId } };
  }

  // BUG-7: bare session-id — resolve the id against the enabled adapters so a
  // codex id routes to codex (instead of always erroring on opencode).
  // OpenCode stays the default ONLY when the id resolves nowhere or resolves
  // to opencode itself.
  if (resolveSessionOwner) {
    const owner = await resolveSessionOwner(sessionId);
    if (owner) {
      return { ok: true, value: { agent: owner.agent, alias: owner.alias, id: sessionId } };
    }
    // Id resolves nowhere: prefer opencode (its error path is the historical
    // contract) — but only if opencode is configured at all.
    if (opencodeEntry) {
      return {
        ok: true,
        value: { agent: opencodeEntry.agent, alias: opencodeEntry.alias, id: sessionId },
      };
    }
    return {
      ok: false,
      error: `Session not found in any configured agent: ${sessionId}`,
    };
  }

  // No owner resolver injected (unit tests / legacy callers): keep the
  // opencode-first fallback so existing behavior is unchanged.
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

// Helpers: imported from ./utils/config and ./utils/agents