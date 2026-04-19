/**
 * src/cli/children.ts
 *
 * Implements `oas children <session-id>` — lists direct child sessions of a parent.
 *
 * Outputs:
 *   - One line per direct child: [agent:alias] title (sessionId)
 *   - Empty output when no children exist
 *   - JSON format when format="json" is specified
 *
 * Error handling:
 *   - When getChildren throws → exitCode 1
 */

import { Config } from "../config/types";
import { SessionSummary } from "../core/types";
import { CliResult } from "./types";
import { formatSessionRowSimple } from "./formatters/text";
import { errorMessage } from "./utils/config";

export type ChildrenService = (parentSessionId: string) => Promise<SessionSummary[]>;

export interface ChildrenOptions {
  parentSessionId: string;
  format?: "text" | "json";
  config?: Config;
  getChildren: ChildrenService;
}

export async function runChildrenCommand(options: ChildrenOptions): Promise<CliResult> {
  let children: SessionSummary[];
  try {
    children = await options.getChildren(options.parentSessionId);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error fetching children for ${options.parentSessionId}: ${errorMessage(error)}\n`,
    };
  }

  if (children.length === 0) {
    const empty = options.format === "json" ? "[]\n" : "No children found.\n";
    return { exitCode: 0, stdout: empty, stderr: "" };
  }

  if (options.format === "json") {
    const output = JSON.stringify(children, null, 2) + "\n";
    return { exitCode: 0, stdout: output, stderr: "" };
  }

  const lines = children.map((child) => formatSessionRowSimple(child));

  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}