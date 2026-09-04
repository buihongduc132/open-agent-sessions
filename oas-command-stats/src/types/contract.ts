/**
 * Shared contract types for oas-command-stats Phase 2.
 *
 * @file src/types/contract.ts
 */

/** Agent kind supported by extraction. Matches SDK AgentKind union. */
export type SupportedAgent = "pi" | "zcode" | "hermes" | "opencode" | "claude" | "codex";

/** Per-row parse status from mvdan/sh AST walk. */
export type ParseStatus = "ok" | "partial" | "failed";

/** Extracted raw event ready for ingest (outbox row input). */
export interface ExtractedEvent {
  agent: SupportedAgent;
  alias: string;
  session_id: string;
  /** Per-agent derivation (OT28/c). pi=hash(file+byteoff), zcode=tool_usage.id, hermes=synthetic. */
  event_id: string;
  source_schema_version: string;
  event_ts: Date;
  raw_command: string;
  cwd_hint: string | null;
  exit_code: number | null;
  duration_ms: number | null;
}

/** Parsed command from mvdan/sh AST walk. */
export interface ParsedCommand {
  program: string | null;
  subcommand: string | null;
  positional_args: string[];
  flags: string[];
  pipeline_depth: number;
  statement_count: number;
  parse_status: ParseStatus;
  parser_notes: string | null;
}

/** Result of ingestBatch. */
export interface IngestResult {
  attempted: number;
  committed: number;
  failed: number;
  deduped: number;
}

/** Complexity bucket (OT43). */
export type ComplexityBucket = "simple" | "medium" | "complex";
