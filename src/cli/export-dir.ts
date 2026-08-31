/**
 * Dir-mode export orchestration: plan/preflight/dry-run/write.
 * STUB (RED phase): contracts frozen in flow/plans/oas-export-turn-split-design.md.
 */
import type { CliResult } from "./types";
import type { SessionDetail } from "../core/types";
import type { ExportFlagValues } from "./export-options";

export interface DirExportDeps {
  config: unknown;
  getSession: (
    query: { agent: string; alias: string; id: string },
    options?: unknown
  ) => Promise<SessionDetail | null>;
}

export async function runDirExport(flags: ExportFlagValues, deps: DirExportDeps): Promise<CliResult> {
  throw new Error("not implemented: runDirExport");
}
