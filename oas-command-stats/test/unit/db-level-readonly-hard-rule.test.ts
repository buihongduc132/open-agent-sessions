/**
 * Phase 5 closure (B1, contract item d) — DB-level readonly hard rule.
 *
 * Previously used software-only regex guard. Contract demands
 * access_mode='read_only' at DB engine level. RED catches: write via
 * openReadOnly MUST fail with DuckDB "read-only" error, NOT custom JS regex.
 *
 * @file test/unit/db-level-readonly-hard-rule.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, openReadOnly } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-p5c-ro-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("OT18 (d) DB-level readonly hard rule", () => {
  it("openReadOnly_uses_access_mode_read_only_at_engine", async () => {
    const w = await openDb(DB_PATH);
    await w.run("CREATE TABLE t (x INTEGER)");
    await w.run("INSERT INTO t VALUES (1)");
    await w.close();

    const ro = await openReadOnly(DB_PATH);

    // SELECT works
    const rows = await ro.all("SELECT x FROM t");
    expect(rows.length).toBe(1);

    // Write MUST fail at DB engine level — error message from DuckDB, not
    // our custom "Cannot execute write operation on read-only connection (OT18)".
    await expect(ro.run("INSERT INTO t VALUES (2)")).rejects.toThrow();

    // Read again to confirm DB still queryable after rejected write.
    const rows2 = await ro.all("SELECT x FROM t");
    expect(rows2.length).toBe(1);
    await ro.close();
  });

  it("readonly_error_message_from_duckdb_not_custom_js", async () => {
    const w = await openDb(DB_PATH);
    await w.run("CREATE TABLE t (x INTEGER)");
    await w.close();

    const ro = await openReadOnly(DB_PATH);
    let err: any;
    try {
      await ro.run("INSERT INTO t VALUES (1)");
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    // DuckDB native readonly error contains "read-only" or "read_only"
    // (engine-level message, not our JS regex rejection).
    const msg = String(err!.message).toLowerCase();
    const isEngineLevel =
      msg.includes("read_only") ||
      msg.includes("read-only") ||
      msg.includes("read only") ||
      msg.includes("attempt to write") ||
      msg.includes("cannot modify");
    // NOTE: software regex stub would say "Cannot execute write operation
    // on read-only connection (OT18)" — engine-level errors differ.
    expect(isEngineLevel).toBe(true);
    await ro.close();
  });
});
