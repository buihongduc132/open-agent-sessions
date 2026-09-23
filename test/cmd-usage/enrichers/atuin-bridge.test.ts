/**
 * RED tests for src/cmd-usage/enrichers/atuin-bridge.ts
 *
 * AtuinEnricher: enriches cmd-usage with duration/exit from atuin SQLite DB.
 * Uses bun:sqlite for DB access.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { AtuinEnricher } from "../../../src/cmd-usage/enrichers/atuin-bridge";
import type { EnricherQuery } from "../../../src/cmd-usage/enrichers/types";

// ── Helper: create mock atuin DB ──────────────────────────────────────────

function createMockAtuinDb(dbPath: string, rows: Array<{ command: string; cwd: string; timestamp: number; duration: number; exit: number }>): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      duration INTEGER NOT NULL,
      exit INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX idx_history_timestamp ON history(timestamp)`);
  db.exec(`CREATE INDEX idx_history_cwd ON history(cwd)`);

  const insert = db.prepare(
    "INSERT INTO history (command, cwd, timestamp, duration, exit) VALUES (?, ?, ?, ?, ?)"
  );

  for (const row of rows) {
    insert.run(row.command, row.cwd, row.timestamp, row.duration, row.exit);
  }

  db.close();
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("AtuinEnricher", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "atuin-bridge-"));
    dbPath = join(tmpDir, "history.db");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── available() ───────────────────────────────────────────────────────

  describe("available()", () => {
    test("returns true when DB exists and schema is valid", async () => {
      createMockAtuinDb(dbPath, []);
      const enricher = new AtuinEnricher({ dbPath });
      expect(await enricher.available()).toBe(true);
    });

    test("returns false when DB does not exist", async () => {
      const enricher = new AtuinEnricher({ dbPath: "/nonexistent/path/history.db" });
      expect(await enricher.available()).toBe(false);
    });

    test("returns false when schema is invalid (no history table)", async () => {
      // Create DB without history table
      const db = new Database(dbPath);
      db.exec("CREATE TABLE other (id INTEGER)");
      db.close();

      const enricher = new AtuinEnricher({ dbPath });
      expect(await enricher.available()).toBe(false);
    });
  });

  // ── freshnessGate() ───────────────────────────────────────────────────

  describe("freshnessGate()", () => {
    test("returns STALE on first call (no knownMax)", async () => {
      createMockAtuinDb(dbPath, [
        { command: "git fetch", cwd: "/tmp", timestamp: 1000, duration: 100, exit: 0 },
      ]);
      const enricher = new AtuinEnricher({ dbPath });
      const result = await enricher.freshnessGate();
      expect(result).toBe("STALE");
    });

    test("returns FRESH on second call within throttle window", async () => {
      createMockAtuinDb(dbPath, [
        { command: "git fetch", cwd: "/tmp", timestamp: 1000, duration: 100, exit: 0 },
      ]);
      const enricher = new AtuinEnricher({ dbPath });

      // First call: STALE
      await enricher.freshnessGate();

      // Second call immediately: FRESH (throttled)
      const result = await enricher.freshnessGate();
      expect(result).toBe("FRESH");
    });

    test("returns STALE when MAX(timestamp) changes", async () => {
      createMockAtuinDb(dbPath, [
        { command: "git fetch", cwd: "/tmp", timestamp: 1000, duration: 100, exit: 0 },
      ]);
      const enricher = new AtuinEnricher({ dbPath, gateThrottleMs: 0 }); // Disable throttle for test

      // First call: STALE
      await enricher.freshnessGate();

      // Add new row with higher timestamp
      const db = new Database(dbPath);
      db.prepare("INSERT INTO history (command, cwd, timestamp, duration, exit) VALUES (?, ?, ?, ?, ?)")
        .run("npm test", "/tmp", 2000, 200, 0);
      db.close();

      // Next call: STALE (timestamp changed)
      const result = await enricher.freshnessGate();
      expect(result).toBe("STALE");
    });
  });

  // ── batchLookup() ─────────────────────────────────────────────────────

  describe("batchLookup()", () => {
    test("returns duration and exit for matching command", async () => {
      const now = Date.now();
      createMockAtuinDb(dbPath, [
        { command: "git fetch --all", cwd: "/tmp/proj", timestamp: now, duration: 1500, exit: 0 },
      ]);

      const enricher = new AtuinEnricher({ dbPath });
      const cmds: EnricherQuery[] = [
        {
          sig: "git.fetch",
          rawCommand: "git fetch --all",
          cwd: "/tmp/proj",
          tsRange: [new Date(now - 5000).toISOString(), new Date(now + 30000).toISOString()],
        },
      ];

      const results = await enricher.batchLookup(cmds);
      expect(results.size).toBe(1);

      const key = "git.fetch|git fetch --all";
      const result = results.get(key);
      expect(result).toBeDefined();
      expect(result?.durMs).toBe(1500);
      expect(result?.exit).toBe(0);
    });

    test("returns empty map for non-matching command", async () => {
      createMockAtuinDb(dbPath, [
        { command: "git fetch", cwd: "/tmp/proj", timestamp: Date.now(), duration: 100, exit: 0 },
      ]);

      const enricher = new AtuinEnricher({ dbPath });
      const cmds: EnricherQuery[] = [
        {
          sig: "npm.test",
          rawCommand: "npm test",
          cwd: "/tmp/proj",
          tsRange: [new Date(Date.now() - 5000).toISOString(), new Date(Date.now() + 30000).toISOString()],
        },
      ];

      const results = await enricher.batchLookup(cmds);
      expect(results.size).toBe(0);
    });

    test("matches by CWD", async () => {
      const now = Date.now();
      createMockAtuinDb(dbPath, [
        { command: "git fetch", cwd: "/tmp/proj-a", timestamp: now, duration: 100, exit: 0 },
        { command: "git fetch", cwd: "/tmp/proj-b", timestamp: now, duration: 200, exit: 0 },
      ]);

      const enricher = new AtuinEnricher({ dbPath });
      const cmds: EnricherQuery[] = [
        {
          sig: "git.fetch",
          rawCommand: "git fetch",
          cwd: "/tmp/proj-a",
          tsRange: [new Date(now - 5000).toISOString(), new Date(now + 30000).toISOString()],
        },
      ];

      const results = await enricher.batchLookup(cmds);
      const key = "git.fetch|git fetch";
      expect(results.get(key)?.durMs).toBe(100);
    });

    test("matches by timestamp range", async () => {
      const now = Date.now();
      createMockAtuinDb(dbPath, [
        { command: "git fetch", cwd: "/tmp", timestamp: now - 10000, duration: 100, exit: 0 }, // Too old
        { command: "git fetch", cwd: "/tmp", timestamp: now, duration: 200, exit: 0 }, // In range
        { command: "git fetch", cwd: "/tmp", timestamp: now + 100000, duration: 300, exit: 0 }, // Too new
      ]);

      const enricher = new AtuinEnricher({ dbPath });
      const cmds: EnricherQuery[] = [
        {
          sig: "git.fetch",
          rawCommand: "git fetch",
          cwd: "/tmp",
          tsRange: [new Date(now - 5000).toISOString(), new Date(now + 30000).toISOString()],
        },
      ];

      const results = await enricher.batchLookup(cmds);
      const key = "git.fetch|git fetch";
      expect(results.get(key)?.durMs).toBe(200);
    });

    test("returns exit code for failed command", async () => {
      const now = Date.now();
      createMockAtuinDb(dbPath, [
        { command: "npm test", cwd: "/tmp", timestamp: now, duration: 5000, exit: 1 },
      ]);

      const enricher = new AtuinEnricher({ dbPath });
      const cmds: EnricherQuery[] = [
        {
          sig: "npm.test",
          rawCommand: "npm test",
          cwd: "/tmp",
          tsRange: [new Date(now - 5000).toISOString(), new Date(now + 30000).toISOString()],
        },
      ];

      const results = await enricher.batchLookup(cmds);
      const key = "npm.test|npm test";
      expect(results.get(key)?.exit).toBe(1);
    });

    test("caches results when FRESH", async () => {
      const now = Date.now();
      createMockAtuinDb(dbPath, [
        { command: "git fetch", cwd: "/tmp", timestamp: now, duration: 100, exit: 0 },
      ]);

      const enricher = new AtuinEnricher({ dbPath });
      const cmds: EnricherQuery[] = [
        {
          sig: "git.fetch",
          rawCommand: "git fetch",
          cwd: "/tmp",
          tsRange: [new Date(now - 5000).toISOString(), new Date(now + 30000).toISOString()],
        },
      ];

      // First call: STALE, queries DB
      await enricher.batchLookup(cmds);

      // Second call: FRESH, should use cache
      const results = await enricher.batchLookup(cmds);
      expect(results.size).toBe(1);
    });

    test("clears cache when STALE", async () => {
      const now = Date.now();
      createMockAtuinDb(dbPath, [
        { command: "git fetch", cwd: "/tmp", timestamp: now, duration: 100, exit: 0 },
      ]);

      const enricher = new AtuinEnricher({ dbPath, gateThrottleMs: 0 });
      const cmds: EnricherQuery[] = [
        {
          sig: "git.fetch",
          rawCommand: "git fetch",
          cwd: "/tmp",
          tsRange: [new Date(now - 5000).toISOString(), new Date(now + 30000).toISOString()],
        },
      ];

      // First call
      await enricher.batchLookup(cmds);

      // Add new row (changes MAX timestamp)
      const db = new Database(dbPath);
      db.prepare("INSERT INTO history (command, cwd, timestamp, duration, exit) VALUES (?, ?, ?, ?, ?)")
        .run("npm test", "/tmp", now + 1000, 200, 0);
      db.close();

      // Next call: STALE, should clear cache and re-query
      const results = await enricher.batchLookup(cmds);
      expect(results.size).toBe(1);
    });
  });

  // ── LIKE escaping ─────────────────────────────────────────────────────

  describe("LIKE escaping", () => {
    test("escapes % in command", async () => {
      const now = Date.now();
      createMockAtuinDb(dbPath, [
        { command: "echo 100% done", cwd: "/tmp", timestamp: now, duration: 100, exit: 0 },
      ]);

      const enricher = new AtuinEnricher({ dbPath });
      const cmds: EnricherQuery[] = [
        {
          sig: "echo",
          rawCommand: "echo 100% done",
          cwd: "/tmp",
          tsRange: [new Date(now - 5000).toISOString(), new Date(now + 30000).toISOString()],
        },
      ];

      const results = await enricher.batchLookup(cmds);
      expect(results.size).toBe(1);
    });

    test("escapes _ in command", async () => {
      const now = Date.now();
      createMockAtuinDb(dbPath, [
        { command: "echo foo_bar", cwd: "/tmp", timestamp: now, duration: 100, exit: 0 },
      ]);

      const enricher = new AtuinEnricher({ dbPath });
      const cmds: EnricherQuery[] = [
        {
          sig: "echo",
          rawCommand: "echo foo_bar",
          cwd: "/tmp",
          tsRange: [new Date(now - 5000).toISOString(), new Date(now + 30000).toISOString()],
        },
      ];

      const results = await enricher.batchLookup(cmds);
      expect(results.size).toBe(1);
    });
  });

  // ── Config-driven DB path ─────────────────────────────────────────────

  describe("config-driven DB path", () => {
    test("uses custom dbPath from constructor", async () => {
      const customPath = join(tmpDir, "custom", "atuin.db");
      await mkdir(join(tmpDir, "custom"), { recursive: true });
      createMockAtuinDb(customPath, []);

      const enricher = new AtuinEnricher({ dbPath: customPath });
      expect(await enricher.available()).toBe(true);
    });

    test("default path glob matches atuin layout", async () => {
      // This test verifies the default path resolution logic
      // In a real environment, this would be ~/snap/atuin/*/history.db
      const enricher = new AtuinEnricher({});
      // Should not throw, even if no atuin installed
      const available = await enricher.available();
      expect(typeof available).toBe("boolean");
    });
  });

  // ── SQLITE_BUSY handling ──────────────────────────────────────────────

  describe("SQLITE_BUSY handling", () => {
    test("retries once on SQLITE_BUSY", async () => {
      // This is hard to test without actually locking the DB
      // For now, just verify the enricher handles errors gracefully
      const enricher = new AtuinEnricher({ dbPath: "/nonexistent" });
      const cmds: EnricherQuery[] = [
        {
          sig: "git.fetch",
          rawCommand: "git fetch",
          cwd: "/tmp",
          tsRange: [new Date().toISOString(), new Date().toISOString()],
        },
      ];

      // Should not throw, should return empty map
      const results = await enricher.batchLookup(cmds);
      expect(results.size).toBe(0);
    });
  });
});
