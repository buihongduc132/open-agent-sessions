/**
 * src/skill-usage/types.ts
 *
 * Public type surface for the skill-usage analyzer.
 *
 * The analyzer scans pi session JSONL files, extracts skill references
 * (read-tool loads + text mentions), matches them against a skill inventory
 * using a 4-tier pipeline (exact / normalized / alias / fuzzy), and aggregates
 * per-skill usage statistics. Results are cached on disk keyed by a content
 * fingerprint of each session file so unchanged sessions skip reparsing.
 */

/** Match tier, ordered by precision (exact highest, fuzzy lowest). */
export type MatchTier = "exact" | "normalized" | "alias" | "fuzzy";

/** Result of matching a candidate token against a skill name. */
export interface MatchResult {
  tier: MatchTier;
  distance: number;
}

/** A single observation of a skill reference inside a session. */
export interface SkillMatch {
  /** Canonical skill name from the inventory. */
  skill: string;
  tier: MatchTier;
  /** 0 for exact/normalized/alias; DL distance for fuzzy. */
  distance: number;
  /** Original token as found in the session (for variants reporting). */
  matchedText: string;
  source: "read-tool" | "text-mention";
  sessionId: string;
  timestamp: string;
}

/** One entry in the skill inventory (parsed from <dir>/<name>/SKILL.md). */
export interface SkillInventoryEntry {
  name: string;
  description: string;
  aliases: string[];
  /** Absolute path to the SKILL.md file. */
  path: string;
}

/** Tokenize + match configuration. */
export interface SkillUsageOptions {
  /** Root directory containing pi session .jsonl files (flat or 1-level nested). */
  sessionsDir: string;
  /** One or more inventory directories (each containing <skill>/SKILL.md). */
  inventoryDirs: string[];
  /** Directory where the filesystem cache lives. Created if absent. */
  cacheDir: string;
  /** Only sessions modified within N days (mtime-based). Default: 7. */
  days?: number;
  /** Fuzzy tier config. Default: { enabled: true, maxDistance: 2 }. */
  fuzzy?: { enabled: boolean; maxDistance: 1 | 2 | 3 };
  /** Cache backend. Default: "json". (sqlite is reserved; not implemented here.) */
  cacheFormat?: "json" | "sqlite";
  /** Bump when parser semantics change → invalidates every cache entry. Default: "1.0.0". */
  parserVersion?: string;
}

/** Per-skill aggregated usage record. */
export interface SkillUsageVariant {
  /** Original token form that produced this variant match. */
  variant: string;
  tier: MatchTier;
  /** Times this exact (variant, tier, distance) tuple was observed. */
  count: number;
  distance: number;
}

export interface SkillUsageRecord {
  skill: string;
  /** Count of read-tool loads of <skill>/SKILL.md. */
  loads: number;
  /** Count of text mentions across all tiers. */
  mentions: number;
  /** Distinct sessions where the skill was loaded OR mentioned. */
  sessions: number;
  loadedInSessions: string[];
  mentionedInSessions: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** Non-exact matched variants (T2/T3/T4) with observation counts. */
  matchedVariants: SkillUsageVariant[];
}

/** Aggregate report returned by analyzeSkillUsage. */
export interface SkillUsageReport {
  bySkill: Record<string, SkillUsageRecord>;
  /** Sessions actually parsed on this run. */
  scannedSessions: number;
  /** Sessions served from cache (skipped parsing). */
  cachedSessions: number;
  elapsedMs: number;
  /** Highest fuzzy distance observed across all matches. */
  maxObservedDistance: number;
}
