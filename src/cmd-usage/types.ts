/**
 * src/cmd-usage/types.ts
 *
 * Public type surface for the cmd-usage analyzer.
 *
 * The analyzer scans pi session JSONL files, extracts bash commands,
 * classifies them into signatures (e.g., git.diff, npm.test), and
 * aggregates per-signature statistics including duration, error rate,
 * flags, args, and 7-day time buckets.
 */

/** A single classified bash command from a pi session. */
export interface CmdMatch {
  /** Signature (e.g., "git.diff", "npm.test") */
  sig: string;
  /** Base command (e.g., "git", "npm") */
  base: string;
  /** Sub-command if applicable (e.g., "diff", "test") */
  sub?: string;
  /** Raw command text */
  raw: string;
  /** ISO timestamp from the JSONL event */
  ts: string;
  /** Session ID from the JSONL session block */
  sessionId: string;
  /** Tool call ID linking to toolResult */
  toolCallId: string;
}

/** Per-signature aggregated usage record. */
export interface CmdUsageRecord {
  /** Signature */
  sig: string;
  /** Base command */
  base: string;
  /** Sub-command if applicable */
  sub?: string;
  /** Total invocation count */
  count: number;
  /** Average duration in ms (from enricher) */
  durAvg?: number;
  /** P99 duration in ms (from enricher) */
  durP99?: number;
  /** Error count (from enricher) */
  errCount?: number;
  /** Error rate: errCount / count (from enricher) */
  errRate?: number;
  /** Top flags (sorted by frequency) */
  flags: { name: string; count: number }[];
  /** Top normalized args (sorted by frequency) */
  args: { norm: string; count: number }[];
  /** 7-day activity buckets [d-6 ... d-0] */
  buckets: number[];
  /** Last seen ISO timestamp */
  lastTs: string;
  /** Fraction of commands enriched with dur/err data */
  enrichedPct: number;
}

/** Enricher statistics in the report. */
export interface EnricherStat {
  name: string;
  unavailable: boolean;
}

/** Aggregate report returned by analyzeCmdUsage. */
export interface CmdUsageReport {
  bySignature: Record<string, CmdUsageRecord>;
  scannedSessions: number;
  cachedSessions: number;
  elapsedMs: number;
  enricherStats: EnricherStat[];
}

/** Scope of session discovery. */
export type CmdUsageScope = "cwd" | "all";

/** Options for analyzeCmdUsage. */
export interface CmdUsageOptions {
  /** Root directory containing session JSONL files (flat or 1-level nested). */
  sessionsDir: string;
  /** Scope: "cwd" filters to encoded CWD dir, "all" scans everything. Default: "cwd". */
  scope?: CmdUsageScope;
  /** CWD to filter to when scope="cwd". */
  cwd?: string;
  /** Only sessions modified within N days (mtime-based). Default: 7. */
  days?: number;
  /** Directory for the filesystem cache. */
  cacheDir: string;
  /** Enrichers to run after classification. Default: []. */
  enrichers?: import("./enrichers/types").Enricher[];
  /** Bump when parser semantics change. Default: "1.0.0". */
  parserVersion?: string;
}
