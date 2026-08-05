/**
 * OT45 / OT48 / contract (d) — idempotency: re-run identical input → 0 new
 * outbox rows. The outbox UNIQUE(agent, alias, session_id, event_id) is the
 * idempotency oracle; watermark is just a perf hint.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-idem-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("ingest idempotency (OT45/OT48/d)", () => {
  it("rerun_identical_input_zero_new_outbox_rows", async () => {
    const db = await openDb(DB_PATH);

    const events = [
      { agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e1",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "echo a", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1 },
      { agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e2",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "echo b", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1 },
    ];

    const r1 = await ingestBatch(db, events);
    expect(r1.committed).toBe(2);

    // Re-run identical.
    const r2 = await ingestBatch(db, events);
    expect(r2.committed).toBe(0);
    expect(r2.deduped).toBe(2);

    const n = await db.all("SELECT COUNT(*) AS n FROM outbox");
    expect(n[0].n).toBe(2); // still 2, not 4
    await db.close();
  });

  it("idempotent_after_watermark_reset", async () => {
    // Even if we delete the watermark row, idempotency still holds because
    // outbox UNIQUE is the oracle.
    const db = await openDb(DB_PATH);
    const events = [
      { agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e1",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "echo a", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1 },
    ];
    await ingestBatch(db, events);
    await db.run("DELETE FROM session_watermarks");
    const r2 = await ingestBatch(db, events);
    expect(r2.committed).toBe(0);
    await db.close();
  });
});
