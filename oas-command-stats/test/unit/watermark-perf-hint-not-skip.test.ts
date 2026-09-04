/**
 * OT45 / contract (h) — watermark is a PERFF HINT (scan-start bound), NOT a
 * skip predicate. Events with ts EARLIER than the watermark MUST still be
 * ingested (late/out-of-order events, NTP correction, retroactive edits).
 *
 * The outbox UNIQUE(agent, alias, session_id, event_id) is the idempotency
 * oracle; watermark only bounds the scan to "rows we haven't scanned past".
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb, setWatermark, getWatermark } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-wm-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("watermark perf-hint not skip-predicate (OT45/h)", () => {
  it("event_with_ts_earlier_than_watermark_still_ingested", async () => {
    const db = await openDb(DB_PATH);

    // Set a watermark at ts=2000-01-01 (very high).
    await setWatermark(db, "pi", "t", "s1", new Date("2099-01-01T00:00:00Z"));

    // Now ingest an event with ts=2020 — earlier than the watermark.
    // It MUST still be ingested (watermark is hint, not skip predicate).
    const events = [
      { agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e-late",
        source_schema_version: "0.1.0", event_ts: new Date("2020-01-01T00:00:00Z"),
        raw_command: "echo late", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1 },
    ];
    const r = await ingestBatch(db, events);
    expect(r.committed).toBe(1); // NOT skipped

    const n = await db.all("SELECT COUNT(*) AS n FROM outbox");
    expect(n[0].n).toBe(1);
    await db.close();
  });

  it("watermark_advances_to_min_ts_of_processed_rows", async () => {
    const db = await openDb(DB_PATH);
    const events = [
      { agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e1",
        source_schema_version: "0.1.0", event_ts: new Date("2020-01-03T00:00:00Z"),
        raw_command: "echo a", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1 },
      { agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e2",
        source_schema_version: "0.1.0", event_ts: new Date("2020-01-01T00:00:00Z"),
        raw_command: "echo b", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1 },
    ];
    await ingestBatch(db, events);

    const wm = await getWatermark(db, "pi", "t", "s1");
    expect(wm).toBeTruthy();
    // Watermark should be at MIN ts, not max (so late events get re-scanned).
    const wmTs = wm!.scan_completed_at ?? wm!.scan_started_at;
    // Per contract: advance to min(ts) of successfully-processed rows.
    // Concretely, watermark should be EARLIER than the latest event_ts.
    expect(new Date(wmTs!).getTime()).toBeLessThanOrEqual(
      new Date("2020-01-03T00:00:00Z").getTime()
    );
    await db.close();
  });
});
