/**
 * Phase 5 closure (B4, contract item b) — watermark in SAME tx as batch commit.
 *
 * Previously watermark was separate UPSERT AFTER row loop (ingest.ts:209-221).
 * Crash between COMMIT of rows and watermark UPSERT would advance watermark
 * past data that was actually committed → orphan on restart.
 *
 * RED catches this race window.
 *
 * @file test/unit/watermark-same-tx.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, type DbHandle } from "../../src/storage/duckdb";
import { ingestBatch } from "../../src/storage/ingest";

const DB_PATH = join(tmpdir(), `oas-cs-p5c-wm-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("OT12-5 (b) watermark same-tx atomicity", () => {
  it("watermark_commit_rolled_back_if_batch_tx_rolled_back", async () => {
    // Wrap ingestBatch in outer tx that we rollback.
    // If watermark is in same tx as batch commit → watermark also rolled back.
    // If watermark is separate UPSERT → it survives (BUG).
    const db = await openDb(DB_PATH);

    await db.run("BEGIN TRANSACTION");
    try {
      await ingestBatch(db, [
        {
          agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e1",
          source_schema_version: "0.1.0", event_ts: new Date(),
          raw_command: "echo a", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1,
        },
      ]);
      // Force rollback of outer tx
      throw new Error("simulated crash");
    } catch {
      try { await db.run("ROLLBACK"); } catch {}
    }

    // Watermark MUST NOT exist (rolled back with batch).
    // If it exists → watermark was committed in separate tx (BUG).
    const wm = await db.all(
      "SELECT * FROM session_watermarks WHERE session_id = 's1'"
    );
    expect(wm.length).toBe(0);
    await db.close();
  });

  it("watermark_written_when_batch_commits", async () => {
    const db = await openDb(DB_PATH);
    await ingestBatch(db, [
      {
        agent: "pi" as const, alias: "t", session_id: "s2", event_id: "e2",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "echo b", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1,
      },
    ]);
    const wm = await db.all(
      "SELECT * FROM session_watermarks WHERE session_id = 's2'"
    );
    expect(wm.length).toBe(1);
    await db.close();
  });
});
