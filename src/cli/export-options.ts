/**
 * Export flag registry, parse + validation, conflict matrix, help text.
 * STUB (RED phase): contracts frozen in flow/plans/oas-export-turn-split-design.md.
 */
export interface ExportFlagValues {
  sessionRef?: string;
  from?: string;
  format?: "csf" | "markdown" | "text";
  output?: string;
  agent?: string;
  id?: string;
  type?: "consolidate" | "split_turn";
  dir?: string;
  prefix?: string;
  dryRun?: boolean;
  force?: boolean;
  fromRelative?: string;
  toRelative?: string;
  fromTurn?: string;
  toTurn?: string;
  withTypes: string[];
  rawWithFlags: string[];
}

export type FlagParseResult =
  | { ok: true; value: ExportFlagValues }
  | { ok: false; errors: string[]; exitCode: 2 };

export function parseExportFlags(argv: string[]): FlagParseResult {
  throw new Error("not implemented: parseExportFlags");
}

export function exportHelpText(): string {
  throw new Error("not implemented: exportHelpText");
}
