/**
 * LD3 LD4 — Sysops query layer: 6 templates + freshness + skew.
 *
 * All async; take DbHandle. Pure SELECT — never writes.
 *
 * Contract refs: _GOAL_open-agent-sessions.md t6 (a)-(d),(g).
 *
 * @file src/query/templates.ts
 */
import type { DbHandle } from "../storage/duckdb";

// ─── (a1) queryRecent ──────────────────────────────────────────────────────

export interface RecentRow {
  event_id: string;
  raw_command: string | null;
  event_ts: Date;
  agent: string;
  session_id: string;
}

/**
 * Recent N commands (most-recent first).
 * Joined view of raw event (outbox) — args live in cmd_events.
 */
export async function queryRecent(db: DbHandle, n: number): Promise<RecentRow[]> {
  return db.all<RecentRow>(
    `SELECT event_id, raw_command, event_ts, agent, session_id
       FROM outbox
       ORDER BY event_ts DESC
       LIMIT ?`,
    [n],
  );
}

// ─── (a2) queryArgsForProgram ──────────────────────────────────────────────

export interface ArgRow {
  arg: string;
}

/**
 * All args seen for a program (e.g. "git").
 * Includes subcommand + positional_args — both are "arguments" to the program.
 * UNNEST(positional_args) flattens VARCHAR[] → one row per arg.
 */
export async function queryArgsForProgram(db: DbHandle, program: string): Promise<ArgRow[]> {
  return db.all<ArgRow>(
    `SELECT subcommand AS arg
       FROM cmd_events
      WHERE program = ? AND subcommand IS NOT NULL
      UNION ALL
     SELECT UNNEST(positional_args) AS arg
       FROM cmd_events
      WHERE program = ?`,
    [program, program],
  );
}

// ─── (a3) queryMostRun — 3 modes ───────────────────────────────────────────

export type MostRunMode = "raw_count" | "distinct_day" | "failure_weighted";

/**
 * Unified row shape across all three modes. Only the field matching the
 * requested mode is populated; others are undefined. Avoids awkward union
 * access at call sites under strict mode.
 */
export interface MostRunRow {
  program: string;
  /** Populated when mode = "raw_count". */
  n?: number;
  /** Populated when mode = "distinct_day". */
  distinct_days?: number;
  /** Populated when mode = "failure_weighted". */
  weight?: number;
}

/**
 * Most-run programs. Three modes:
 *   raw_count        — COUNT(*) per program
 *   distinct_day     — COUNT(DISTINCT DATE_TRUNC('day', event_ts)) per program
 *   failure_weighted — SUM(exit_code != 0) joined outbox↔cmd_events
 */
export async function queryMostRun(
  db: DbHandle,
  mode: MostRunMode,
): Promise<MostRunRow[]> {
  if (mode === "raw_count") {
    return db.all<MostRunRow>(
      `SELECT program, COUNT(*) AS n
         FROM cmd_events
        WHERE program IS NOT NULL
        GROUP BY program
        ORDER BY n DESC`,
    );
  }
  if (mode === "distinct_day") {
    return db.all<MostRunRow>(
      `SELECT program, COUNT(DISTINCT DATE_TRUNC('day', event_ts)) AS distinct_days
         FROM cmd_events
        WHERE program IS NOT NULL
        GROUP BY program
        ORDER BY distinct_days DESC`,
    );
  }
  // failure_weighted — join cmd_events.program ↔ outbox.exit_code
  return db.all<MostRunRow>(
    `SELECT ce.program,
            SUM(CASE WHEN o.exit_code IS NOT NULL AND o.exit_code != 0 THEN 1 ELSE 0 END) AS weight
       FROM cmd_events ce
       JOIN outbox o
         ON o.agent = ce.agent
        AND o.alias = ce.alias
        AND o.session_id = ce.session_id
        AND o.event_id = ce.event_id
      WHERE ce.program IS NOT NULL
      GROUP BY ce.program
      ORDER BY weight DESC`,
  );
}

// ─── (a4) queryTimeOfDayHistogram — tz-aware ───────────────────────────────

export interface HistogramRow {
  hour: number;
  n: number;
}

/**
 * Resolve tz spec to a valid IANA tz string.
 *   "UTC"   → UTC
 *   "local" → host tz via Intl API
 *   IANA    → as-is (validated)
 */
function resolveTz(tz: string): string {
  if (tz === "UTC") return "UTC";
  if (tz === "local") {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return host || "UTC";
  }
  // IANA tz — validate against safe charset
  if (!/^[A-Za-z0-9_/.+-]+$/.test(tz)) {
    throw new Error(`Invalid tz specifier: ${tz}`);
  }
  return tz;
}

/**
 * Build SQL hour-extraction expression. Parameterised at JS layer to avoid
 * DuckDB param-placeholder issues with `AT TIME ZONE ?`.
 *
 *   UTC       → EXTRACT(HOUR FROM o.event_ts)
 *   <IANA>    → EXTRACT(HOUR FROM o.event_ts AT TIME ZONE 'UTC' AT TIME ZONE '<IANA>')
 */
