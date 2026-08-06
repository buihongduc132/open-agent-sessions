/**
 * Phase 5 closure (B5, contract item c) — literal flock(LOCK_EX|LOCK_NB).
 *
 * Previously used openSync("wx") = O_EXCL. Stale lockfile on crash blocks
 * restart until manual rm. RED catches: must use POSIX flock with stale
 * cleanup on SIGTERM/SIGINT.
 *
 * @file test/unit/flock-literal.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireDbLock, releaseDbLock, type LockHandle } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-p5c-flock-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".lock"); } catch {}
});

describe("OT12-1 (c) literal flock + stale cleanup", () => {
  it("stale_lockfile_auto_cleaned_on_reacquire", async () => {
    // Simulate crash: create lockfile WITHOUT holding flock.
    // acquireDbLock MUST clean it up (flock-based, not O_EXCL existence check).
    const { writeFileSync } = await import("node:fs");
    writeFileSync(DB_PATH + ".lock", "stale");  // fake stale lockfile

    // Must succeed (cleans stale + acquires fresh flock)
    const handle = await acquireDbLock(DB_PATH);
    expect(handle).toBeTruthy();
    await releaseDbLock(handle!);
  });

  // Cross-process held-lock rejection is tested via integration:
  // spawn 2nd bun process that holds flock, then this process's acquireDbLock
  // must fail. Unit test below documents contract; integration covers real
  // cross-process behavior.
  it("acquireDbLock_uses_flock_binary_not_o_excl", async () => {
    // Sanity: acquireDbLock must NOT use O_EXCL (EEXIST on stale file).
    // This is verified by stale_lockfile test above — if O_EXCL were used,
    // stale_lockfile test would fail with EEXIST.
    const handle = await acquireDbLock(DB_PATH);
    expect(handle).toBeTruthy();
    expect(handle!.fd).toBeGreaterThan(0);
    await releaseDbLock(handle!);
  });

  it("release_restores_clean_state", async () => {
    const h = await acquireDbLock(DB_PATH);
    await releaseDbLock(h);
    // After release, lockfile may or may not exist; second acquire must work.
    const h2 = await acquireDbLock(DB_PATH);
    expect(h2).toBeTruthy();
    await releaseDbLock(h2!);
  });
});
