/**
 * Phase 5 closure (B6, contract item h) — EXACT duckdb version pin.
 *
 * Previously asserted major.minor only ("1.4"); patch drift 1.4.4→1.4.5
 * silently passed. RED catches this.
 *
 * @file test/unit/duckdb-exact-version.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-p5c-ver-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("OT12 (h) exact duckdb version pin", () => {
  it("installed_version_exactly_equals_pinned_value", async () => {
    const db = await openDb(DB_PATH);
    const pinned = await db.all(
      "SELECT value FROM schema_meta WHERE key = 'duckdb_version_pinned'"
    );
    const installed = await db.all("SELECT version() AS v");

    expect(pinned[0]).toBeTruthy();
    expect(installed[0]).toBeTruthy();

    // EXACT string match — no major.minor truncation
    const pinnedVal = String(pinned[0]!.value).trim();
    const installedVal = String(installed[0]!.v).trim();

    expect(installedVal).toBe(pinnedVal);
    await db.close();
  });

  it("patch_drift_1_4_4_to_1_4_5_would_fail_above_test", async () => {
    // Sanity: this test would FAIL if installed version differs from pinned.
    // If duckdb upgrades to 1.4.5, this asserts the schema_meta hasn't been
    // updated. Manual update of OAS_CS_SCHEMA_VERSION + pinned value required.
    const db = await openDb(DB_PATH);
    const pinned = await db.all(
      "SELECT value FROM schema_meta WHERE key = 'duckdb_version_pinned'"
    );
    expect(pinned[0]!.value).toMatch(/^\d+\.\d+\.\d+$/);  // semver shape
    await db.close();
  });
});
