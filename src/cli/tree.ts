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
      stderr: `Error fetching fork chain: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  if (chain.length === 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Session not found: ${options.session}\n`,
    };
  }

  // Handle circular references — if chain has duplicate IDs, deduplicate
  // while preserving order (first occurrence wins)
  const seen = new Set<string>();
  const deduped: ForkChainNode[] = [];
  for (const node of chain) {
    if (!seen.has(node.sessionId)) {
      seen.add(node.sessionId);
      deduped.push(node);
    }
  }

  if (options.format === "json") {
    const output = JSON.stringify(deduped, null, 2) + "\n";
    return { exitCode: 0, stdout: output, stderr: "" };
  }

  // Text format — one line per node with depth indentation
  const lines: string[] = [];
  for (const node of deduped) {
    const indent = "  ".repeat(node.depth);
    const label = `[${node.agent}:${node.alias}]`;
    const title = node.title?.trim() || node.sessionId;
    if (node.sessionId === title) {
      lines.push(`${indent}${label} ${node.sessionId}`);
    } else {
      lines.push(`${indent}${label} ${title} (${node.sessionId})`);
    }
  }

  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}