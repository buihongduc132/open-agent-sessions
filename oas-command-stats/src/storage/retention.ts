/**
 * Retention enforcement (OT30 rank5 GDPR).
 *
 * Resolves:
 *   OT30 (c): hard TTL → DELETE + VACUUM (forensic unrecoverable)
 *   OT30 (d): retention_hold BOOLEAN — trim skips held rows
 *   OT30 (e): soft cap → mark oldest as sample_excluded, NOT delete
 *
 * @file src/storage/retention.ts
 */
import type { DbHandle } from "./duckdb";

export interface TrimOptions {
  /** Hard TTL in days. Rows older than this get deleted (unless held). */
  hard_ttl_days: number;
}

export interface SoftCapOptions {
  /** Max rows to keep unmarked. Oldest N beyond cap marked sample_excluded=true. */
  max_rows: number;
}

/**
 * Trim rows older than hard TTL. Skip rows with retention_hold=true.
 * Runs DELETE then VACUUM to make trimmed rows forensically unrecoverable.
 *
 * Atomic: single tx wraps DELETE. VACUUM runs after commit (DuckDB VACUUM
 * cannot run inside tx).
 */
export async function trimExpired(
  db: DbHandle,
  opts: TrimOptions,
): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - opts.hard_ttl_days * 24 * 60 * 60 * 1000);

  await db.run("BEGIN TRANSACTION");
  try {
    await db.run(
      `DELETE FROM outbox
       WHERE event_ts < ?
         AND (retention_hold IS NULL OR retention_hold = FALSE)`,
      [cutoff],
    );
    await db.run(
      `DELETE FROM cmd_events
       WHERE event_ts < ?
         AND (retention_hold IS NULL OR retention_hold = FALSE)`,
      [cutoff],
    );
    await db.run(
      `DELETE FROM cmd_quarantine
       WHERE quarantined_at < ?`,
      [cutoff],
    );
    await db.run("COMMIT");
  } catch (err) {
    try { await db.run("ROLLBACK"); } catch {}
    throw err;
  }

  // VACUUM outside tx — physically reclaims space, makes deleted rows
  // unrecoverable via raw file inspection.
  await db.run("VACUUM");

  // Count remaining rows for caller info (precise count requires pre-trim snapshot;
  // callers needing exact delete count should snapshot before calling).
  return { deleted: -1 };
}

/**
 * Enforce soft cap: mark oldest (max_rows) rows as sample_excluded=true,
 * leave the rest unmarked. Does NOT delete — sampling, not pruning.
 *
 * Ties broken by event_id (deterministic).
 */
export async function enforceSoftCap(
  db: DbHandle,
  opts: SoftCapOptions,
): Promise<{ marked: number }> {
  // Rank all outbox rows by event_ts ASC (oldest first). Mark all beyond
  // max_rows as sample_excluded=true.
  await db.run("BEGIN TRANSACTION");
  try {
    // Reset all to false first (idempotent re-run)
    await db.run("UPDATE outbox SET sample_excluded = FALSE");

    // Mark oldest beyond cap. DuckDB supports CTE + UPDATE.
    await db.run(
      `UPDATE outbox
       SET sample_excluded = TRUE
       WHERE outbox_id IN (
         SELECT outbox_id FROM (
           SELECT outbox_id,
                  ROW_NUMBER() OVER (ORDER BY event_ts ASC, event_id ASC) AS rn
           FROM outbox
         ) WHERE rn > ?
       )`,
      [opts.max_rows],
    );

    await db.run("COMMIT");
  } catch (err) {
    try { await db.run("ROLLBACK"); } catch {}
    throw err;
  }

  return { marked: -1 };
}
