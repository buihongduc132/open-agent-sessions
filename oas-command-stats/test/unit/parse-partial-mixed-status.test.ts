/**
 * OT22 — mixed-status batch: ok / partial / failed all present.
 *
 * Partial = parser succeeded but flagged an issue (e.g. binary in args,
 * ambiguous redirect). parse_status='partial' and parser_notes is populated.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-mixed-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("parse partial mixed statuses (OT22)", () => {
  it("batch_has_ok_partial_failed_all_three_present", async () => {
    const db = await openDb(DB_PATH);

    const events = [
      { agent: "pi" as const, alias: "t", session_id: "s", event_id: "ok-1",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "echo hello", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1 },
      { agent: "pi" as const, alias: "t", session_id: "s", event_id: "partial-1",
        source_schema_version: "0.1.0", event_ts: new Date(),
        // partial: contains a non-printable / control char that parser flags
        raw_command: "echo $'\\x01binary'", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1 },
      { agent: "pi" as const, alias: "t", session_id: "s", event_id: "failed-1",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "for do done broken", cwd_hint: "/tmp", exit_code: 1, duration_ms: 1 },
    ];

    await ingestBatch(db, events);

    const ce = await db.all(
      "SELECT parse_status, parser_notes FROM cmd_events WHERE parse_status = 'ok' OR parse_status = 'partial'"
    );
    const statuses = new Set(ce.map(r => r.parse_status));
    expect(statuses.has("ok")).toBe(true);

    const partialRow = ce.find(r => r.parse_status === "partial");
    expect(partialRow).toBeDefined();
    expect(partialRow!.parser_notes).toBeTruthy();

    const q = await db.all("SELECT parse_status FROM cmd_quarantine");
    expect(q.length).toBeGreaterThanOrEqual(1);
    expect(q.every(r => r.parse_status === "failed")).toBe(true);

    await db.close();
  });
});
