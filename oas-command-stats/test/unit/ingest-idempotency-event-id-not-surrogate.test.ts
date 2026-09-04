/**
 * OT48 / contract (g) — idempotency target is event_id, NOT surrogate id.
 *
 * Two distinct events with identical command text but different event_id MUST
 * produce 2 outbox rows (they are genuinely different invocations). The
 * conflict target is the natural key (agent, alias, session_id, event_id).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-evtid-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("idempotency on event_id not surrogate (OT48/g)", () => {
  it("same_cmd_text_different_event_id_yields_two_rows", async () => {
    const db = await openDb(DB_PATH);

    // Two events with IDENTICAL command text — but DIFFERENT event_id.
    // They are distinct invocations (e.g. user ran `git status` twice).
    const events = [
      { agent: "pi" as const, alias: "t", session_id: "s1", event_id: "byte-off-100",
        source_schema_version: "0.1.0", event_ts: new Date(1700000000000),
        raw_command: "git status", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1 },
      { agent: "pi" as const, alias: "t", session_id: "s1", event_id: "byte-off-250",
        source_schema_version: "0.1.0", event_ts: new Date(1700000001000),
        raw_command: "git status", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1 },
    ];

    const r = await ingestBatch(db, events);
    expect(r.committed).toBe(2);
    expect(r.deduped).toBe(0);

    const rows = await db.all("SELECT event_id FROM outbox ORDER BY event_id");
    expect(rows.map(r => r.event_id)).toEqual(["byte-off-100", "byte-off-250"]);
    await db.close();
  });

  it("surrogate_id_hash_collision_does_not_dedupe", async () => {
    // If we were keying on hash(raw_command) (surrogate), these two would
    // collide. We key on event_id so both survive.
    const db = await openDb(DB_PATH);
    const events = [
      { agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e1",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "echo same", cwd_hint: "/a", exit_code: 0, duration_ms: 1 },
      { agent: "pi" as const, alias: "t", session_id: "s2", event_id: "e2",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "echo same", cwd_hint: "/b", exit_code: 0, duration_ms: 1 },
    ];
    const r = await ingestBatch(db, events);
    expect(r.committed).toBe(2);
    await db.close();
  });
});
