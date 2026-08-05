/**
 * Crash recovery — lease management + watermark repair.
 *
 * Phase 5 (OT17): processing lease on outbox rows + stale reaper.
 *
 * @file src/storage/crash.ts
 */
import type { DbHandle } from "./duckdb";

/**
 * Acquire processing lease on an outbox row.
 *
 * Sets processing_status='processing', processing_started_at=NOW,
 * lease_owner=workerId, lease_timeout_s=timeoutSec.
 * Returns true on success, false if already leased (status != 'pending').
 */
export async function acquireLease(
  db: DbHandle,
  workerId: string,
  outboxId: number,
  timeoutSec: number,
): Promise<boolean> {
  await db.run("BEGIN TRANSACTION");
  try {
    // Only lease if currently pending
    const rows = await db.all<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM outbox
       WHERE outbox_id = ? AND processing_status = 'pending'`,
      [outboxId],
    );
    if ((rows[0]?.cnt ?? 0) === 0) {
      await db.run("COMMIT");
      return false;
    }

    await db.run(
      `UPDATE outbox
       SET processing_status = 'processing',
           processing_started_at = CURRENT_TIMESTAMP,
           lease_owner = ?,
           lease_timeout_s = ?
       WHERE outbox_id = ? AND processing_status = 'pending'`,
      [workerId, timeoutSec, outboxId],
    );
    await db.run("COMMIT");
    return true;
  } catch (err) {
    try { await db.run("ROLLBACK"); } catch {}
    throw err;
  }
}

/**
 * Reap stale processing rows — those where
 * processing_started_at + lease_timeout_s < NOW.
 * Resets to pending (processing_status='pending', lease_owner=NULL,
 * processing_started_at=NULL).
 */
export async function reapStaleProcessing(
  db: DbHandle,
): Promise<{ reaped: number }> {
  await db.run("BEGIN TRANSACTION");
  try {
    // Count first for return value
    const countRows = await db.all<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM outbox
       WHERE processing_status = 'processing'
         AND processing_started_at IS NOT NULL
         AND lease_timeout_s IS NOT NULL
         AND processing_started_at + INTERVAL (lease_timeout_s) SECOND < CURRENT_TIMESTAMP`,
    );
    const reaped = countRows[0]?.cnt ?? 0;

    await db.run(
      `UPDATE outbox
       SET processing_status = 'pending',
           lease_owner = NULL,
           processing_started_at = NULL
       WHERE processing_status = 'processing'
         AND processing_started_at IS NOT NULL
         AND lease_timeout_s IS NOT NULL
         AND processing_started_at + INTERVAL (lease_timeout_s) SECOND < CURRENT_TIMESTAMP`,
    );
    await db.run("COMMIT");
    return { reaped };
  } catch (err) {
    try { await db.run("ROLLBACK"); } catch {}
    throw err;
  }
}

/**
 * Reset watermark to MIN(event_ts) of successfully processed cmd_events
 * for a given session. Used for repair scenarios.
 */
export async function resetWatermarkToMinTs(
  db: DbHandle,
  agent: string,
  alias: string,
  session_id: string,
): Promise<void> {
  const rows = await db.all<{ min_ts: Date | null }>(
    `SELECT MIN(event_ts) AS min_ts FROM cmd_events
     WHERE agent = ? AND alias = ? AND session_id = ?
       AND parse_status IN ('ok', 'partial')`,
    [agent, alias, session_id],
  );
  const minTs = rows[0]?.min_ts;
  if (minTs) {
    await db.run(
      `UPDATE session_watermarks
       SET scan_completed_at = ?
       WHERE agent = ? AND alias = ? AND session_id = ?`,
      [minTs, agent, alias, session_id],
    );
  }
}
