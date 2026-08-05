/**
 * OT49-X4 — source_schema_version gate.
 *
 * Each batch carries a source_schema_version. If the version is unknown
 * (upstream adapter schema drift), ingestBatch MUST throw SchemaVersionError
 * and commit 0 rows. Fail loud, not silent.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb } from "../../src/storage/duckdb";
import { SchemaVersionError, KNOWN_SOURCE_SCHEMA_VERSIONS } from "../../src/storage/schema";

const DB_PATH = join(tmpdir(), `oas-cs-schemaver-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("ingestBatch — OT49-X4 source_schema_version", () => {
  it("unknown_schema_version_aborts_batch_zero_rows_committed", async () => {
    const db = await openDb(DB_PATH);
    const events = [
      {
        agent: "pi" as const,
        alias: "t",
        session_id: "s1",
        event_id: "e1",
        source_schema_version: "99.99.99", // unknown
        event_ts: new Date(),
        raw_command: "echo hi",
        cwd_hint: "/tmp",
        exit_code: 0,
        duration_ms: 5,
      },
    ];

    await expect(ingestBatch(db, events)).rejects.toBeInstanceOf(SchemaVersionError);

    const n = await db.all("SELECT COUNT(*) AS n FROM outbox");
    expect(n[0].n).toBe(0);
    await db.close();
  });

  it("known_schema_version_proceeds_normally", async () => {
    const db = await openDb(DB_PATH);
    const knownVer = KNOWN_SOURCE_SCHEMA_VERSIONS[0];
    expect(knownVer).toBeDefined();

    const events = [
      {
        agent: "pi" as const,
        alias: "t",
        session_id: "s1",
        event_id: "e1",
        source_schema_version: knownVer,
        event_ts: new Date(),
        raw_command: "echo hi",
        cwd_hint: "/tmp",
        exit_code: 0,
        duration_ms: 5,
      },
    ];
    const r = await ingestBatch(db, events);
    expect(r.committed).toBe(1);
    await db.close();
  });
});
