import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import {
  getSearchDbPath,
  openSearchDb,
  initSearchSchema,
  closeSearchDb,
} from "../src/search/db";
import type {
  SearchDbOptions,
  FileWatermark,
  MsgPointer,
} from "../src/search/types";

describe("Search DB & Ephemeral Schema (Milestone 1)", () => {
  let tempDir: string;
  let originalXdgCacheHome: string | undefined;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `oas-search-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tempDir, { recursive: true });
    originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  });

  afterEach(() => {
    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── 1. getSearchDbPath() ───────────────────────────────────────────────────
  describe("getSearchDbPath()", () => {
    test("honors XDG_CACHE_HOME environment variable when set", () => {
      const customCache = join(tempDir, "custom-cache");
      process.env.XDG_CACHE_HOME = customCache;

      const dbPath = getSearchDbPath();
      expect(dbPath).toBe(join(customCache, "oas", "search.sqlite"));
    });

    test("falls back to ~/.cache/oas/search.sqlite when XDG_CACHE_HOME is unset", () => {
      delete process.env.XDG_CACHE_HOME;

      const dbPath = getSearchDbPath();
      const expectedFallback = join(homedir(), ".cache", "oas", "search.sqlite");
      expect(dbPath).toBe(expectedFallback);
    });

    test("falls back to ~/.cache/oas/search.sqlite when XDG_CACHE_HOME is empty string", () => {
      process.env.XDG_CACHE_HOME = "";

      const dbPath = getSearchDbPath();
      const expectedFallback = join(homedir(), ".cache", "oas", "search.sqlite");
      expect(dbPath).toBe(expectedFallback);
    });

    test("handles trailing slashes in XDG_CACHE_HOME gracefully", () => {
      const customCacheWithSlash = join(tempDir, "custom-cache") + "/";
      process.env.XDG_CACHE_HOME = customCacheWithSlash;

      const dbPath = getSearchDbPath();
      expect(dbPath).toBe(join(tempDir, "custom-cache", "oas", "search.sqlite"));
    });
  });

  // ─── 2. openSearchDb() & Directory Creation ─────────────────────────────────
  describe("openSearchDb()", () => {
    test("automatically creates parent directory if it does not exist", () => {
      const deepNestedDir = join(tempDir, "nested", "cache", "oas");
      const targetDbPath = join(deepNestedDir, "search.sqlite");

      expect(existsSync(deepNestedDir)).toBe(false);

      const db = openSearchDb({ dbPath: targetDbPath });
      try {
        expect(existsSync(deepNestedDir)).toBe(true);
        expect(existsSync(targetDbPath)).toBe(true);

        const result = db.query("SELECT 1 AS alive").get() as { alive: number };
        expect(result.alive).toBe(1);
      } finally {
        closeSearchDb(db);
      }
    });

    test("defaults to getSearchDbPath() when no options are provided", () => {
      const customCache = join(tempDir, "default-cache");
      process.env.XDG_CACHE_HOME = customCache;

      const expectedDbPath = join(customCache, "oas", "search.sqlite");
      const db = openSearchDb();
      try {
        expect(existsSync(expectedDbPath)).toBe(true);
      } finally {
        closeSearchDb(db);
      }
    });

    test("defaults to getSearchDbPath() when empty options object is provided", () => {
      const customCache = join(tempDir, "empty-opts-cache");
      process.env.XDG_CACHE_HOME = customCache;

      const expectedDbPath = join(customCache, "oas", "search.sqlite");
      const db = openSearchDb({});
      try {
        expect(existsSync(expectedDbPath)).toBe(true);
      } finally {
        closeSearchDb(db);
      }
    });
  });

  // ─── 3. closeSearchDb() ─────────────────────────────────────────────────────
  describe("closeSearchDb()", () => {
    test("safely closes the database connection", () => {
      const dbPath = join(tempDir, "close-test.sqlite");
      const db = openSearchDb({ dbPath });

      expect(() => db.query("SELECT 1").get()).not.toThrow();

      closeSearchDb(db);

      // Attempting queries after close should throw or fail
      expect(() => db.query("SELECT 1").get()).toThrow();
    });

    test("is safe against double close without crashing", () => {
      const dbPath = join(tempDir, "double-close-test.sqlite");
      const db = openSearchDb({ dbPath });

      closeSearchDb(db);
      expect(() => closeSearchDb(db)).not.toThrow();
    });
  });

  // ─── 4. initSearchSchema() ──────────────────────────────────────────────────
  describe("initSearchSchema()", () => {
    let db: Database;
    let dbPath: string;

    beforeEach(() => {
      dbPath = join(tempDir, "schema-test.sqlite");
      db = openSearchDb({ dbPath });
      initSearchSchema(db);
    });

    afterEach(() => {
      closeSearchDb(db);
    });

    // ─── 4a. FTS5 Virtual Table (msg_fts) ─────────────────────────────────────
    describe("FTS5 virtual table (msg_fts)", () => {
      test("creates msg_fts virtual table with content='' and contentless_delete=1", () => {
        const tableDef = db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'msg_fts'"
          )
          .get() as { sql: string } | null;

        expect(tableDef).not.toBeNull();
        const sql = tableDef!.sql.toLowerCase();
        expect(sql).toContain("fts5");
        expect(sql).toMatch(/content\s*=\s*['"]['"]/);
        expect(sql).toMatch(/contentless_delete\s*=\s*1/);
      });

      test("has required columns: user_text, assistant_text, tool_name, tool_args", () => {
        const columns = db.query("PRAGMA table_info(msg_fts)").all() as Array<{
          name: string;
        }>;
        const colNames = columns.map((c) => c.name);

        expect(colNames).toContain("user_text");
        expect(colNames).toContain("assistant_text");
        expect(colNames).toContain("tool_name");
        expect(colNames).toContain("tool_args");
      });

      test("allows insertion and BM25 matching across indexed columns", () => {
        db.run(
          "INSERT INTO msg_fts(rowid, user_text, assistant_text, tool_name, tool_args) VALUES (?, ?, ?, ?, ?)",
          [1, "How do I use ripgrep in project?", "Use rg with regex flag", "bash", "rg -i pattern"]
        );

        const matchUser = db
          .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'ripgrep'")
          .all() as Array<{ rowid: number }>;
        expect(matchUser).toEqual([{ rowid: 1 }]);

        const matchAssistant = db
          .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'regex'")
          .all() as Array<{ rowid: number }>;
        expect(matchAssistant).toEqual([{ rowid: 1 }]);

        const matchToolName = db
          .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'bash'")
          .all() as Array<{ rowid: number }>;
        expect(matchToolName).toEqual([{ rowid: 1 }]);

        const matchToolArgs = db
          .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'pattern'")
          .all() as Array<{ rowid: number }>;
        expect(matchToolArgs).toEqual([{ rowid: 1 }]);
      });

      test("verifies contentless_delete=1 by successfully deleting a row from msg_fts", () => {
        db.run(
          "INSERT INTO msg_fts(rowid, user_text, assistant_text, tool_name, tool_args) VALUES (?, ?, ?, ?, ?)",
          [42, "temporary delete test query", "will be purged", "edit", "file.ts"]
        );

        const beforeDelete = db
          .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'temporary'")
          .all() as Array<{ rowid: number }>;
        expect(beforeDelete.length).toBe(1);

        // Deleting from a contentless FTS5 table throws if contentless_delete=1 is absent.
        // With contentless_delete=1, this DELETE must succeed cleanly.
        expect(() => {
          db.run("DELETE FROM msg_fts WHERE rowid = ?", [42]);
        }).not.toThrow();

        const afterDelete = db
          .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'temporary'")
          .all() as Array<{ rowid: number }>;
        expect(afterDelete.length).toBe(0);
      });
    });

    // ─── 4b. Byte-offset Pointer Table (msg_pointers) ─────────────────────────
    describe("msg_pointers table", () => {
      test("creates msg_pointers table with exact required schema columns", () => {
        const columns = db
          .query("PRAGMA table_info(msg_pointers)")
          .all() as Array<{
          cid: number;
          name: string;
          type: string;
          notnull: number;
          dflt_value: any;
          pk: number;
        }>;

        const colMap = new Map(columns.map((c) => [c.name, c]));

        expect(colMap.has("rowid") || columns.some((c) => c.pk > 0)).toBe(true);
        expect(colMap.has("session_id")).toBe(true);
        expect(colMap.has("turn_index")).toBe(true);
        expect(colMap.has("file_id")).toBe(true);
        expect(colMap.has("byte_offset")).toBe(true);
        expect(colMap.has("byte_length")).toBe(true);
        expect(colMap.has("role")).toBe(true);
        expect(colMap.has("timestamp")).toBe(true);
        expect(colMap.has("root_session_id")).toBe(true);
      });

      test("creates index idx_msg_pointers_session_turn on (session_id, turn_index)", () => {
        const indices = db
          .query("PRAGMA index_list(msg_pointers)")
          .all() as Array<{ name: string }>;
        const indexNames = indices.map((i) => i.name);

        expect(indexNames).toContain("idx_msg_pointers_session_turn");

        const indexCols = db
          .query("PRAGMA index_info(idx_msg_pointers_session_turn)")
          .all() as Array<{ seqno: number; name: string }>;

        const indexedColumnNames = indexCols
          .sort((a, b) => a.seqno - b.seqno)
          .map((c) => c.name);

        expect(indexedColumnNames).toEqual(["session_id", "turn_index"]);
      });

      test("creates index idx_msg_pointers_file_offset on (file_id, byte_offset)", () => {
        const indices = db
          .query("PRAGMA index_list(msg_pointers)")
          .all() as Array<{ name: string }>;
        const indexNames = indices.map((i) => i.name);

        expect(indexNames).toContain("idx_msg_pointers_file_offset");

        const indexCols = db
          .query("PRAGMA index_info(idx_msg_pointers_file_offset)")
          .all() as Array<{ seqno: number; name: string }>;

        const indexedColumnNames = indexCols
          .sort((a, b) => a.seqno - b.seqno)
          .map((c) => c.name);

        expect(indexedColumnNames).toEqual(["file_id", "byte_offset"]);
      });

      test("supports inserting and querying MsgPointer records including nullable root_session_id", () => {
        const pointer1: MsgPointer = {
          rowid: 101,
          session_id: "session-abc-123",
          turn_index: 0,
          file_id: 1,
          byte_offset: 1024,
          byte_length: 256,
          role: 1, // user
          timestamp: 1725450000,
          root_session_id: "session-abc-123",
        };

        db.run(
          `INSERT INTO msg_pointers (rowid, session_id, turn_index, file_id, byte_offset, byte_length, role, timestamp, root_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            pointer1.rowid,
            pointer1.session_id,
            pointer1.turn_index,
            pointer1.file_id,
            pointer1.byte_offset,
            pointer1.byte_length,
            pointer1.role,
            pointer1.timestamp,
            pointer1.root_session_id,
          ]
        );

        // Test inserting record with null root_session_id (nullable compatibility)
        db.run(
          `INSERT INTO msg_pointers (rowid, session_id, turn_index, file_id, byte_offset, byte_length, role, timestamp, root_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [102, "session-sub-456", 1, 1, 1280, 512, 2, 1725450010, null]
        );

        const row = db
          .query("SELECT * FROM msg_pointers WHERE session_id = ? AND turn_index = ?")
          .get("session-abc-123", 0) as any;

        expect(row.rowid).toBe(101);
        expect(row.session_id).toBe("session-abc-123");
        expect(row.turn_index).toBe(0);
        expect(row.file_id).toBe(1);
        expect(row.byte_offset).toBe(1024);
        expect(row.byte_length).toBe(256);
        expect(row.role).toBe(1);
        expect(row.timestamp).toBe(1725450000);
        expect(row.root_session_id).toBe("session-abc-123");

        const subRow = db
          .query("SELECT * FROM msg_pointers WHERE rowid = ?")
          .get(102) as any;
        expect(subRow.root_session_id).toBeNull();
      });
    });

    // ─── 4c. Watermarks Table (file_watermarks) ───────────────────────────────
    describe("file_watermarks table", () => {
      test("creates file_watermarks table with required columns", () => {
        const columns = db
          .query("PRAGMA table_info(file_watermarks)")
          .all() as Array<{ name: string; type: string }>;
        const colNames = columns.map((c) => c.name);

        expect(colNames).toContain("file_id");
        expect(colNames).toContain("path");
        expect(colNames).toContain("last_scanned_bytes");
        expect(colNames).toContain("mtime");
        expect(colNames).toContain("agent");
        expect(colNames).toContain("alias");
        expect(colNames).toContain("indexed_at");
      });

      test("enforces UNIQUE constraint on file_watermarks.path", () => {
        const watermark1: FileWatermark = {
          file_id: 1,
          path: "/sessions/session-1.jsonl",
          last_scanned_bytes: 4096,
          mtime: 1725450000000,
          agent: "opencode",
          alias: "default",
          indexed_at: 1725450010000,
        };

        db.run(
          `INSERT INTO file_watermarks (path, last_scanned_bytes, mtime, agent, alias, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            watermark1.path,
            watermark1.last_scanned_bytes,
            watermark1.mtime,
            watermark1.agent,
            watermark1.alias,
            watermark1.indexed_at,
          ]
        );

        // Inserting the exact same path must throw SQLite UNIQUE constraint error
        expect(() => {
          db.run(
            `INSERT INTO file_watermarks (path, last_scanned_bytes, mtime, agent, alias, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              watermark1.path,
              8192,
              1725450020000,
              watermark1.agent,
              watermark1.alias,
              1725450025000,
            ]
          );
        }).toThrow(/UNIQUE constraint failed.*path/i);
      });

      test("auto-increments file_id on successive insertions", () => {
        const res1 = db.run(
          `INSERT INTO file_watermarks (path, last_scanned_bytes, mtime, agent, alias, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ["/sessions/a.jsonl", 0, 1000, "pi", "agent1", 2000]
        );
        const res2 = db.run(
          `INSERT INTO file_watermarks (path, last_scanned_bytes, mtime, agent, alias, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ["/sessions/b.jsonl", 0, 1000, "pi", "agent1", 2000]
        );

        const rowA = db
          .query("SELECT file_id FROM file_watermarks WHERE path = ?")
          .get("/sessions/a.jsonl") as { file_id: number };
        const rowB = db
          .query("SELECT file_id FROM file_watermarks WHERE path = ?")
          .get("/sessions/b.jsonl") as { file_id: number };

        expect(rowA.file_id).toBeGreaterThan(0);
        expect(rowB.file_id).toBeGreaterThan(rowA.file_id);
      });
    });

    // ─── 4d. Cross-table Coordination ─────────────────────────────────────────
    describe("cross-table join coordination", () => {
      test("joins msg_fts, msg_pointers, and file_watermarks by rowid and file_id", () => {
        // 1. Insert watermark
        db.run(
          `INSERT INTO file_watermarks (file_id, path, last_scanned_bytes, mtime, agent, alias, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [1, "/var/log/agent/session-001.jsonl", 2048, 1725450000, "claude", "work", 1725450005]
        );

        // 2. Insert pointer with rowid 77
        db.run(
          `INSERT INTO msg_pointers (rowid, session_id, turn_index, file_id, byte_offset, byte_length, role, timestamp, root_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [77, "session-001", 3, 1, 1024, 180, 2, 1725450003, "session-001"]
        );

        // 3. Insert contentless FTS row with same rowid 77
        db.run(
          `INSERT INTO msg_fts (rowid, user_text, assistant_text, tool_name, tool_args)
           VALUES (?, ?, ?, ?, ?)`,
          [77, "", "The database migration completed successfully", "db_migrate", "up"]
        );

        // 4. Perform join query via FTS match
        const query = `
          SELECT
            f.rowid,
            p.session_id,
            p.turn_index,
            p.byte_offset,
            p.byte_length,
            p.role,
            w.agent,
            w.alias,
            w.path
          FROM msg_fts f
          JOIN msg_pointers p ON f.rowid = p.rowid
          JOIN file_watermarks w ON p.file_id = w.file_id
          WHERE msg_fts MATCH 'migration'
        `;

        const hit = db.query(query).get() as any;
        expect(hit).not.toBeNull();
        expect(hit.rowid).toBe(77);
        expect(hit.session_id).toBe("session-001");
        expect(hit.turn_index).toBe(3);
        expect(hit.byte_offset).toBe(1024);
        expect(hit.byte_length).toBe(180);
        expect(hit.role).toBe(2);
        expect(hit.agent).toBe("claude");
        expect(hit.alias).toBe("work");
        expect(hit.path).toBe("/var/log/agent/session-001.jsonl");
      });
    });
  });

  // ─── 5. Idempotent Schema Creation ──────────────────────────────────────────
  describe("Idempotency", () => {
    test("calling initSearchSchema multiple times on the same database succeeds without error", () => {
      const dbPath = join(tempDir, "idempotent.sqlite");
      const db = openSearchDb({ dbPath });

      try {
        initSearchSchema(db);

        // Insert initial data
        db.run(
          `INSERT INTO file_watermarks (path, last_scanned_bytes, mtime, agent, alias, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ["/path/test.jsonl", 100, 1000, "opencode", "default", 1000]
        );
        db.run(
          `INSERT INTO msg_pointers (rowid, session_id, turn_index, file_id, byte_offset, byte_length, role, timestamp, root_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [1, "s1", 0, 1, 0, 50, 1, 1000, "s1"]
        );
        db.run(
          `INSERT INTO msg_fts (rowid, user_text, assistant_text, tool_name, tool_args)
           VALUES (?, ?, ?, ?, ?)`,
          [1, "testing idempotency", "", "", ""]
        );

        // Re-run initSearchSchema multiple times
        expect(() => initSearchSchema(db)).not.toThrow();
        expect(() => initSearchSchema(db)).not.toThrow();

        // Verify data was preserved intact
        const watermarkCount = db
          .query("SELECT COUNT(*) AS count FROM file_watermarks")
          .get() as { count: number };
        expect(watermarkCount.count).toBe(1);

        const pointerCount = db
          .query("SELECT COUNT(*) AS count FROM msg_pointers")
          .get() as { count: number };
        expect(pointerCount.count).toBe(1);

        const ftsMatch = db
          .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'idempotency'")
          .all() as Array<{ rowid: number }>;
        expect(ftsMatch).toEqual([{ rowid: 1 }]);
      } finally {
        closeSearchDb(db);
      }
    });
  });

  // ─── 6. Clean Rebuild Lifecycle ─────────────────────────────────────────────
  describe("Clean Rebuild Lifecycle", () => {
    test("unlinking database file and calling openSearchDb + initSearchSchema recreates schema cleanly with zero corruption", () => {
      const dbPath = join(tempDir, "rebuild.sqlite");

      // 1. Initial creation and population
      let db = openSearchDb({ dbPath });
      initSearchSchema(db);

      db.run(
        `INSERT INTO file_watermarks (path, last_scanned_bytes, mtime, agent, alias, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["/path/rebuild.jsonl", 500, 2000, "hermes", "main", 2000]
      );
      db.run(
        `INSERT INTO msg_pointers (rowid, session_id, turn_index, file_id, byte_offset, byte_length, role, timestamp, root_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [55, "s-rebuild", 0, 1, 10, 80, 1, 2000, "s-rebuild"]
      );
      db.run(
        `INSERT INTO msg_fts (rowid, user_text, assistant_text, tool_name, tool_args)
         VALUES (?, ?, ?, ?, ?)`,
        [55, "initial search payload before delete", "", "", ""]
      );

      closeSearchDb(db);

      // 2. Delete database file (and any SQLite temp files like -wal, -shm)
      expect(existsSync(dbPath)).toBe(true);
      unlinkSync(dbPath);
      if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
      if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
      expect(existsSync(dbPath)).toBe(false);

      // 3. Re-open and re-initialize
      db = openSearchDb({ dbPath });
      try {
        expect(() => initSearchSchema(db)).not.toThrow();

        // 4. Verify fresh, uncorrupted, empty schema
        const watermarkCount = db
          .query("SELECT COUNT(*) AS count FROM file_watermarks")
          .get() as { count: number };
        expect(watermarkCount.count).toBe(0);

        const pointerCount = db
          .query("SELECT COUNT(*) AS count FROM msg_pointers")
          .get() as { count: number };
        expect(pointerCount.count).toBe(0);

        const ftsCount = db
          .query("SELECT COUNT(*) AS count FROM msg_fts")
          .get() as { count: number };
        expect(ftsCount.count).toBe(0);

        // 5. Verify new insertions work seamlessly on the recreated database
        db.run(
          `INSERT INTO file_watermarks (path, last_scanned_bytes, mtime, agent, alias, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ["/path/fresh.jsonl", 10, 3000, "hermes", "main", 3000]
        );
        db.run(
          `INSERT INTO msg_pointers (rowid, session_id, turn_index, file_id, byte_offset, byte_length, role, timestamp, root_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [1, "s-fresh", 0, 1, 0, 40, 1, 3000, "s-fresh"]
        );
        db.run(
          `INSERT INTO msg_fts (rowid, user_text, assistant_text, tool_name, tool_args)
           VALUES (?, ?, ?, ?, ?)`,
          [1, "fresh search payload after recreate", "", "", ""]
        );

        const freshMatch = db
          .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'recreate'")
          .all() as Array<{ rowid: number }>;
        expect(freshMatch).toEqual([{ rowid: 1 }]);
      } finally {
        closeSearchDb(db);
      }
    });
  });

  // ─── 7. Adversarial & Edge Cases ────────────────────────────────────────────
  describe("Adversarial & Edge Cases", () => {
    test("handles special characters, spaces, and unicode in file_watermarks.path", () => {
      const dbPath = join(tempDir, "unicode-paths.sqlite");
      const db = openSearchDb({ dbPath });

      try {
        initSearchSchema(db);
        const specialPath =
          "/home/user/agent transcripts/'quotes'/spaced dir/üñîçødë-🚀-session.jsonl";

        db.run(
          `INSERT INTO file_watermarks (path, last_scanned_bytes, mtime, agent, alias, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [specialPath, 12345, 1725451234, "zcode", "alias-unicode", 1725451240]
        );

        const retrieved = db
          .query("SELECT * FROM file_watermarks WHERE path = ?")
          .get(specialPath) as FileWatermark;

        expect(retrieved).not.toBeNull();
        expect(retrieved.path).toBe(specialPath);
        expect(retrieved.agent).toBe("zcode");
      } finally {
        closeSearchDb(db);
      }
    });

    test("handles extreme boundaries for byte offsets and timestamps", () => {
      const dbPath = join(tempDir, "boundaries.sqlite");
      const db = openSearchDb({ dbPath });

      try {
        initSearchSchema(db);
        const maxSafe = Number.MAX_SAFE_INTEGER; // 9007199254740991

        db.run(
          `INSERT INTO msg_pointers (rowid, session_id, turn_index, file_id, byte_offset, byte_length, role, timestamp, root_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [maxSafe, "session-boundary", 1000000, 99999, maxSafe, 1048576, 2, maxSafe, null]
        );

        const row = db
          .query("SELECT * FROM msg_pointers WHERE rowid = ?")
          .get(maxSafe) as MsgPointer;

        expect(row).not.toBeNull();
        expect(row.rowid).toBe(maxSafe);
        expect(row.byte_offset).toBe(maxSafe);
        expect(row.timestamp).toBe(maxSafe);
      } finally {
        closeSearchDb(db);
      }
    });
  });

  // ─── 8. Truncated and Corrupt Database Auto-Recovery (M7 Remediation) ────────
  describe("Truncated and Corrupt Database Auto-Recovery", () => {
    test("recovers cleanly from a 16-byte truncated SQLite file without throwing SQLITE_NOTADB", () => {
      const corruptDbPath = join(tempDir, "corrupt-16b.sqlite");
      writeFileSync(corruptDbPath, Buffer.alloc(16, 0x41));

      const db = openSearchDb({ dbPath: corruptDbPath });
      try {
        expect(() => initSearchSchema(db)).not.toThrow();
        const alive = db.query("SELECT 1 AS alive").get() as { alive: number };
        expect(alive.alive).toBe(1);
        const ftsCount = db.query("SELECT COUNT(*) AS count FROM msg_fts").get() as { count: number };
        expect(ftsCount.count).toBe(0);
      } finally {
        closeSearchDb(db);
      }
    });

    test("recovers cleanly from a 100-byte truncated SQLite file without throwing SQLITE_CORRUPT", () => {
      const corruptDbPath = join(tempDir, "corrupt-100b.sqlite");
      writeFileSync(corruptDbPath, Buffer.alloc(100, 0x5a));

      const db = openSearchDb({ dbPath: corruptDbPath });
      try {
        expect(() => initSearchSchema(db)).not.toThrow();
        const alive = db.query("SELECT 1 AS alive").get() as { alive: number };
        expect(alive.alive).toBe(1);
        const ftsCount = db.query("SELECT COUNT(*) AS count FROM msg_fts").get() as { count: number };
        expect(ftsCount.count).toBe(0);
      } finally {
        closeSearchDb(db);
      }
    });

    test("recovers cleanly from arbitrary garbage content without unhandled crash", () => {
      const corruptDbPath = join(tempDir, "corrupt-garbage.sqlite");
      writeFileSync(corruptDbPath, "THIS IS NOT AN SQLITE DATABASE FILE HEADER GARBAGE CONTENT 1234567890\n");

      const db = openSearchDb({ dbPath: corruptDbPath });
      try {
        expect(() => initSearchSchema(db)).not.toThrow();
        const alive = db.query("SELECT 1 AS alive").get() as { alive: number };
        expect(alive.alive).toBe(1);
      } finally {
        closeSearchDb(db);
      }
    });
  });
});
