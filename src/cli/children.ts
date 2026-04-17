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
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  if (children.length === 0) {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  if (options.format === "json") {
    const output = JSON.stringify(children, null, 2) + "\n";
    return { exitCode: 0, stdout: output, stderr: "" };
  }

  const lines: string[] = [];
  for (const child of children) {
    const label = `[${child.agent}:${child.alias}]`;
    const title = child.title?.trim() || child.id;
    if (title === child.id) {
      lines.push(`${label} ${child.id}`);
    } else {
      lines.push(`${label} ${title} (${child.id})`);
    }
  }

  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}