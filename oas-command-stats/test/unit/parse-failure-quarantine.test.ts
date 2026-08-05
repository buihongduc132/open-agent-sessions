/**
 * OT22 — parse_status + parser_version + parser_notes columns.
 *
 * When mvdan/sh cannot parse a command, the row MUST NOT be silently lost:
 *   1. outbox row is still written (raw event captured)
 *   2. cmd_events has NO row for it
 *   3. cmd_quarantine has 1 row with parse_status='failed' + parser_notes
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-fail-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("parse failure → quarantine (OT22)", () => {
  it("invalid_syntax_outbox_written_events_empty_quarantine_one_row", async () => {
    const db = await openDb(DB_PATH);

    const events = [
      {
        agent: "pi" as const,
        alias: "t",
        session_id: "s1",
        event_id: "e1",
        source_schema_version: "0.1.0",
        event_ts: new Date(),
        raw_command: "if then fi (((",  // mvdan/sh rejects
        cwd_hint: "/tmp",
        exit_code: 1,
        duration_ms: 5,
      },
    ];

    const r = await ingestBatch(db, events);
    expect(r.failed).toBe(1);

    // outbox: 1 row (raw captured)
    const ob = await db.all("SELECT * FROM outbox");
    expect(ob.length).toBe(1);

    // cmd_events: 0 rows (parse failed, not processed)
    const ce = await db.all("SELECT * FROM cmd_events");
    expect(ce.length).toBe(0);

    // cmd_quarantine: 1 row, parse_status='failed', parser_version set
    const q = await db.all("SELECT * FROM cmd_quarantine");
    expect(q.length).toBe(1);
    expect(q[0].parse_status).toBe("failed");
    expect(q[0].parser_version).toBeTruthy();
    expect(typeof q[0].parser_notes).toBe("string");

    await db.close();
  });
});
