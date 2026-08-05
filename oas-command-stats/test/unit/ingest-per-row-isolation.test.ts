/**
 * OT23 — poison-batch row isolation.
 *
 * If one row in a 10-row batch throws during ingest, the OTHER 9 rows MUST
 * commit to outbox. The poison row goes to cmd_quarantine. ingestBatch does
 * NOT wrap the whole batch in a single tx.commit/rollback.
 *
 * Zone 4 (error propagation) — written FIRST per worst-first-testing.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-poison-${process.pid}-${Date.now()}.duckdb`);

beforeEach(() => { /* fresh db per test via openDb bootstrap */ });
afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("ingestBatch — OT23 poison-row isolation", () => {
  it("poison_row_isolated_rest_of_batch_commits_no_rollback", async () => {
    const db = await openDb(DB_PATH);

    // 10 events. Row #5 (index 4) is poison — its raw_command triggers a
    // parser error (mvdan/sh fails on malformed input). Rows 1-4, 6-10 are
    // valid.
    const events = Array.from({ length: 10 }, (_, i) => ({
      agent: "pi" as const,
      alias: "test",
      session_id: "sess-poison",
      event_id: `evt-${i}`,
      source_schema_version: "0.1.0",
      event_ts: new Date(1700000000000 + i * 1000),
      raw_command: i === 4
        ? `if then fi broken syntax (((`  // poison: parse error
        : `echo hello-${i}`,
      cwd_hint: "/tmp",
      exit_code: 0,
      duration_ms: 10,
    }));

    const result = await ingestBatch(db, events);

    expect(result.attempted).toBe(10);
    expect(result.committed).toBe(9);
    expect(result.failed).toBe(1);

    // Outbox has 10 rows (9 valid processed + 1 poison failed). OT22 contract:
    // parse-fail STILL writes outbox (raw event captured). NO batch rollback.
    const outboxCount = await db.all("SELECT COUNT(*) AS n FROM outbox");
    expect(outboxCount[0].n).toBe(10);

    // Outbox poison row: processing_status='failed'
    const poisonOb = await db.all(
      "SELECT processing_status FROM outbox WHERE event_id='evt-4'"
    );
    expect(poisonOb[0].processing_status).toBe("failed");

    // Quarantine has the 1 poison row.
    const qCount = await db.all("SELECT COUNT(*) AS n FROM cmd_quarantine");
    expect(qCount[0].n).toBe(1);

    // cmd_events: all 9 valid parse OK.
    const ceCount = await db.all("SELECT COUNT(*) AS n FROM cmd_events");
    expect(ceCount[0].n).toBe(9);

    await db.close();
  });

  it("infrastructure_error_aborts_whole_batch", async () => {
    // Contrast: if DB connection itself fails (infra), the WHOLE batch aborts.
    // This is distinct from a row-level poison.
    const db = await openDb(DB_PATH);

    // Force an infra error by closing the connection mid-batch is hard to do
    // deterministically; instead simulate by passing a malformed event list
    // shape that triggers an infra-level throw (not a row-level parse error).
    const badEvents = [
      { /* missing required agent field */ } as any,
    ];
    await expect(ingestBatch(db, badEvents)).rejects.toThrow();
    const n = await db.all("SELECT COUNT(*) AS n FROM outbox");
    expect(n[0].n).toBe(0);
    await db.close();
  });
});
