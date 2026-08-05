/**
 * LD2 / contract (d,h) — second ingest of same session with appended events.
 *
 * Original N rows untouched. Exactly K new rows (K = appended event count).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-2nd-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("second-run only new events (LD2)", () => {
  it("append_5_events_second_ingest_yields_exactly_5_new_rows", async () => {
    const db = await openDb(DB_PATH);

    const mkEvents = (n: number, startIdx: number) =>
      Array.from({ length: n }, (_, i) => ({
        agent: "pi" as const, alias: "t", session_id: "s1",
        event_id: `off-${startIdx + i}`,
        source_schema_version: "0.1.0",
        event_ts: new Date(1700000000000 + (startIdx + i) * 1000),
        raw_command: `echo cmd-${startIdx + i}`,
        cwd_hint: "/tmp", exit_code: 0, duration_ms: 1,
      }));

    // First run: 10 events.
    const r1 = await ingestBatch(db, mkEvents(10, 0));
    expect(r1.committed).toBe(10);

    // Second run: same 10 + 5 new appended (byte-offset keys reflect reality).
    const r2 = await ingestBatch(db, [...mkEvents(10, 0), ...mkEvents(5, 10)]);
    expect(r2.committed).toBe(5);  // only the 5 new
    expect(r2.deduped).toBe(10);   // the 10 old deduped

    const n = await db.all("SELECT COUNT(*) AS n FROM outbox");
    expect(n[0].n).toBe(15);  // 10 + 5, no dupes
    await db.close();
  });
});
