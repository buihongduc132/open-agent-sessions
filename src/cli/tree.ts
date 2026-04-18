/**
 * src/cli/tree.ts
 *
 * Implements `oas tree <session-id>` — shows the full fork chain from root to leaf.
 *
 * Outputs:
 *   - Session IDs, titles, agent:alias for each node in the chain
 *   - Depth indentation (root = least indented, leaf = most)
 *   - Monotonically increasing indentation
 *   - JSON format output when format="json" is specified
 *
 * Handles:
 *   - Single-node chains (root sessions)
 *   - Empty chains (session not found → exitCode 1)
 *   - Circular references (graceful handling, no crash)
 *   - JSON output format
 */

import { Config } from "../config/types";
import { CliResult } from "./types";
import type { ForkChainNode } from "../core/subagents";
import { formatSessionRowSimple } from "./formatters/text";
import { errorMessage } from "./utils/config";

export type TreeService = (sessionId: string) => Promise<ForkChainNode[]>;

export interface TreeOptions {
  session: string;
  format?: "text" | "json";
  config?: Config;
  getForkChain: TreeService;
}

export async function runTreeCommand(options: TreeOptions): Promise<CliResult> {
  // Resolve config (required for full command, optional for testing)
  const config = options.config;

  let chain: ForkChainNode[];
  try {
    chain = await options.getForkChain(options.session);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error fetching fork chain for ${options.session}: ${errorMessage(error)}\n`,
    };
  }

  if (chain.length === 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Session not found: ${options.session}\n`,
    };
  }

  if (options.format === "json") {
    // JSON format preserves all chain entries including cycles —
    // consumers detect cycles themselves
    const output = JSON.stringify(chain, null, 2) + "\n";
    return { exitCode: 0, stdout: output, stderr: "" };
  }

  // Text format — deduplicate circular references, one line per node with depth indentation
  const seen = new Set<string>();
  const deduped: ForkChainNode[] = [];
  for (const node of chain) {
    if (!seen.has(node.sessionId)) {
      seen.add(node.sessionId);
      deduped.push(node);
    }
  }

  const lines: string[] = [];
  for (const node of deduped) {
    const indent = "  ".repeat(node.depth);
    const row = formatSessionRowSimple({
      agent: node.agent,
      alias: node.alias,
      id: node.sessionId,
      title: node.title ?? "",
    });
    lines.push(`${indent}${row}`);
  }

  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}