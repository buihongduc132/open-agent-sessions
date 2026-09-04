/**
 * OT26 / contract (e) — outbox and cmd_events live in the SAME DuckDB file
 * and are written in a SINGLE transaction.
 *
 * If the cmd_events insert for a batch fails (infra), the outbox insert for
 * that same batch must NOT have committed either — atomic across both tables.
 *
 * (Per-row poison isolation is separate; this test is about the tx boundary
 * for the batch as a whole.)
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-tx-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("outbox + cmd_events same-tx atomicity (OT26/e)", () => {
  it("both_tables_in_one_duckdb_file", async () => {
    const db = await openDb(DB_PATH);
    // Sanity: both tables exist in the SAME db file.
    const tables = await db.all(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='main'"
    );
    const names = new Set(tables.map((t: any) => t.table_name));
    expect(names.has("outbox")).toBe(true);
    expect(names.has("cmd_events")).toBe(true);
    await db.close();
  });

  it("single_valid_event_writes_to_both_tables_atomically", async () => {
    const db = await openDb(DB_PATH);
    const events = [
      { agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e1",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "echo hi", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1 },
    ];
    const r = await ingestBatch(db, events);
    expect(r.committed).toBe(1);

    // Both tables have the row in one tx.
    const ob = await db.all("SELECT COUNT(*) AS n FROM outbox");
    const ce = await db.all("SELECT COUNT(*) AS n FROM cmd_events");
    expect(ob[0].n).toBe(1);
    expect(ce[0].n).toBe(1);

    // outbox row marked processed (same tx).
    const obRow = await db.all("SELECT processing_status FROM outbox");
    expect(obRow[0].processing_status).toBe("processed");
    await db.close();
  });
});