function hourExprForJoin(tz: string): string {
  const resolved = resolveTz(tz);
  if (resolved === "UTC") {
    return "EXTRACT(HOUR FROM o.event_ts)";
  }
  return `EXTRACT(HOUR FROM o.event_ts AT TIME ZONE 'UTC' AT TIME ZONE '${resolved}')`;
}

/**
 * 24-bucket hour histogram (always 24 rows, even with zero counts).
 * LEFT JOIN against generate_series(0,23) guarantees completeness.
 */
export async function queryTimeOfDayHistogram(
  db: DbHandle,
  tz: "UTC" | "local" | string,
): Promise<HistogramRow[]> {
  const hourExpr = hourExprForJoin(tz);
  return db.all<HistogramRow>(
    `WITH hours(hour) AS (
        SELECT generate_series AS h FROM generate_series(0, 23)
     )
     SELECT h.hour, COUNT(o.event_id) AS n
       FROM hours h
       LEFT JOIN outbox o ON ${hourExpr} = h.hour
      GROUP BY h.hour
      ORDER BY h.hour`,
  );
}

// ─── (a5) queryDrillDown ───────────────────────────────────────────────────

export interface DrillDownRow {
  agent: string;
  session_id: string;
  event_id: string;
}

/**
 * Drill from event_id → originating agent/session.
 * Returns null if not found.
 */
export async function queryDrillDown(
  db: DbHandle,
  event_id: string,
): Promise<DrillDownRow | null> {
  const rows = await db.all<DrillDownRow>(
    `SELECT agent, session_id, event_id
       FROM outbox
      WHERE event_id = ?
      LIMIT 1`,
    [event_id],
  );
  return rows[0] ?? null;
}

// ─── (a6) queryCrossCwd ────────────────────────────────────────────────────

export interface CrossCwdRow {
  repo: string;
  n: number;
}

/**
 * Cross-cwd (repo) distribution — counts per repo across all sessions.
 */
export async function queryCrossCwd(db: DbHandle): Promise<CrossCwdRow[]> {
  return db.all<CrossCwdRow>(
    `SELECT repo, COUNT(*) AS n
       FROM cmd_events
      WHERE repo IS NOT NULL
      GROUP BY repo
      ORDER BY n DESC`,
  );
}

// ─── (g) queryCoverageRibbon ───────────────────────────────────────────────

export interface CoverageRibbonRow {
  agent: string;
  day: Date;
  last_seen_ts: Date;
}

/**
 * Per-source coverage: agent × day × last_seen_ts.
 * Used to spot sources with gaps (e.g. agent silent for N days).
 */
export async function queryCoverageRibbon(db: DbHandle): Promise<CoverageRibbonRow[]> {
  return db.all<CoverageRibbonRow>(
    `SELECT agent,
            CAST(DATE(event_ts) AS TIMESTAMP) AS day,
            MAX(event_ts) AS last_seen_ts
       FROM outbox
      GROUP BY agent, DATE(event_ts)
      ORDER BY agent, day`,
  );
}

// ─── (d) computeFreshness ──────────────────────────────────────────────────

export interface FreshnessResult {
  last_ingested_at: Date | null;
  max_event_ts: Date | null;
  /** true if now - max_event_ts > 1h (data is "stale"). */
  stale: boolean;
}

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1h

/**
 * Freshness banner: last ingestion ts + newest event ts + stale flag.
 * Stale = max_event_ts older than 1h.
 */
export async function computeFreshness(db: DbHandle): Promise<FreshnessResult> {
  const rows = await db.all<Pick<FreshnessResult, "last_ingested_at" | "max_event_ts">>(
    `SELECT MAX(extracted_at) AS last_ingested_at,
            MAX(event_ts)      AS max_event_ts
       FROM outbox`,
  );
  const r = rows[0];
  const lastIngested = r?.last_ingested_at ?? null;
  const maxEventTs = r?.max_event_ts ?? null;
  const stale = maxEventTs
    ? Date.now() - maxEventTs.getTime() > STALE_THRESHOLD_MS
    : true;
  return { last_ingested_at: lastIngested, max_event_ts: maxEventTs, stale };
}

// ─── (c) checkClockSkew ────────────────────────────────────────────────────

export interface ClockSkewResult {
  /** Max observed lag between CURRENT_TIMESTAMP and row extraction ts, seconds. */
  skew_seconds: number;
  /** Flagged when skew > 300s (host clock drift or backpressure). */
  flagged: boolean;
}

const SKEW_FLAG_THRESHOLD_S = 300;

/**
 * Detect host-clock skew / ingestion backpressure.
 * Compares extracted_at (write time) against DB CURRENT_TIMESTAMP.
 */
export async function checkClockSkew(db: DbHandle): Promise<ClockSkewResult> {
  const rows = await db.all<{ skew_seconds: number | null }>(
    `SELECT MAX(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - extracted_at))) AS skew_seconds
       FROM outbox`,
  );
  const skew = rows[0]?.skew_seconds ?? 0;
  return {
    skew_seconds: skew,
    flagged: skew > SKEW_FLAG_THRESHOLD_S,
  };
}
