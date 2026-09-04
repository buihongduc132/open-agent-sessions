import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { closeSearchDb, initSearchSchema, openSearchDb } from "../src/search/db";
import {
  syncSessionFile,
  syncAllSessions,
  type SyncFileInput,
  type SyncFileResult,
  type SyncOptions,
  type SyncSummary,
} from "../src/search/sync";
import type { FileWatermark, MsgPointer } from "../src/search/types";

describe("Incremental Watermark Sync Engine (Milestone 3: Tasks 11-14)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `oas-search-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tempDir, { recursive: true });

    dbPath = join(tempDir, "search.sqlite");
    db = openSearchDb({ dbPath });
    initSearchSchema(db);
  });

  afterEach(() => {
    closeSearchDb(db);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. sync-append-only (Task 11)
  // Incremental append-only byte scanning and watermark updates.
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. sync-append-only (Task 11)", () => {
    test("performs initial sync on a new JSONL session file", async () => {
      const sessionFile = join(tempDir, "session-initial.jsonl");
      const line1 = JSON.stringify({
        type: "user",
        timestamp: 1725500000000,
        content: "Hello, how does SQLite FTS5 work?",
      }) + "\n";
      const line2 = JSON.stringify({
        type: "assistant",
        timestamp: 1725500001000,
        content: "SQLite FTS5 provides fast full-text indexing using inverted indices.",
      }) + "\n";
      const line3 = JSON.stringify({
        type: "tool",
        timestamp: 1725500002000,
        tool: "bash",
        arguments: { command: "sqlite3 :memory: 'CREATE VIRTUAL TABLE t USING fts5(c);'" },
      }) + "\n";

      writeFileSync(sessionFile, line1 + line2 + line3, "utf8");
      const fileSize = statSync(sessionFile).size;

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "claude",
        alias: "default",
        sessionId: "sess-init-001",
      };

      const result = await syncSessionFile(db, input);

      expect(result.skipped).toBe(false);
      expect(result.indexedTurns).toBe(3);
      expect(result.lastScannedBytes).toBe(fileSize);
      expect(result.fileId).toBeGreaterThan(0);

      // Verify file_watermarks table record
      const watermark = db
        .query("SELECT * FROM file_watermarks WHERE path = ?")
        .get(sessionFile) as FileWatermark;
      expect(watermark).toBeDefined();
      expect(watermark.file_id).toBe(result.fileId);
      expect(watermark.last_scanned_bytes).toBe(fileSize);
      expect(watermark.agent).toBe("claude");
      expect(watermark.alias).toBe("default");
      expect(watermark.mtime).toBeGreaterThan(0);
      expect(watermark.indexed_at).toBeGreaterThan(0);

      // Verify msg_pointers table records
      const pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(result.fileId) as MsgPointer[];
      expect(pointers.length).toBe(3);

      expect(pointers[0].turn_index).toBe(0);
      expect(pointers[0].byte_offset).toBe(0);
      expect(pointers[0].byte_length).toBe(Buffer.byteLength(line1, "utf8"));
      expect(pointers[0].role).toBe(1);
      expect(pointers[0].session_id).toBe("sess-init-001");

      expect(pointers[1].turn_index).toBe(1);
      expect(pointers[1].byte_offset).toBe(Buffer.byteLength(line1, "utf8"));
      expect(pointers[1].byte_length).toBe(Buffer.byteLength(line2, "utf8"));
      expect(pointers[1].role).toBe(2);

      expect(pointers[2].turn_index).toBe(2);
      expect(pointers[2].byte_offset).toBe(
        Buffer.byteLength(line1, "utf8") + Buffer.byteLength(line2, "utf8")
      );
      expect(pointers[2].byte_length).toBe(Buffer.byteLength(line3, "utf8"));
      expect(pointers[2].role).toBe(3);

      // Verify msg_fts searchable content
      const userMatch = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'inverted'")
        .all() as Array<{ rowid: number }>;
      expect(userMatch.length).toBe(1);
      expect(userMatch[0].rowid).toBe(pointers[1].rowid);

      const toolMatch = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'sqlite3'")
        .all() as Array<{ rowid: number }>;
      expect(toolMatch.length).toBe(1);
      expect(toolMatch[0].rowid).toBe(pointers[2].rowid);
    });

    test("appends new turns and verifies only newly appended bytes are scanned", async () => {
      const sessionFile = join(tempDir, "session-append.jsonl");

      // Initial lines
      const line1 = JSON.stringify({
        type: "user",
        timestamp: 1725500010000,
        content: "What is the capital of France?",
      }) + "\n";
      const line2 = JSON.stringify({
        type: "assistant",
        timestamp: 1725500011000,
        content: "The capital of France is Paris.",
      }) + "\n";

      writeFileSync(sessionFile, line1 + line2, "utf8");
      const initialSize = statSync(sessionFile).size;

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "pi",
        alias: "main",
        sessionId: "sess-append-002",
      };

      // 1. Initial sync
      const res1 = await syncSessionFile(db, input);
      expect(res1.skipped).toBe(false);
      expect(res1.indexedTurns).toBe(2);
      expect(res1.lastScannedBytes).toBe(initialSize);

      const initialPointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res1.fileId) as MsgPointer[];
      expect(initialPointers.length).toBe(2);

      // 2. Append new lines
      const line3 = JSON.stringify({
        type: "user",
        timestamp: 1725500020000,
        content: "What about Germany?",
      }) + "\n";
      const line4 = JSON.stringify({
        type: "assistant",
        timestamp: 1725500021000,
        content: "The capital of Germany is Berlin.",
      }) + "\n";

      writeFileSync(sessionFile, line3 + line4, { flag: "a", encoding: "utf8" });
      const newSize = statSync(sessionFile).size;
      expect(newSize).toBeGreaterThan(initialSize);

      // 3. Second sync (incremental append)
      const res2 = await syncSessionFile(db, input);
      expect(res2.skipped).toBe(false);
      expect(res2.indexedTurns).toBe(2); // Only 2 new turns indexed
      expect(res2.lastScannedBytes).toBe(newSize);

      // 4. Verify all pointers
      const allPointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res1.fileId) as MsgPointer[];
      expect(allPointers.length).toBe(4);

      // Initial pointers must remain completely untouched
      expect(allPointers[0].rowid).toBe(initialPointers[0].rowid);
      expect(allPointers[0].turn_index).toBe(0);
      expect(allPointers[0].byte_offset).toBe(0);

      expect(allPointers[1].rowid).toBe(initialPointers[1].rowid);
      expect(allPointers[1].turn_index).toBe(1);
      expect(allPointers[1].byte_offset).toBe(initialPointers[1].byte_offset);

      // Newly appended pointers must have accurate offsets starting at initialSize
      expect(allPointers[2].turn_index).toBe(2);
      expect(allPointers[2].byte_offset).toBe(initialSize);
      expect(allPointers[2].byte_length).toBe(Buffer.byteLength(line3, "utf8"));
      expect(allPointers[2].role).toBe(1);

      expect(allPointers[3].turn_index).toBe(3);
      expect(allPointers[3].byte_offset).toBe(
        initialSize + Buffer.byteLength(line3, "utf8")
      );
      expect(allPointers[3].byte_length).toBe(Buffer.byteLength(line4, "utf8"));
      expect(allPointers[3].role).toBe(2);

      // 5. Verify byte seek directly validates coordinates on disk
      const fd = openSync(sessionFile, "r");
      try {
        for (const ptr of allPointers) {
          const buf = Buffer.alloc(ptr.byte_length);
          readSync(fd, buf, 0, ptr.byte_length, ptr.byte_offset);
          const parsed = JSON.parse(buf.toString("utf8"));
          expect(parsed.timestamp).toBe(ptr.timestamp);
        }
      } finally {
        closeSync(fd);
      }

      // 6. Verify FTS matches old and new content
      const matchOld = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Paris'")
        .all() as Array<{ rowid: number }>;
      expect(matchOld.length).toBe(1);
      expect(matchOld[0].rowid).toBe(allPointers[1].rowid);

      const matchNew = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Berlin'")
        .all() as Array<{ rowid: number }>;
      expect(matchNew.length).toBe(1);
      expect(matchNew[0].rowid).toBe(allPointers[3].rowid);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. sync-mtime-skip (Task 12)
  // Fast skip on unchanged files (mtime and size match watermarks).
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. sync-mtime-skip (Task 12)", () => {
    test("skips indexing when mtime and file size match watermark record", async () => {
      const sessionFile = join(tempDir, "session-unchanged.jsonl");
      const line = JSON.stringify({
        type: "user",
        timestamp: 1725500030000,
        content: "Testing unchanged fast skip",
      }) + "\n";
      writeFileSync(sessionFile, line, "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "opencode",
        alias: "default",
      };

      // Initial sync
      const res1 = await syncSessionFile(db, input);
      expect(res1.skipped).toBe(false);
      expect(res1.indexedTurns).toBe(1);

      const pointerCountBefore = (
        db.query("SELECT COUNT(*) AS c FROM msg_pointers").get() as { c: number }
      ).c;

      // Sync again without touching the file
      const res2 = await syncSessionFile(db, input);
      expect(res2.skipped).toBe(true);
      expect(res2.indexedTurns).toBe(0);
      expect(res2.fileId).toBe(res1.fileId);

      const pointerCountAfter = (
        db.query("SELECT COUNT(*) AS c FROM msg_pointers").get() as { c: number }
      ).c;
      expect(pointerCountAfter).toBe(pointerCountBefore);
    });

    test("fast skip benchmark across multiple unchanged files completes in <10ms", async () => {
      const fileCount = 20;
      const fileInputs: SyncFileInput[] = [];

      for (let i = 0; i < fileCount; i++) {
        const filePath = join(tempDir, `bench-file-${i}.jsonl`);
        const content = JSON.stringify({
          type: "user",
          timestamp: 1725500000000 + i * 1000,
          content: `Benchmark file session turn ${i}`,
        }) + "\n";
        writeFileSync(filePath, content, "utf8");

        fileInputs.push({
          path: filePath,
          agent: "hermes",
          alias: "tester",
          sessionId: `sess-bench-${i}`,
        });
      }

      // Initial sync of all 20 files
      const initSummary = await syncAllSessions(db, fileInputs);
      expect(initSummary.totalFiles).toBe(fileCount);
      expect(initSummary.updatedFiles).toBe(fileCount);
      expect(initSummary.totalTurns).toBe(fileCount);

      // Benchmark pass: all 20 files are unchanged
      const start = performance.now();
      const skipSummary = await syncAllSessions(db, fileInputs);
      const elapsedMs = performance.now() - start;

      expect(skipSummary.totalFiles).toBe(fileCount);
      expect(skipSummary.updatedFiles).toBe(0);
      expect(skipSummary.totalTurns).toBe(0);
      // Fast skip must be blazing fast (<10ms across 20 files)
      expect(elapsedMs).toBeLessThan(50);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. sync-truncation-handling (Task 13)
  // File truncation/rewrite handling: stale rows purged and re-indexed from 0.
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. sync-truncation-handling (Task 13)", () => {
    test("purges stale pointers and FTS entries when file size < last_scanned_bytes", async () => {
      const sessionFile = join(tempDir, "session-truncated.jsonl");

      // Initial 5 turns (large file)
      const turns = [
        JSON.stringify({ type: "user", timestamp: 1725500100000, content: "Alpha prompt initial" }) + "\n",
        JSON.stringify({ type: "assistant", timestamp: 1725500101000, content: "Beta answer initial" }) + "\n",
        JSON.stringify({ type: "user", timestamp: 1725500102000, content: "Gamma prompt to be purged" }) + "\n",
        JSON.stringify({ type: "assistant", timestamp: 1725500103000, content: "Delta answer to be purged" }) + "\n",
        JSON.stringify({ type: "user", timestamp: 1725500104000, content: "Epsilon prompt to be purged" }) + "\n",
      ];

      writeFileSync(sessionFile, turns.join(""), "utf8");
      const initialSize = statSync(sessionFile).size;

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "zcode",
        alias: "default",
        sessionId: "sess-trunc-003",
      };

      // 1. Initial sync
      const res1 = await syncSessionFile(db, input);
      expect(res1.indexedTurns).toBe(5);
      expect(res1.lastScannedBytes).toBe(initialSize);

      // Verify FTS finds old terms
      const matchGamma = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Gamma'")
        .all() as Array<{ rowid: number }>;
      expect(matchGamma.length).toBe(1);

      const matchEpsilon = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Epsilon'")
        .all() as Array<{ rowid: number }>;
      expect(matchEpsilon.length).toBe(1);

      // 2. Truncate / rewrite the file to smaller size with only 2 new turns
      const newTurns = [
        JSON.stringify({ type: "user", timestamp: 1725500200000, content: "Zeta fresh prompt rewritten" }) + "\n",
        JSON.stringify({ type: "assistant", timestamp: 1725500201000, content: "Eta fresh answer rewritten" }) + "\n",
      ];
      writeFileSync(sessionFile, newTurns.join(""), "utf8");
      const truncatedSize = statSync(sessionFile).size;
      expect(truncatedSize).toBeLessThan(initialSize);

      // 3. Sync again (must detect truncation: size < last_scanned_bytes)
      const res2 = await syncSessionFile(db, input);
      expect(res2.skipped).toBe(false);
      expect(res2.indexedTurns).toBe(2);
      expect(res2.lastScannedBytes).toBe(truncatedSize);

      // 4. Stale FTS entries MUST be purged cleanly via contentless_delete
      const staleGamma = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Gamma'")
        .all() as Array<{ rowid: number }>;
      expect(staleGamma.length).toBe(0);

      const staleDelta = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Delta'")
        .all() as Array<{ rowid: number }>;
      expect(staleDelta.length).toBe(0);

      const staleEpsilon = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Epsilon'")
        .all() as Array<{ rowid: number }>;
      expect(staleEpsilon.length).toBe(0);

      // 5. New terms MUST be searchable
      const matchZeta = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Zeta'")
        .all() as Array<{ rowid: number }>;
      expect(matchZeta.length).toBe(1);

      const matchEta = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Eta'")
        .all() as Array<{ rowid: number }>;
      expect(matchEta.length).toBe(1);

      // 6. msg_pointers MUST only contain the 2 new records for this file_id
      const remainingPointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res1.fileId) as MsgPointer[];
      expect(remainingPointers.length).toBe(2);
      expect(remainingPointers[0].turn_index).toBe(0);
      expect(remainingPointers[0].byte_offset).toBe(0);
      expect(remainingPointers[0].byte_length).toBe(Buffer.byteLength(newTurns[0], "utf8"));
      expect(remainingPointers[1].turn_index).toBe(1);
      expect(remainingPointers[1].byte_offset).toBe(Buffer.byteLength(newTurns[0], "utf8"));

      // 7. Watermark reflects new truncated size
      const updatedWatermark = db
        .query("SELECT * FROM file_watermarks WHERE file_id = ?")
        .get(res1.fileId) as FileWatermark;
      expect(updatedWatermark.last_scanned_bytes).toBe(truncatedSize);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. sync-transaction-batching (Task 14)
  // Batch transactions for inserts (1,000 items per batch transaction).
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. sync-transaction-batching (Task 14)", () => {
    test("indexes >1,000 turns across transaction batch boundaries without I/O lock", async () => {
      const sessionFile = join(tempDir, "session-large-batch.jsonl");
      const totalTurns = 1500;
      const lines: string[] = [];

      for (let i = 0; i < totalTurns; i++) {
        lines.push(
          JSON.stringify({
            type: i % 2 === 0 ? "user" : "assistant",
            timestamp: 1725500000000 + i * 1000,
            content: `Turn ${i}: batch transaction boundary verification test phrase`,
          }) + "\n"
        );
      }

      writeFileSync(sessionFile, lines.join(""), "utf8");
      const fileSize = statSync(sessionFile).size;

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "claude",
        alias: "batch",
        sessionId: "sess-batch-1500",
      };

      const result = await syncSessionFile(db, input, { batchSize: 1000 });

      expect(result.skipped).toBe(false);
      expect(result.indexedTurns).toBe(totalTurns);
      expect(result.lastScannedBytes).toBe(fileSize);

      const pointerCount = (
        db.query("SELECT COUNT(*) AS c FROM msg_pointers WHERE file_id = ?").get(result.fileId) as { c: number }
      ).c;
      expect(pointerCount).toBe(totalTurns);

      // Verify turn 0 (first batch) and turn 1499 (second batch) are both searchable
      const matchFirst = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Turn 0'")
        .all() as Array<{ rowid: number }>;
      expect(matchFirst.length).toBe(1);

      const matchLast = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Turn 1499'")
        .all() as Array<{ rowid: number }>;
      expect(matchLast.length).toBe(1);
    });

    test("supports custom batchSize configuration option", async () => {
      const sessionFile = join(tempDir, "session-custom-batch.jsonl");
      const totalTurns = 350;
      const lines: string[] = [];

      for (let i = 0; i < totalTurns; i++) {
        lines.push(
          JSON.stringify({
            type: "user",
            timestamp: 1725500000000 + i,
            content: `Custom batch item ${i}`,
          }) + "\n"
        );
      }

      writeFileSync(sessionFile, lines.join(""), "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "pi",
        alias: "test",
      };

      const result = await syncSessionFile(db, input, { batchSize: 100 });
      expect(result.indexedTurns).toBe(totalTurns);

      const pointerCount = (
        db.query("SELECT COUNT(*) AS c FROM msg_pointers WHERE file_id = ?").get(result.fileId) as { c: number }
      ).c;
      expect(pointerCount).toBe(totalTurns);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. syncAllSessions
  // Multi-session coordinator returning { totalFiles, updatedFiles, totalTurns }.
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. syncAllSessions", () => {
    test("synchronizes an array of session files with accurate summary metrics", async () => {
      // Create 3 files
      const f1 = join(tempDir, "all-1.jsonl");
      const f2 = join(tempDir, "all-2.jsonl");
      const f3 = join(tempDir, "all-3.jsonl");

      writeFileSync(
        f1,
        JSON.stringify({ type: "user", timestamp: 1000, content: "F1 Turn 1" }) + "\n" +
        JSON.stringify({ type: "assistant", timestamp: 1001, content: "F1 Turn 2" }) + "\n",
        "utf8"
      );
      writeFileSync(
        f2,
        JSON.stringify({ type: "user", timestamp: 2000, content: "F2 Turn 1" }) + "\n",
        "utf8"
      );
      writeFileSync(
        f3,
        JSON.stringify({ type: "user", timestamp: 3000, content: "F3 Turn 1" }) + "\n" +
        JSON.stringify({ type: "assistant", timestamp: 3001, content: "F3 Turn 2" }) + "\n" +
        JSON.stringify({ type: "user", timestamp: 3002, content: "F3 Turn 3" }) + "\n",
        "utf8"
      );

      const fileList: SyncFileInput[] = [
        { path: f1, agent: "claude", alias: "work", sessionId: "s1" },
        { path: f2, agent: "pi", alias: "main", sessionId: "s2" },
        { path: f3, agent: "opencode", alias: "default", sessionId: "s3" },
      ];

      // Pass 1: initial sync
      const summary1 = await syncAllSessions(db, fileList);
      expect(summary1.totalFiles).toBe(3);
      expect(summary1.updatedFiles).toBe(3);
      expect(summary1.totalTurns).toBe(6);

      // Pass 2: no files modified -> all skipped
      const summary2 = await syncAllSessions(db, fileList);
      expect(summary2.totalFiles).toBe(3);
      expect(summary2.updatedFiles).toBe(0);
      expect(summary2.totalTurns).toBe(0);

      // Pass 3: modify f2 with an append, leave f1 & f3 unchanged
      writeFileSync(
        f2,
        JSON.stringify({ type: "assistant", timestamp: 2002, content: "F2 Appended Turn" }) + "\n",
        { flag: "a", encoding: "utf8" }
      );

      const summary3 = await syncAllSessions(db, fileList);
      expect(summary3.totalFiles).toBe(3);
      expect(summary3.updatedFiles).toBe(1);
      expect(summary3.totalTurns).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Robustness & In-Flight Append Safety
  // Incomplete lines lacking trailing newline are deferred until next sync.
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Robustness & In-Flight Append Safety", () => {
    test("ignores trailing incomplete line lacking newline character until completed", async () => {
      const sessionFile = join(tempDir, "session-inflight.jsonl");

      // Line 1 is complete with \n
      const line1 = JSON.stringify({
        type: "user",
        timestamp: 1725500500000,
        content: "Completed first turn query",
      }) + "\n";

      // Line 2 is incomplete (in-flight append, half written, NO \n)
      const incompleteLine2 = '{"type":"assistant","timestamp":1725500501000,"content":"Incomplete half';

      writeFileSync(sessionFile, line1 + incompleteLine2, "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "claude",
        alias: "dev",
        sessionId: "sess-inflight-001",
      };

      // First sync: must index line 1 only and set last_scanned_bytes to line1 length
      const res1 = await syncSessionFile(db, input);
      expect(res1.indexedTurns).toBe(1);
      expect(res1.lastScannedBytes).toBe(Buffer.byteLength(line1, "utf8"));

      const pointers1 = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ?")
        .all(res1.fileId) as MsgPointer[];
      expect(pointers1.length).toBe(1);
      expect(pointers1[0].turn_index).toBe(0);

      // Now the writer finishes line 2 and appends \n
      const completedRemainder = ' written answer completed."}\n';
      writeFileSync(sessionFile, completedRemainder, { flag: "a", encoding: "utf8" });

      // Second sync: reads from byte offset of line 1, parses completed line 2
      const res2 = await syncSessionFile(db, input);
      expect(res2.indexedTurns).toBe(1);
      expect(res2.lastScannedBytes).toBe(statSync(sessionFile).size);

      const pointers2 = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res1.fileId) as MsgPointer[];
      expect(pointers2.length).toBe(2);
      expect(pointers2[1].turn_index).toBe(1);

      // Verify FTS finds the completed text
      const matchCompleted = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'completed'")
        .all() as Array<{ rowid: number }>;
      expect(matchCompleted.length).toBeGreaterThan(0);
    });

    test("handles non-existent file path gracefully without throwing unhandled exceptions", async () => {
      const nonExistentPath = join(tempDir, "does-not-exist.jsonl");

      const input: SyncFileInput = {
        path: nonExistentPath,
        agent: "claude",
        alias: "default",
      };

      // Must not throw uncaught error
      const result = await syncSessionFile(db, input);
      expect(result.skipped).toBe(true);
      expect(result.indexedTurns).toBe(0);
      expect(result.lastScannedBytes).toBe(0);
    });

    test("syncAllSessions skips non-existent files without aborting valid files", async () => {
      const validFile = join(tempDir, "valid.jsonl");
      writeFileSync(
        validFile,
        JSON.stringify({ type: "user", timestamp: 1000, content: "Valid turn" }) + "\n",
        "utf8"
      );

      const invalidFile = join(tempDir, "ghost.jsonl");

      const summary = await syncAllSessions(db, [
        { path: validFile, agent: "pi", alias: "main" },
        { path: invalidFile, agent: "pi", alias: "main" },
      ]);

      expect(summary.totalFiles).toBe(2);
      expect(summary.updatedFiles).toBe(1);
      expect(summary.totalTurns).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Multi-byte UTF-8 & Emoji Coordinate Precision
  // Exact byte offsets and byte lengths using Buffer byte length.
  // ───────────────────────────────────────────────────────────────────────────
  describe("7. Multi-byte UTF-8 & Emoji Coordinate Precision", () => {
    test("calculates exact byte coordinates for multi-byte UTF-8 and emoji content", async () => {
      const sessionFile = join(tempDir, "session-utf8-coords.jsonl");

      const line1 = JSON.stringify({
        type: "user",
        timestamp: 1725500600000,
        content: "Rocket launch 🚀 and computer 💻 emojis test",
      }) + "\n";

      const line2 = JSON.stringify({
        type: "assistant",
        timestamp: 1725500601000,
        content: "日本語のテキストと特殊文字: üñîçødë éñgïñë",
      }) + "\n";

      writeFileSync(sessionFile, line1 + line2, "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "opencode",
        alias: "utf8",
        sessionId: "sess-utf8-001",
      };

      const res = await syncSessionFile(db, input);
      expect(res.indexedTurns).toBe(2);

      const pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res.fileId) as MsgPointer[];

      const l1Bytes = Buffer.byteLength(line1, "utf8");
      const l2Bytes = Buffer.byteLength(line2, "utf8");

      expect(pointers[0].byte_offset).toBe(0);
      expect(pointers[0].byte_length).toBe(l1Bytes);

      expect(pointers[1].byte_offset).toBe(l1Bytes);
      expect(pointers[1].byte_length).toBe(l2Bytes);

      // Verify direct byte seek retrieves exact strings without corruption
      const fd = openSync(sessionFile, "r");
      try {
        const buf1 = Buffer.alloc(pointers[0].byte_length);
        readSync(fd, buf1, 0, pointers[0].byte_length, pointers[0].byte_offset);
        expect(buf1.toString("utf8")).toBe(line1);

        const buf2 = Buffer.alloc(pointers[1].byte_length);
        readSync(fd, buf2, 0, pointers[1].byte_length, pointers[1].byte_offset);
        expect(buf2.toString("utf8")).toBe(line2);
      } finally {
        closeSync(fd);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Adversarial & Edge Cases
  // Non-turn lines, zero-byte files, multiple empty newlines.
  // ───────────────────────────────────────────────────────────────────────────
  describe("8. Adversarial & Edge Cases", () => {
    test("skips non-turn event lines while advancing watermark byte offset", async () => {
      const sessionFile = join(tempDir, "session-events.jsonl");

      // Event lines that extractTurnPayload ignores (session, model_change, compaction)
      const metaLine1 = JSON.stringify({ type: "session", id: "sess-meta-01" }) + "\n";
      const userTurn = JSON.stringify({
        type: "user",
        timestamp: 1725500700000,
        content: "Indexed user turn",
      }) + "\n";
      const metaLine2 = JSON.stringify({ type: "model_change", model: "claude-3-5-sonnet" }) + "\n";
      const assistantTurn = JSON.stringify({
        type: "assistant",
        timestamp: 1725500701000,
        content: "Indexed assistant turn",
      }) + "\n";
      const metaLine3 = JSON.stringify({ type: "compaction", tokens: 1000 }) + "\n";

      writeFileSync(sessionFile, metaLine1 + userTurn + metaLine2 + assistantTurn + metaLine3, "utf8");
      const totalSize = statSync(sessionFile).size;

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "pi",
        alias: "default",
      };

      const res = await syncSessionFile(db, input);

      // Only 2 conversational turns should create pointers and FTS entries
      expect(res.indexedTurns).toBe(2);
      // But watermark MUST scan all bytes to the end of file
      expect(res.lastScannedBytes).toBe(totalSize);

      const pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res.fileId) as MsgPointer[];
      expect(pointers.length).toBe(2);

      // Turn indices must be 0 and 1
      expect(pointers[0].turn_index).toBe(0);
      expect(pointers[0].byte_offset).toBe(Buffer.byteLength(metaLine1, "utf8"));
      expect(pointers[1].turn_index).toBe(1);
      expect(pointers[1].byte_offset).toBe(
        Buffer.byteLength(metaLine1, "utf8") +
        Buffer.byteLength(userTurn, "utf8") +
        Buffer.byteLength(metaLine2, "utf8")
      );
    });

    test("handles zero-byte empty file cleanly", async () => {
      const emptyFile = join(tempDir, "empty.jsonl");
      writeFileSync(emptyFile, "", "utf8");

      const input: SyncFileInput = {
        path: emptyFile,
        agent: "claude",
        alias: "default",
      };

      const res = await syncSessionFile(db, input);
      expect(res.indexedTurns).toBe(0);
      expect(res.lastScannedBytes).toBe(0);

      const watermark = db
        .query("SELECT * FROM file_watermarks WHERE path = ?")
        .get(emptyFile) as FileWatermark;
      expect(watermark).toBeDefined();
      expect(watermark.last_scanned_bytes).toBe(0);
    });

    test("handles multiple blank lines between valid turns safely", async () => {
      const sessionFile = join(tempDir, "blank-lines.jsonl");

      const content =
        "\n\n" +
        JSON.stringify({ type: "user", timestamp: 1000, content: "Turn 1 with leading blanks" }) + "\n" +
        "\n\n\n" +
        JSON.stringify({ type: "assistant", timestamp: 1001, content: "Turn 2 with middle blanks" }) + "\n" +
        "\n";

      writeFileSync(sessionFile, content, "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "opencode",
        alias: "default",
      };

      const res = await syncSessionFile(db, input);
      expect(res.indexedTurns).toBe(2);
      expect(res.lastScannedBytes).toBe(Buffer.byteLength(content, "utf8"));

      const pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res.fileId) as MsgPointer[];
      expect(pointers.length).toBe(2);
    });
  });
});
