/**
 * OT18 prep — read-only connection mode for queries.
 *
 * access_mode='read_only' on a DuckDB connection MUST:
 *   - allow SELECT
 *   - reject INSERT with an error (fail loud, not silent)
 *
 * Phase 5 will use this hard rule for all query connections.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, openReadOnly } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-ro-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("read-only connection (OT18 prep)", () => {
  it("select_works_on_readonly", async () => {
    const w = await openDb(DB_PATH);
    await w.run("CREATE TABLE t (x INTEGER)");
    await w.run("INSERT INTO t VALUES (1)");
    await w.close();

    const ro = await openReadOnly(DB_PATH);
    const rows = await ro.all("SELECT x FROM t");
    expect(rows.length).toBe(1);
    expect(rows[0].x).toBe(1);
    await ro.close();
  });

  it("insert_throws_on_readonly", async () => {
    const w = await openDb(DB_PATH);
    await w.run("CREATE TABLE t (x INTEGER)");
    await w.close();

    const ro = await openReadOnly(DB_PATH);
    await expect(ro.run("INSERT INTO t VALUES (1)")).rejects.toThrow();
    await ro.close();
  });
});
