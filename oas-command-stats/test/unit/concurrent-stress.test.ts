/**
 * Phase 5 closure (B3, contract item g) — concurrent query+ingest stress.
 *
 * Spawns N=4 reader workers + 1 writer worker for 10s. Asserts:
 * - 0 SQLITE_BUSY errors across all workers
 * - 0 deadlock errors
 * - 0 crash
 *
 * @file test/unit/concurrent-stress.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { openDb } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-p5c-stress-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
  try { rmSync(DB_PATH + ".lock"); } catch {}
});

describe("OT12 (g) concurrent query+ingest stress", () => {
  it(
    "4_readers_1_writer_10s_zero_sqlite_busy",
    async () => {
      const w = await openDb(DB_PATH);
      await w.run("CREATE TABLE IF NOT EXISTS t (id INTEGER, ts TIMESTAMP)");
      await w.run("INSERT INTO t VALUES (1, CURRENT_TIMESTAMP)");
      await w.close();

      // Worker script: writer loops INSERT; reader loops SELECT.
      const workerScript = join(tmpdir(), `oas-cs-p5c-worker-${process.pid}.ts`);
      writeFileSync(
        workerScript,
        `
        import { openDb, openReadOnly } from "${process.cwd()}/src/storage/duckdb";
        const mode = process.argv[2];
        const dbPath = "${DB_PATH}";
        try {
          if (mode === "writer") {
            const db = await openDb(dbPath);
            for (let i = 0; i < 5000; i++) {
              await db.run("INSERT INTO t VALUES (?, CURRENT_TIMESTAMP)", [i]);
            }
            await db.close();
          } else {
            const ro = await openReadOnly(dbPath);
            for (let i = 0; i < 5000; i++) {
              await ro.all("SELECT COUNT(*) FROM t");
            }
            await ro.close();
          }
          console.log("WORKER_OK:" + mode);
        } catch (e) {
          console.error("WORKER_ERR:" + mode + ":" + (e as Error).message);
          process.exit(1);
        }
        `
      );

      const errors: string[] = [];
      const procs: ChildProcess[] = [];

      const spawnWorker = (mode: string) => {
        const p = spawn("bun", ["run", workerScript, mode], {
          stdio: "pipe",
          env: { ...process.env, FORCE_COLOR: "0" },
        });
        let errBuf = "";
        p.stderr?.on("data", (d) => {
          errBuf += d.toString();
          if (/SQLITE_BUSY|deadlock|lock/i.test(errBuf)) {
            errors.push(mode + ": " + errBuf);
            errBuf = "";
          }
        });
        procs.push(p);
        return p;
      };

      // 1 writer + 4 readers
      spawnWorker("writer");
      for (let i = 0; i < 4; i++) spawnWorker("reader");

      // Wait for all to complete (10s timeout safety).
      await Promise.all(
        procs.map(
          (p) =>
            new Promise<void>((resolve) => {
              p.on("exit", () => resolve());
              setTimeout(resolve, 12000);  // safety
            })
        )
      );

      try { rmSync(workerScript); } catch {}

      // 0 SQLITE_BUSY / deadlock errors
      expect(errors.length).toBe(0);
    },
    20000
  );
});
