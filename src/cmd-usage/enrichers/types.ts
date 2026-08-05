/**
 * src/cmd-usage/enrichers/types.ts
 *
 * Pluggable enricher interface for augmenting cmd-usage data
 * with duration and error information from external sources.
 */

/** Query sent to an enricher for a single command. */
export interface EnricherQuery {
  /** Signature (e.g., "git.diff") */
  sig: string;
  /** Raw command text */
  rawCommand: string;
  /** Working directory of the session */
  cwd: string;
  /** Timestamp range [start, end] as ISO strings */
  tsRange: [string, string];
}

/** Result from an enricher lookup. */
export interface EnricherResult {
  /** Duration in milliseconds */
  durMs?: number;
  /** Exit code (0 = success, non-zero = error) */
  exit?: number;
}

/** Pluggable enricher interface. */
export interface Enricher {
  /** Enricher name (for reporting) */
  name: string;
  /** Check if this enricher is available (e.g., DB exists, schema valid) */
  available(): Promise<boolean>;
  /** Batch lookup for multiple commands. Returns map keyed by "sig|rawCommand". */
  batchLookup(cmds: EnricherQuery[]): Promise<Map<string, EnricherResult>>;
}
