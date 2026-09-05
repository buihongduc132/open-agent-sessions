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
} from "../src/search/sync";
import type { FileWatermark, MsgPointer } from "../src/search/types";

describe("Milestone 3 Challenger Adversarial Stress Suite (src/search/sync.ts)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `oas-sync-adversarial-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

  // Helper to read disk slice directly
  function readDiskSlice(filePath: string, offset: number, length: number): string {
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, offset);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CHALLENGE 1: Rapid Sequential Appends Simulating Live Active Session
  // ───────────────────────────────────────────────────────────────────────────
  describe("Challenge 1: Rapid Sequential Appends Simulating Live Active Session", () => {
    test("50 rapid burst appends with sync after each burst maintains strict monotonic turn_index and exact byte offsets", async () => {
      const sessionFile = join(tempDir, "live-active-session.jsonl");
      writeFileSync(sessionFile, "", "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "claude",
        alias: "live-session",
        sessionId: "sess-live-001",
      };

      const totalBursts = 50;
      let expectedTurnIndex = 0;
      let totalBytesOnDisk = 0;

      for (let burst = 0; burst < totalBursts; burst++) {
        // Each burst appends 1 to 3 turns with varying content
        const turnsInBurst = (burst % 3) + 1;
        let burstContent = "";

        for (let t = 0; t < turnsInBurst; t++) {
          const currentTurn = expectedTurnIndex + t;
          const role = currentTurn % 2 === 0 ? "user" : "assistant";
          const turnObj = {
            type: role,
            timestamp: 1725500000000 + currentTurn * 1000,
            content: `Burst ${burst} Turn ${currentTurn} content token_${currentTurn}_xyz`,
          };
          burstContent += JSON.stringify(turnObj) + "\n";
        }

        writeFileSync(sessionFile, burstContent, { flag: "a", encoding: "utf8" });
        const newFileSize = statSync(sessionFile).size;
        totalBytesOnDisk = newFileSize;

        // Run sync pass immediately following the burst
        const result = await syncSessionFile(db, input);

        expect(result.skipped).toBe(false);
        expect(result.indexedTurns).toBe(turnsInBurst);
        expect(result.lastScannedBytes).toBe(totalBytesOnDisk);

        expectedTurnIndex += turnsInBurst;

        // Verify watermark in DB
        const watermark = db
          .query("SELECT * FROM file_watermarks WHERE file_id = ?")
          .get(result.fileId) as FileWatermark;
        expect(watermark.last_scanned_bytes).toBe(totalBytesOnDisk);
      }

      // After all 50 bursts, verify full pointer table integrity
      const allPointers = db
        .query("SELECT * FROM msg_pointers WHERE session_id = 'sess-live-001' ORDER BY turn_index ASC")
        .all() as MsgPointer[];

      expect(allPointers.length).toBe(expectedTurnIndex);

      // Verify strict monotonicity of turn_index and offset continuity
      for (let i = 0; i < allPointers.length; i++) {
        const ptr = allPointers[i];
        expect(ptr.turn_index).toBe(i);

        if (i === 0) {
          expect(ptr.byte_offset).toBe(0);
        } else {
          const prevPtr = allPointers[i - 1];
          expect(ptr.byte_offset).toBe(prevPtr.byte_offset + prevPtr.byte_length);
        }

        // Verify direct byte seek on disk returns valid JSON matching pointer
        const diskContent = readDiskSlice(sessionFile, ptr.byte_offset, ptr.byte_length);
        const parsed = JSON.parse(diskContent);
        expect(parsed.timestamp).toBe(ptr.timestamp);
      }

      // Verify total FTS rows matches pointer count exactly
      const ftsCount = (
        db.query("SELECT count(*) AS c FROM msg_fts").get() as { c: number }
      ).c;
      expect(ftsCount).toBe(expectedTurnIndex);

      // Verify individual token searches across start, middle, and end turns
      const firstHit = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'token_0_xyz'")
        .all() as Array<{ rowid: number }>;
      expect(firstHit.length).toBe(1);
      expect(firstHit[0].rowid).toBe(allPointers[0].rowid);

      const midIndex = Math.floor(expectedTurnIndex / 2);
      const midHit = db
        .query(`SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'token_${midIndex}_xyz'`)
        .all() as Array<{ rowid: number }>;
      expect(midHit.length).toBe(1);
      expect(midHit[0].rowid).toBe(allPointers[midIndex].rowid);

      const lastIndex = expectedTurnIndex - 1;
      const lastHit = db
        .query(`SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'token_${lastIndex}_xyz'`)
        .all() as Array<{ rowid: number }>;
      expect(lastHit.length).toBe(1);
      expect(lastHit[0].rowid).toBe(allPointers[lastIndex].rowid);
    });

    test("interleaved multi-file rapid appends across 5 concurrent sessions verify file_id isolation", async () => {
      const sessionCount = 5;
      const fileInputs: SyncFileInput[] = [];
      const sessionPaths: string[] = [];

      for (let s = 0; s < sessionCount; s++) {
        const p = join(tempDir, `multi-session-${s}.jsonl`);
        writeFileSync(p, "", "utf8");
        sessionPaths.push(p);
        fileInputs.push({
          path: p,
          agent: s % 2 === 0 ? "claude" : "pi",
          alias: `alias-${s}`,
          sessionId: `sess-multi-${s}`,
        });
      }

      const turnsPerSession = 10;

      // 10 rounds of interleaved appends to all sessions
      for (let round = 0; round < turnsPerSession; round++) {
        for (let s = 0; s < sessionCount; s++) {
          const line = JSON.stringify({
            type: "user",
            timestamp: 1725500000000 + round * 1000 + s,
            content: `Session ${s} Round ${round} unique_val_s${s}_r${round}`,
          }) + "\n";
          writeFileSync(sessionPaths[s], line, { flag: "a", encoding: "utf8" });
        }

        const summary = await syncAllSessions(db, fileInputs);
        expect(summary.totalFiles).toBe(sessionCount);
        expect(summary.updatedFiles).toBe(sessionCount);
        expect(summary.totalTurns).toBe(sessionCount);
      }

      // Verify each session file has exactly 10 pointers with turn_index 0..9
      for (let s = 0; s < sessionCount; s++) {
        const pointers = db
          .query("SELECT * FROM msg_pointers WHERE session_id = ? ORDER BY turn_index ASC")
          .all(`sess-multi-${s}`) as MsgPointer[];

        expect(pointers.length).toBe(turnsPerSession);
        for (let t = 0; t < turnsPerSession; t++) {
          expect(pointers[t].turn_index).toBe(t);
        }

        // Search for unique value from session s round 5
        const hit = db
          .query(`SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'unique_val_s${s}_r5'`)
          .all() as Array<{ rowid: number }>;
        expect(hit.length).toBe(1);
        expect(hit[0].rowid).toBe(pointers[5].rowid);
      }

      // Total FTS rows should be exactly sessionCount * turnsPerSession
      const totalFts = (
        db.query("SELECT count(*) AS c FROM msg_fts").get() as { c: number }
      ).c;
      expect(totalFts).toBe(sessionCount * turnsPerSession);
    });

    test("repeated sync passes with zero appends consistently fast-skip (<2ms)", async () => {
      const sessionFile = join(tempDir, "idle-session.jsonl");
      const content = JSON.stringify({
        type: "user",
        timestamp: 1725500000000,
        content: "Static unchanged content line",
      }) + "\n";
      writeFileSync(sessionFile, content, "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "opencode",
        alias: "default",
      };

      // Initial sync
      const resInit = await syncSessionFile(db, input);
      expect(resInit.skipped).toBe(false);
      expect(resInit.indexedTurns).toBe(1);

      // Repeat sync 20 times in a row
      const start = performance.now();
      for (let i = 0; i < 20; i++) {
        const resSkip = await syncSessionFile(db, input);
        expect(resSkip.skipped).toBe(true);
        expect(resSkip.indexedTurns).toBe(0);
        expect(resSkip.fileId).toBe(resInit.fileId);
      }
      const totalElapsed = performance.now() - start;
      const perPassMs = totalElapsed / 20;

      // Each skip pass should take less than 5ms
      expect(perPassMs).toBeLessThan(5);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CHALLENGE 2: File Truncation Mid-Stream (50KB -> 10KB)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Challenge 2: File Truncation Mid-Stream (50KB -> 10KB)", () => {
    test("truncating file from 50KB to 10KB purges stale FTS rows, leaves zero ghost pointers, and preserves FTS/pointer symmetry", async () => {
      const sessionFile = join(tempDir, "truncate-50k-to-10k.jsonl");

      // Generate ~50KB of turns (each line ~350 bytes -> ~150 turns)
      const turns: string[] = [];
      const turnCount = 150;
      for (let i = 0; i < turnCount; i++) {
        turns.push(
          JSON.stringify({
            type: i % 2 === 0 ? "user" : "assistant",
            timestamp: 1725500000000 + i * 1000,
            content: `Turn_${i}_keyword_original padded_string_${"x".repeat(250)}_end`,
          }) + "\n"
        );
      }

      writeFileSync(sessionFile, turns.join(""), "utf8");
      const initialSize = statSync(sessionFile).size;
      expect(initialSize).toBeGreaterThan(45000); // Verify ~50KB

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "zcode",
        alias: "truncation-test",
        sessionId: "sess-trunc-50k",
      };

      // 1. Initial sync of 50KB
      const resInitial = await syncSessionFile(db, input);
      expect(resInitial.indexedTurns).toBe(turnCount);
      expect(resInitial.lastScannedBytes).toBe(initialSize);

      const ftsCountBefore = (
        db.query("SELECT count(*) AS c FROM msg_fts").get() as { c: number }
      ).c;
      const pointerCountBefore = (
        db.query("SELECT count(*) AS c FROM msg_pointers WHERE file_id = ?").get(resInitial.fileId) as { c: number }
      ).c;
      expect(ftsCountBefore).toBe(turnCount);
      expect(pointerCountBefore).toBe(turnCount);

      // Verify term from turn 140 is searchable
      const match140Before = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Turn_140_keyword_original'")
        .all() as Array<{ rowid: number }>;
      expect(match140Before.length).toBe(1);

      // 2. Truncate file to ~10KB (keep first 30 turns)
      const retainedTurns = turns.slice(0, 30);
      writeFileSync(sessionFile, retainedTurns.join(""), "utf8");
      const truncatedSize = statSync(sessionFile).size;
      expect(truncatedSize).toBeLessThan(12000);
      expect(truncatedSize).toBeGreaterThan(8000);
      expect(truncatedSize).toBeLessThan(initialSize);

      // 3. Sync again (must trigger truncation purge)
      const resTruncated = await syncSessionFile(db, input);
      expect(resTruncated.skipped).toBe(false);
      expect(resTruncated.indexedTurns).toBe(30);
      expect(resTruncated.lastScannedBytes).toBe(truncatedSize);

      // 4. Stale FTS terms from purged turns MUST yield 0 hits
      const purgedHits140 = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Turn_140_keyword_original'")
        .all() as Array<{ rowid: number }>;
      expect(purgedHits140.length).toBe(0);

      const purgedHits50 = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Turn_50_keyword_original'")
        .all() as Array<{ rowid: number }>;
      expect(purgedHits50.length).toBe(0);

      // 5. Retained terms (turns 0..29) MUST be searchable
      const retainedHit0 = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Turn_0_keyword_original'")
        .all() as Array<{ rowid: number }>;
      expect(retainedHit0.length).toBe(1);

      const retainedHit29 = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Turn_29_keyword_original'")
        .all() as Array<{ rowid: number }>;
      expect(retainedHit29.length).toBe(1);

      // 6. Zero ghost pointers: all pointers must have byte_offset + byte_length <= truncatedSize
      const currentPointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(resInitial.fileId) as MsgPointer[];

      expect(currentPointers.length).toBe(30);

      for (const ptr of currentPointers) {
        expect(ptr.byte_offset + ptr.byte_length).toBeLessThanOrEqual(truncatedSize);
        // Direct seek check
        const slice = readDiskSlice(sessionFile, ptr.byte_offset, ptr.byte_length);
        const parsed = JSON.parse(slice);
        expect(parsed.timestamp).toBe(ptr.timestamp);
      }

      // 7. Symmetry: msg_fts count must equal msg_pointers count exactly
      const ftsCountAfter = (
        db.query("SELECT count(*) AS c FROM msg_fts").get() as { c: number }
      ).c;
      const pointerCountAfter = (
        db.query("SELECT count(*) AS c FROM msg_pointers WHERE file_id = ?").get(resInitial.fileId) as { c: number }
      ).c;
      expect(ftsCountAfter).toBe(30);
      expect(pointerCountAfter).toBe(30);

      // 8. Watermark record reflects exact truncated size
      const updatedWatermark = db
        .query("SELECT * FROM file_watermarks WHERE file_id = ?")
        .get(resInitial.fileId) as FileWatermark;
      expect(updatedWatermark.last_scanned_bytes).toBe(truncatedSize);
    });

    test("truncating File A does not affect File B in the same database", async () => {
      const fileA = join(tempDir, "file-a-trunc.jsonl");
      const fileB = join(tempDir, "file-b-safe.jsonl");

      // Populate File A (50 turns)
      const turnsA: string[] = [];
      for (let i = 0; i < 50; i++) {
        turnsA.push(
          JSON.stringify({
            type: "user",
            timestamp: 1725500000000 + i,
            content: `FileA_Turn_${i}_unique`,
          }) + "\n"
        );
      }
      writeFileSync(fileA, turnsA.join(""), "utf8");

      // Populate File B (50 turns)
      const turnsB: string[] = [];
      for (let i = 0; i < 50; i++) {
        turnsB.push(
          JSON.stringify({
            type: "assistant",
            timestamp: 1725500100000 + i,
            content: `FileB_Turn_${i}_isolated`,
          }) + "\n"
        );
      }
      writeFileSync(fileB, turnsB.join(""), "utf8");

      const inputA: SyncFileInput = { path: fileA, agent: "claude", alias: "A", sessionId: "sess-A" };
      const inputB: SyncFileInput = { path: fileB, agent: "pi", alias: "B", sessionId: "sess-B" };

      // Initial sync of both files
      await syncSessionFile(db, inputA);
      const resB = await syncSessionFile(db, inputB);

      expect(
        (db.query("SELECT count(*) AS c FROM msg_pointers WHERE file_id = ?").get(resB.fileId) as { c: number }).c
      ).toBe(50);

      // Truncate File A to only 5 turns
      writeFileSync(fileA, turnsA.slice(0, 5).join(""), "utf8");
      await syncSessionFile(db, inputA);

      // File B MUST be completely untouched
      const ptrsB = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(resB.fileId) as MsgPointer[];
      expect(ptrsB.length).toBe(50);

      // File B FTS search must still return hit
      const hitB = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'FileB_Turn_49_isolated'")
        .all() as Array<{ rowid: number }>;
      expect(hitB.length).toBe(1);
      expect(hitB[0].rowid).toBe(ptrsB[49].rowid);
    });

    test("truncation with completely new content indexes new content from turn_index 0", async () => {
      const sessionFile = join(tempDir, "rewrite-session.jsonl");

      // Initial version: 10 user turns
      const v1 = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ type: "user", timestamp: 1000 + i, content: `Old_Content_${i}` }) + "\n"
      ).join("");
      writeFileSync(sessionFile, v1, "utf8");

      const input: SyncFileInput = { path: sessionFile, agent: "opencode", alias: "rewrite" };
      await syncSessionFile(db, input);

      // Rewrite with 3 completely new assistant turns (smaller file)
      const v2 = Array.from({ length: 3 }, (_, i) =>
        JSON.stringify({ type: "assistant", timestamp: 2000 + i, content: `Brand_New_${i}` }) + "\n"
      ).join("");
      writeFileSync(sessionFile, v2, "utf8");

      const res2 = await syncSessionFile(db, input);
      expect(res2.indexedTurns).toBe(3);

      const pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res2.fileId) as MsgPointer[];

      expect(pointers.length).toBe(3);
      expect(pointers[0].turn_index).toBe(0);
      expect(pointers[1].turn_index).toBe(1);
      expect(pointers[2].turn_index).toBe(2);

      // Old content must not match
      const oldMatch = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Old_Content_0'")
        .all();
      expect(oldMatch.length).toBe(0);

      // New content matches
      const newMatch = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Brand_New_0'")
        .all();
      expect(newMatch.length).toBe(1);
    });

    /**
     * ADVERSARIAL BUG PROOF:
     * When a file is truncated to a size smaller than watermark.last_scanned_bytes,
     * lines 125-126 in src/search/sync.ts execute DELETE on msg_fts and msg_pointers.
     * However, if the truncated content currently has NO trailing newline (e.g. lastNewlineIndex === -1),
     * line 177 returns early WITHOUT executing the UPDATE on file_watermarks in SQLite.
     * Consequently, file_watermarks.last_scanned_bytes remains at the old pre-truncation size in SQLite.
     * If subsequent writes expand the file past the old pre-truncation size, line 124 (stat.size < startOffset)
     * evaluates to FALSE, causing startOffset to start at the old pre-truncation watermark rather than 0!
     * As a result, bytes [0, oldWatermark] are permanently skipped and never indexed.
     */
    test("truncation to partial line without newline followed by large append (> old watermark) tests watermark persistence", async () => {
      const sessionFile = join(tempDir, "trunc-partial-large.jsonl");

      // Initial: 10 turns, ~3KB
      const initialTurns = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ type: "user", timestamp: 1000 + i, content: `Initial_Turn_${i}_` + "y".repeat(250) }) + "\n"
      ).join("");
      writeFileSync(sessionFile, initialTurns, "utf8");
      const initialSize = statSync(sessionFile).size;

      const input: SyncFileInput = { path: sessionFile, agent: "claude", alias: "trunc-partial", sessionId: "sess-tpl" };
      const res1 = await syncSessionFile(db, input);
      expect(res1.indexedTurns).toBe(10);
      expect(res1.lastScannedBytes).toBe(initialSize);

      // Truncate to 50 bytes WITHOUT newline
      writeFileSync(sessionFile, '{"type":"user","content":"truncated_partial_no_newline', "utf8");
      const res2 = await syncSessionFile(db, input);
      expect(res2.indexedTurns).toBe(0);

      // Check the watermark in SQLite database:
      const wmAfterTrunc = db
        .query("SELECT * FROM file_watermarks WHERE file_id = ?")
        .get(res1.fileId) as FileWatermark;

      // Now append new turns that make the file LARGER than initialSize
      const largeNewTurns = Array.from({ length: 15 }, (_, i) =>
        JSON.stringify({ type: "assistant", timestamp: 5000 + i, content: `Replaced_Turn_${i}_` + "z".repeat(300) }) + "\n"
      ).join("");
      // Overwrite sessionFile completely with valid new turns
      writeFileSync(sessionFile, largeNewTurns, "utf8");
      const largeNewSize = statSync(sessionFile).size;
      expect(largeNewSize).toBeGreaterThan(initialSize);

      const res3 = await syncSessionFile(db, input);

      // All 15 new turns should be indexed
      const pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res1.fileId) as MsgPointer[];

      // Verify whether turn 0 was indexed or if bytes 0..initialSize were skipped!
      expect(pointers.length).toBe(15);
      expect(pointers[0].turn_index).toBe(0);
      expect(pointers[0].byte_offset).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CHALLENGE 3: Incomplete Trailing Line Handling
  // ───────────────────────────────────────────────────────────────────────────
  describe("Challenge 3: Incomplete Trailing Line Handling", () => {
    test("in-flight partial line is deferred; completion indexes line at exact byte offset with full searchability", async () => {
      const sessionFile = join(tempDir, "in-flight-stream.jsonl");

      // 1. Initial complete line
      const line1 = JSON.stringify({
        type: "user",
        timestamp: 1725500001000,
        content: "What is the capital of Japan?",
      }) + "\n";
      writeFileSync(sessionFile, line1, "utf8");
      const line1Bytes = Buffer.byteLength(line1, "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "claude",
        alias: "test-stream",
        sessionId: "sess-stream-001",
      };

      // Sync 1: index line 1
      const res1 = await syncSessionFile(db, input);
      expect(res1.indexedTurns).toBe(1);
      expect(res1.lastScannedBytes).toBe(line1Bytes);

      // 2. Append raw partial JSON WITHOUT newline
      const partialLine2 = '{"type":"assistant","timestamp":1725500002000,"content":"The capital of Japan is Tokyo';
      writeFileSync(sessionFile, partialLine2, { flag: "a", encoding: "utf8" });

      // Sync 2: partial line must be omitted
      const res2 = await syncSessionFile(db, input);
      expect(res2.indexedTurns).toBe(0);
      expect(res2.lastScannedBytes).toBe(line1Bytes); // Watermark must not advance past line 1

      // "Tokyo" must NOT be in FTS index yet
      const ftsPartial = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Tokyo'")
        .all();
      expect(ftsPartial.length).toBe(0);

      // Pointers count is still 1
      const ptrsAfterPartial = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ?")
        .all(res1.fileId) as MsgPointer[];
      expect(ptrsAfterPartial.length).toBe(1);

      // 3. Complete line 2 with remainder and newline, AND append line 3
      const remainderLine2 = ' and it is populous."}\n';
      const line3 = JSON.stringify({
        type: "user",
        timestamp: 1725500003000,
        content: "Tell me about Kyoto too.",
      }) + "\n";

      writeFileSync(sessionFile, remainderLine2 + line3, { flag: "a", encoding: "utf8" });
      const fullFileSize = statSync(sessionFile).size;

      // Sync 3: now line 2 and line 3 must both be indexed
      const res3 = await syncSessionFile(db, input);
      expect(res3.indexedTurns).toBe(2);
      expect(res3.lastScannedBytes).toBe(fullFileSize);

      // 4. Verify all 3 pointers
      const allPointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res1.fileId) as MsgPointer[];
      expect(allPointers.length).toBe(3);

      // Pointer 0: Line 1
      expect(allPointers[0].turn_index).toBe(0);
      expect(allPointers[0].byte_offset).toBe(0);
      expect(allPointers[0].byte_length).toBe(line1Bytes);

      // Pointer 1: Line 2 (MUST start exactly where Line 1 ended)
      const fullLine2 = partialLine2 + remainderLine2;
      const line2Bytes = Buffer.byteLength(fullLine2, "utf8");
      expect(allPointers[1].turn_index).toBe(1);
      expect(allPointers[1].byte_offset).toBe(line1Bytes);
      expect(allPointers[1].byte_length).toBe(line2Bytes);

      // Pointer 2: Line 3 (MUST start where Line 2 ended)
      const line3Bytes = Buffer.byteLength(line3, "utf8");
      expect(allPointers[2].turn_index).toBe(2);
      expect(allPointers[2].byte_offset).toBe(line1Bytes + line2Bytes);
      expect(allPointers[2].byte_length).toBe(line3Bytes);

      // 5. Seek disk at Pointer 1 and Pointer 2
      const readLine2 = readDiskSlice(sessionFile, allPointers[1].byte_offset, allPointers[1].byte_length);
      expect(readLine2).toBe(fullLine2);
      const parsedLine2 = JSON.parse(readLine2);
      expect(parsedLine2.content).toContain("Tokyo");

      const readLine3 = readDiskSlice(sessionFile, allPointers[2].byte_offset, allPointers[2].byte_length);
      expect(readLine3).toBe(line3);

      // 6. Search for Tokyo and Kyoto
      const hitTokyo = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Tokyo'")
        .all() as Array<{ rowid: number }>;
      expect(hitTokyo.length).toBe(1);
      expect(hitTokyo[0].rowid).toBe(allPointers[1].rowid);

      const hitKyoto = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'Kyoto'")
        .all() as Array<{ rowid: number }>;
      expect(hitKyoto.length).toBe(1);
      expect(hitKyoto[0].rowid).toBe(allPointers[2].rowid);
    });

    test("multi-stage fragmented append of a single turn across 4 partial syncs", async () => {
      const sessionFile = join(tempDir, "fragmented-turn.jsonl");

      const chunks = [
        '{"type":"assistant"',
        ',"timestamp":1725500099000',
        ',"content":"Piece by piece assembly',
        ' complete text output."}\n',
      ];

      writeFileSync(sessionFile, "", "utf8");

      const input: SyncFileInput = { path: sessionFile, agent: "pi", alias: "frag" };

      // Append chunks 0, 1, 2 (all lack newline)
      for (let i = 0; i < 3; i++) {
        writeFileSync(sessionFile, chunks[i], { flag: "a", encoding: "utf8" });
        const res = await syncSessionFile(db, input);
        expect(res.indexedTurns).toBe(0);
        expect(res.lastScannedBytes).toBe(0);
      }

      // Append final chunk with newline
      writeFileSync(sessionFile, chunks[3], { flag: "a", encoding: "utf8" });
      const finalRes = await syncSessionFile(db, input);
      expect(finalRes.indexedTurns).toBe(1);
      expect(finalRes.lastScannedBytes).toBe(statSync(sessionFile).size);

      const ptrs = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ?")
        .all(finalRes.fileId) as MsgPointer[];
      expect(ptrs.length).toBe(1);
      expect(ptrs[0].byte_offset).toBe(0);
      expect(ptrs[0].byte_length).toBe(statSync(sessionFile).size);

      // Searchable
      const hit = db
        .query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'assembly'")
        .all();
      expect(hit.length).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CHALLENGE 4: Zero-Byte Files, Whitespace, & Corrupt JSON Interleaving
  // ───────────────────────────────────────────────────────────────────────────
  describe("Challenge 4: Zero-Byte Files, Whitespace, & Corrupt JSON Interleaving", () => {
    test("zero-byte file lifecycle: empty -> append -> truncate to empty -> append again", async () => {
      const sessionFile = join(tempDir, "zero-byte-cycle.jsonl");
      writeFileSync(sessionFile, "", "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "hermes",
        alias: "tester",
        sessionId: "sess-zero-cycle",
      };

      // 1. Initial sync of 0 bytes
      const res1 = await syncSessionFile(db, input);
      expect(res1.indexedTurns).toBe(0);
      expect(res1.lastScannedBytes).toBe(0);

      // 2. Append 2 turns
      const turn1 = JSON.stringify({ type: "user", timestamp: 1000, content: "First turn" }) + "\n";
      const turn2 = JSON.stringify({ type: "assistant", timestamp: 1001, content: "Second turn" }) + "\n";
      writeFileSync(sessionFile, turn1 + turn2, "utf8");

      const res2 = await syncSessionFile(db, input);
      expect(res2.indexedTurns).toBe(2);
      expect(res2.lastScannedBytes).toBe(Buffer.byteLength(turn1 + turn2, "utf8"));

      expect(
        (db.query("SELECT count(*) AS c FROM msg_pointers WHERE file_id = ?").get(res1.fileId) as { c: number }).c
      ).toBe(2);

      // 3. Truncate back to 0 bytes
      writeFileSync(sessionFile, "", "utf8");

      const res3 = await syncSessionFile(db, input);
      expect(res3.indexedTurns).toBe(0);
      expect(res3.lastScannedBytes).toBe(0);

      // Pointers and FTS entries must be completely purged
      expect(
        (db.query("SELECT count(*) AS c FROM msg_pointers WHERE file_id = ?").get(res1.fileId) as { c: number }).c
      ).toBe(0);
      expect(
        (db.query("SELECT count(*) AS c FROM msg_fts").get() as { c: number }).c
      ).toBe(0);

      // 4. Append 1 new turn into now-empty file
      const turn3 = JSON.stringify({ type: "user", timestamp: 2000, content: "Third turn fresh start" }) + "\n";
      writeFileSync(sessionFile, turn3, "utf8");

      const res4 = await syncSessionFile(db, input);
      expect(res4.indexedTurns).toBe(1);
      expect(res4.lastScannedBytes).toBe(Buffer.byteLength(turn3, "utf8"));

      const ptrsFinal = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ?")
        .all(res1.fileId) as MsgPointer[];
      expect(ptrsFinal.length).toBe(1);
      expect(ptrsFinal[0].turn_index).toBe(0);
      expect(ptrsFinal[0].byte_offset).toBe(0);
      expect(ptrsFinal[0].byte_length).toBe(Buffer.byteLength(turn3, "utf8"));
    });

    test("files with only whitespace and empty newlines advance watermark without inserting pointers", async () => {
      const sessionFile = join(tempDir, "only-whitespace.jsonl");
      const whitespaceContent = "   \n\n\t\t\n  \r\n   \n\n";
      writeFileSync(sessionFile, whitespaceContent, "utf8");
      const wsBytes = Buffer.byteLength(whitespaceContent, "utf8");

      const input: SyncFileInput = { path: sessionFile, agent: "claude", alias: "ws" };

      // Sync whitespace file
      const res1 = await syncSessionFile(db, input);
      expect(res1.indexedTurns).toBe(0);
      expect(res1.lastScannedBytes).toBe(wsBytes);

      expect(
        (db.query("SELECT count(*) AS c FROM msg_pointers WHERE file_id = ?").get(res1.fileId) as { c: number }).c
      ).toBe(0);

      // Append valid turn after whitespace
      const validTurn = JSON.stringify({
        type: "user",
        timestamp: 1725500000000,
        content: "Valid turn after whitespace preamble",
      }) + "\n";
      writeFileSync(sessionFile, validTurn, { flag: "a", encoding: "utf8" });
      const validBytes = Buffer.byteLength(validTurn, "utf8");

      const res2 = await syncSessionFile(db, input);
      expect(res2.indexedTurns).toBe(1);
      expect(res2.lastScannedBytes).toBe(wsBytes + validBytes);

      const ptrs = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ?")
        .all(res1.fileId) as MsgPointer[];
      expect(ptrs.length).toBe(1);
      expect(ptrs[0].turn_index).toBe(0);
      expect(ptrs[0].byte_offset).toBe(wsBytes); // Must start exactly after whitespace
      expect(ptrs[0].byte_length).toBe(validBytes);

      // Direct seek verification
      const diskContent = readDiskSlice(sessionFile, ptrs[0].byte_offset, ptrs[0].byte_length);
      expect(diskContent).toBe(validTurn);
    });

    test("corrupt non-JSON lines interleaved between valid JSON turns are skipped gracefully with exact coordinate tracking", async () => {
      const sessionFile = join(tempDir, "corrupt-interleaved.jsonl");

      const line0 = JSON.stringify({
        type: "user",
        timestamp: 1725500010000,
        content: "Valid first prompt before junk",
      }) + "\n";

      const corruptLine1 = "MALFORMED_GARBAGE {{{ unclosed json brackets with null bytes \x00\x01\x02\n";

      const line2 = JSON.stringify({
        type: "assistant",
        timestamp: 1725500020000,
        content: "Valid assistant response between junk",
      }) + "\n";

      const corruptLine3 = '{"incomplete": "missing closing brace\n';

      const corruptLine4 = "   \t\t   \n"; // blank whitespace line

      const line5 = JSON.stringify({
        type: "tool",
        timestamp: 1725500030000,
        tool: "bash",
        arguments: { command: "echo surviving_corruption" },
      }) + "\n";

      const allContent = line0 + corruptLine1 + line2 + corruptLine3 + corruptLine4 + line5;
      writeFileSync(sessionFile, allContent, "utf8");
      const totalBytes = Buffer.byteLength(allContent, "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "opencode",
        alias: "resilience",
        sessionId: "sess-resilience-01",
      };

      // Must not throw exception
      const res = await syncSessionFile(db, input);

      // Only the 3 valid turns (line0, line2, line5) should be indexed
      expect(res.indexedTurns).toBe(3);
      expect(res.lastScannedBytes).toBe(totalBytes);

      const pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res.fileId) as MsgPointer[];

      expect(pointers.length).toBe(3);

      // Pointer 0 -> line0
      expect(pointers[0].turn_index).toBe(0);
      expect(pointers[0].byte_offset).toBe(0);
      expect(pointers[0].byte_length).toBe(Buffer.byteLength(line0, "utf8"));
      expect(readDiskSlice(sessionFile, pointers[0].byte_offset, pointers[0].byte_length)).toBe(line0);

      // Pointer 1 -> line2
      const offsetLine2 = Buffer.byteLength(line0, "utf8") + Buffer.byteLength(corruptLine1, "utf8");
      expect(pointers[1].turn_index).toBe(1);
      expect(pointers[1].byte_offset).toBe(offsetLine2);
      expect(pointers[1].byte_length).toBe(Buffer.byteLength(line2, "utf8"));
      expect(readDiskSlice(sessionFile, pointers[1].byte_offset, pointers[1].byte_length)).toBe(line2);

      // Pointer 2 -> line5
      const offsetLine5 =
        offsetLine2 +
        Buffer.byteLength(line2, "utf8") +
        Buffer.byteLength(corruptLine3, "utf8") +
        Buffer.byteLength(corruptLine4, "utf8");
      expect(pointers[2].turn_index).toBe(2);
      expect(pointers[2].byte_offset).toBe(offsetLine5);
      expect(pointers[2].byte_length).toBe(Buffer.byteLength(line5, "utf8"));
      expect(readDiskSlice(sessionFile, pointers[2].byte_offset, pointers[2].byte_length)).toBe(line5);

      // Verify all 3 valid turns are searchable in FTS5
      const match1 = db.query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'prompt'").all();
      expect(match1.length).toBe(1);

      const match2 = db.query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'response'").all();
      expect(match2.length).toBe(1);

      const match3 = db.query("SELECT rowid FROM msg_fts WHERE msg_fts MATCH 'surviving_corruption'").all();
      expect(match3.length).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CHALLENGE 5: UTF-8 Multi-Byte, Emoji, and Large Payload Stress
  // ───────────────────────────────────────────────────────────────────────────
  describe("Challenge 5: UTF-8 Multi-Byte, Emoji, and Large Payload Stress", () => {
    test("complex multi-byte UTF-8, astral plane emojis, and special characters calculate exact byte coordinates", async () => {
      const sessionFile = join(tempDir, "complex-utf8.jsonl");

      // Astral plane emojis (4 bytes each), multi-codepoint sequences, and CJK text
      const line1 = JSON.stringify({
        type: "user",
        timestamp: 1725500001000,
        content: "Astral emojis 𠜎 𠜱 𠝹 and standard emojis 🚀🔥💡🎉 for indexing test",
      }) + "\n";

      const line2 = JSON.stringify({
        type: "assistant",
        timestamp: 1725500002000,
        content: "Complex multi-language: こんにちは 세계 안녕 สวัสดี Bonjour Grüße café crème",
      }) + "\n";

      const line3 = JSON.stringify({
        type: "tool",
        timestamp: 1725500003000,
        tool: "bash",
        arguments: { command: "grep -rn '𠜎 🚀 こんにちは' /tmp/test" },
      }) + "\n";

      writeFileSync(sessionFile, line1 + line2 + line3, "utf8");

      const input: SyncFileInput = { path: sessionFile, agent: "claude", alias: "utf8-stress" };
      const res = await syncSessionFile(db, input);
      expect(res.indexedTurns).toBe(3);

      const pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res.fileId) as MsgPointer[];

      expect(pointers.length).toBe(3);

      // Verify each pointer byte_offset and byte_length matches Buffer.byteLength exactly
      const b1 = Buffer.byteLength(line1, "utf8");
      const b2 = Buffer.byteLength(line2, "utf8");
      const b3 = Buffer.byteLength(line3, "utf8");

      expect(pointers[0].byte_offset).toBe(0);
      expect(pointers[0].byte_length).toBe(b1);

      expect(pointers[1].byte_offset).toBe(b1);
      expect(pointers[1].byte_length).toBe(b2);

      expect(pointers[2].byte_offset).toBe(b1 + b2);
      expect(pointers[2].byte_length).toBe(b3);

      // Verify direct disk seek produces byte-for-byte exact matches
      expect(readDiskSlice(sessionFile, pointers[0].byte_offset, pointers[0].byte_length)).toBe(line1);
      expect(readDiskSlice(sessionFile, pointers[1].byte_offset, pointers[1].byte_length)).toBe(line2);
      expect(readDiskSlice(sessionFile, pointers[2].byte_offset, pointers[2].byte_length)).toBe(line3);
    });

    test("handles massive toolResult bulk stdout lines (>100KB) gracefully while advancing watermark without bloat", async () => {
      const sessionFile = join(tempDir, "massive-bulk-skip.jsonl");

      const line1 = JSON.stringify({
        type: "user",
        timestamp: 1725500001000,
        content: "Run large command",
      }) + "\n";

      // Bulk toolResult dump with 120KB of stdout
      const bulkStdout = "STDOUT_LOG_LINE_" + "A".repeat(120000) + "\n";
      const line2 = JSON.stringify({
        type: "tool_result",
        timestamp: 1725500002000,
        content: bulkStdout,
      }) + "\n";

      const line3 = JSON.stringify({
        type: "assistant",
        timestamp: 1725500003000,
        content: "I have processed the large output.",
      }) + "\n";

      writeFileSync(sessionFile, line1 + line2 + line3, "utf8");
      const totalSize = statSync(sessionFile).size;
      expect(totalSize).toBeGreaterThan(120000);

      const input: SyncFileInput = { path: sessionFile, agent: "pi", alias: "bulk" };
      const res = await syncSessionFile(db, input);

      // Extractor skips bulk toolResult lines without conversational text
      // So only line 1 and line 3 should create pointers
      expect(res.indexedTurns).toBe(2);
      expect(res.lastScannedBytes).toBe(totalSize);

      const pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res.fileId) as MsgPointer[];

      expect(pointers.length).toBe(2);
      expect(pointers[0].turn_index).toBe(0);
      expect(pointers[0].byte_offset).toBe(0);

      const expectedOffsetLine3 = Buffer.byteLength(line1, "utf8") + Buffer.byteLength(line2, "utf8");
      expect(pointers[1].turn_index).toBe(1);
      expect(pointers[1].byte_offset).toBe(expectedOffsetLine3);

      expect(readDiskSlice(sessionFile, pointers[1].byte_offset, pointers[1].byte_length)).toBe(line3);
    });
  });
});
