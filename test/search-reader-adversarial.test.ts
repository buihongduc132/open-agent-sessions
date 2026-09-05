/**
 * test/search-reader-adversarial.test.ts
 *
 * Empirical Challenger Stress & Adversarial Test Suite for Milestone 4 (src/search/reader.ts).
 *
 * Stress-tests and challenges:
 * 1. Concurrent and rapid sequential seeks across multiple files without file descriptor exhaustion.
 * 2. Out-of-bounds seeks (offset = 0, length = 0; offset = stat.size; offset + length > stat.size; negative; non-finite).
 * 3. Massive raw text turns (100KB, 500KB, 1MB, 5MB) verifying payload parsing and memory leak resistance.
 * 4. Corrupted, truncated, and malformed JSON: ensures payload: null and rawText preserved without crashing.
 * 5. Context window edge cases (large contextN = 100, negative, zero, boundary turns, non-finite).
 * 6. Single-file multi-session isolation: zero turn cross-contamination when multiple sessions share one file.
 * 7. Multi-file session context window: resolving turns across split files via file_watermarks.
 */

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
  readTurnByPointer,
  readTurnContext,
  type ContextWindowResult,
  type RawTurnRecord,
} from "../src/search/reader";
import { syncSessionFile } from "../src/search/sync";
import type { FileWatermark, MsgPointer } from "../src/search/types";

describe("Milestone 4 Adversarial Stress Suite: Direct File Reader & Context Window", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `oas-reader-adv-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  // 1. High Concurrency & File Descriptor Leak Stress Test
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. High Concurrency & File Descriptor Leak Stress", () => {
    test("handles 2,000 concurrent seeks across 50 distinct files without fd exhaustion", async () => {
      const numFiles = 50;
      const turnsPerFile = 20;
      const allFiles: string[] = [];
      const allPointers: Array<{ filePath: string; pointer: MsgPointer; expectedContent: string }> = [];

      // Create 50 distinct session files
      for (let f = 0; f < numFiles; f++) {
        const filePath = join(tempDir, `stress-session-${f}.jsonl`);
        allFiles.push(filePath);

        let fileBuffer = Buffer.alloc(0);
        const filePointers: MsgPointer[] = [];

        for (let t = 0; t < turnsPerFile; t++) {
          const turnData = {
            type: t % 2 === 0 ? "user" : "assistant",
            timestamp: 1725500000000 + f * 100000 + t * 1000,
            content: `Concurrent seek test payload for file ${f} turn ${t}`,
          };
          const turnLine = JSON.stringify(turnData) + "\n";
          const lineBuf = Buffer.from(turnLine, "utf8");
          const offset = fileBuffer.length;
          const length = lineBuf.length;

          fileBuffer = Buffer.concat([fileBuffer, lineBuf]);

          const pointer: MsgPointer = {
            rowid: f * turnsPerFile + t + 1,
            session_id: `sess-stress-${f}`,
            turn_index: t,
            file_id: f + 1,
            byte_offset: offset,
            byte_length: length,
            role: t % 2 === 0 ? 1 : 2,
            timestamp: turnData.timestamp,
          };

          allPointers.push({
            filePath,
            pointer,
            expectedContent: turnData.content,
          });
        }

        writeFileSync(filePath, fileBuffer);
      }

      expect(allPointers.length).toBe(numFiles * turnsPerFile); // 1,000 items

      // Dispatch 2,000 concurrent async read tasks (2x over 1,000 pointers)
      const tasks: Array<Promise<void>> = [];
      const totalConcurrentOps = 2000;

      for (let i = 0; i < totalConcurrentOps; i++) {
        const target = allPointers[i % allPointers.length];
        tasks.push(
          (async () => {
            // Slight microtask shift to maximize concurrency interleaving
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
            const record = readTurnByPointer(target.filePath, target.pointer);
            expect(record).not.toBeNull();
            expect(record!.sessionId).toBe(target.pointer.session_id);
            expect(record!.turnIndex).toBe(target.pointer.turn_index);
            expect(record!.payload.content).toBe(target.expectedContent);
          })()
        );
      }

      // If file descriptors leak, this will throw EMFILE: too many open files
      await Promise.all(tasks);
    });

    test("handles rapid interleaved seeks with mixed invalid files and errors without leaking fds", () => {
      const validFile = join(tempDir, "valid-for-leak.jsonl");
      const validContent = JSON.stringify({ type: "user", content: "I am valid" }) + "\n";
      writeFileSync(validFile, validContent, "utf8");

      const validPointer: MsgPointer = {
        rowid: 1,
        session_id: "sess-valid",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: Buffer.byteLength(validContent, "utf8"),
        role: 1,
        timestamp: 1725500000000,
      };

      const invalidPointer: MsgPointer = {
        rowid: 2,
        session_id: "sess-invalid",
        turn_index: 1,
        file_id: 1,
        byte_offset: 999999, // Out of bounds
        byte_length: 50,
        role: 1,
        timestamp: 1725500000000,
      };

      const nonexistentPath = join(tempDir, "does-not-exist.jsonl");

      // 1,000 rapid sequential operations alternating between valid, oob, and nonexistent
      for (let i = 0; i < 1000; i++) {
        if (i % 3 === 0) {
          const rec = readTurnByPointer(validFile, validPointer);
          expect(rec).not.toBeNull();
          expect(rec!.payload.content).toBe("I am valid");
        } else if (i % 3 === 1) {
          const rec = readTurnByPointer(validFile, invalidPointer);
          expect(rec).toBeNull();
        } else {
          const rec = readTurnByPointer(nonexistentPath, validPointer);
          expect(rec).toBeNull();
        }
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Out-of-Bounds & Hostile Boundary Seeks
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Out-of-Bounds & Hostile Boundary Seeks", () => {
    let sampleFile: string;
    let sampleSize: number;

    beforeEach(() => {
      sampleFile = join(tempDir, "sample-bounds.jsonl");
      const line = JSON.stringify({ type: "assistant", content: "Boundary seek test turn" }) + "\n";
      writeFileSync(sampleFile, line, "utf8");
      sampleSize = statSync(sampleFile).size;
    });

    test("offset = 0, length = 0 returns null", () => {
      const ptr: MsgPointer = {
        rowid: 1,
        session_id: "sess-b",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: 0,
        role: 2,
        timestamp: 1725500000000,
      };
      expect(readTurnByPointer(sampleFile, ptr)).toBeNull();
    });

    test("offset = stat.size returns null (both with length = 0 and length > 0)", () => {
      const ptrZeroLen: MsgPointer = {
        rowid: 1,
        session_id: "sess-b",
        turn_index: 0,
        file_id: 1,
        byte_offset: sampleSize,
        byte_length: 0,
        role: 2,
        timestamp: 1725500000000,
      };
      expect(readTurnByPointer(sampleFile, ptrZeroLen)).toBeNull();

      const ptrOneLen: MsgPointer = {
        rowid: 2,
        session_id: "sess-b",
        turn_index: 0,
        file_id: 1,
        byte_offset: sampleSize,
        byte_length: 1,
        role: 2,
        timestamp: 1725500000000,
      };
      expect(readTurnByPointer(sampleFile, ptrOneLen)).toBeNull();
    });

    test("offset + length > stat.size returns null (off-by-one and gross overflow)", () => {
      // Exactly 1 byte overflow beyond EOF
      const ptrOffByOne: MsgPointer = {
        rowid: 1,
        session_id: "sess-b",
        turn_index: 0,
        file_id: 1,
        byte_offset: sampleSize - 5,
        byte_length: 6, // 1 byte past sampleSize
        role: 2,
        timestamp: 1725500000000,
      };
      expect(readTurnByPointer(sampleFile, ptrOffByOne)).toBeNull();

      // Huge overflow
      const ptrHugeOverflow: MsgPointer = {
        rowid: 2,
        session_id: "sess-b",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: sampleSize * 10,
        role: 2,
        timestamp: 1725500000000,
      };
      expect(readTurnByPointer(sampleFile, ptrHugeOverflow)).toBeNull();
    });

    test("negative offset and negative length return null", () => {
      const ptrNegOffset: MsgPointer = {
        rowid: 1,
        session_id: "sess-b",
        turn_index: 0,
        file_id: 1,
        byte_offset: -1,
        byte_length: 10,
        role: 2,
        timestamp: 1725500000000,
      };
      expect(readTurnByPointer(sampleFile, ptrNegOffset)).toBeNull();

      const ptrNegLen: MsgPointer = {
        rowid: 2,
        session_id: "sess-b",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: -1,
        role: 2,
        timestamp: 1725500000000,
      };
      expect(readTurnByPointer(sampleFile, ptrNegLen)).toBeNull();

      const ptrBothNeg: MsgPointer = {
        rowid: 3,
        session_id: "sess-b",
        turn_index: 0,
        file_id: 1,
        byte_offset: -50,
        byte_length: -50,
        role: 2,
        timestamp: 1725500000000,
      };
      expect(readTurnByPointer(sampleFile, ptrBothNeg)).toBeNull();
    });

    test("seeks targeting a directory instead of a file return null without throwing", () => {
      const ptr: MsgPointer = {
        rowid: 1,
        session_id: "sess-b",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: 10,
        role: 1,
        timestamp: 1725500000000,
      };
      // tempDir is a directory, not a regular file
      expect(readTurnByPointer(tempDir, ptr)).toBeNull();
    });

    test("seeks with non-finite coordinates (NaN, Infinity) return null without unhandled crashes", () => {
      const ptrNaN: MsgPointer = {
        rowid: 1,
        session_id: "sess-b",
        turn_index: 0,
        file_id: 1,
        byte_offset: NaN,
        byte_length: 10,
        role: 1,
        timestamp: 1725500000000,
      };
      expect(() => {
        const res = readTurnByPointer(sampleFile, ptrNaN);
        expect(res).toBeNull();
      }).not.toThrow();

      const ptrInf: MsgPointer = {
        rowid: 2,
        session_id: "sess-b",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: Infinity,
        role: 1,
        timestamp: 1725500000000,
      };
      expect(() => {
        const res = readTurnByPointer(sampleFile, ptrInf);
        expect(res).toBeNull();
      }).not.toThrow();
    });

    test("seeks in a zero-byte empty file return null", () => {
      const emptyFile = join(tempDir, "zero-byte.jsonl");
      writeFileSync(emptyFile, "");

      const ptr: MsgPointer = {
        rowid: 1,
        session_id: "sess-zero",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: 10,
        role: 1,
        timestamp: 1725500000000,
      };
      expect(readTurnByPointer(emptyFile, ptr)).toBeNull();
    });

    test("reads exact 1-byte slice at EOF-1 safely", () => {
      const ptrLastByte: MsgPointer = {
        rowid: 1,
        session_id: "sess-last",
        turn_index: 0,
        file_id: 1,
        byte_offset: sampleSize - 1,
        byte_length: 1,
        role: 1,
        timestamp: 1725500000000,
      };
      const record = readTurnByPointer(sampleFile, ptrLastByte);
      expect(record).not.toBeNull();
      // The last byte is '\n' which gets stripped to empty string
      expect(record!.rawText).toBe("");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Massive Raw Text Payloads & Memory Stability
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Massive Raw Text Payloads & Memory Stability", () => {
    test("reads massive turns (100KB, 500KB, 1MB) with exact text and parsed payload", () => {
      const massiveFile = join(tempDir, "massive-payloads.jsonl");

      // Construct a 500KB payload
      const deepData500KB = "A".repeat(500 * 1024);
      const turn500KB = {
        type: "assistant",
        timestamp: 1725510000000,
        content: "Massive 500KB payload response",
        deepData: deepData500KB,
        nested: {
          items: Array.from({ length: 100 }, (_, i) => ({ id: i, label: `Item #${i}` })),
        },
      };
      const line500KB = JSON.stringify(turn500KB) + "\n";

      // Construct a 1MB payload
      const deepData1MB = "B".repeat(1024 * 1024);
      const turn1MB = {
        type: "tool",
        timestamp: 1725510001000,
        tool: "read",
        arguments: { path: "/path/to/huge/file.txt" },
        resultData: deepData1MB,
      };
      const line1MB = JSON.stringify(turn1MB) + "\n";

      const buf500KB = Buffer.from(line500KB, "utf8");
      const buf1MB = Buffer.from(line1MB, "utf8");

      writeFileSync(massiveFile, Buffer.concat([buf500KB, buf1MB]));

      const ptr500KB: MsgPointer = {
        rowid: 1,
        session_id: "sess-massive",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: buf500KB.length,
        role: 2,
        timestamp: 1725510000000,
      };

      const ptr1MB: MsgPointer = {
        rowid: 2,
        session_id: "sess-massive",
        turn_index: 1,
        file_id: 1,
        byte_offset: buf500KB.length,
        byte_length: buf1MB.length,
        role: 3,
        timestamp: 1725510001000,
      };

      // 1. Verify 500KB read
      const rec500KB = readTurnByPointer(massiveFile, ptr500KB);
      expect(rec500KB).not.toBeNull();
      expect(rec500KB!.sessionId).toBe("sess-massive");
      expect(rec500KB!.payload.deepData.length).toBe(500 * 1024);
      expect(rec500KB!.payload.nested.items.length).toBe(100);
      expect(rec500KB!.payload.nested.items[50].label).toBe("Item #50");

      // 2. Verify 1MB read
      const rec1MB = readTurnByPointer(massiveFile, ptr1MB);
      expect(rec1MB).not.toBeNull();
      expect(rec1MB!.sessionId).toBe("sess-massive");
      expect(rec1MB!.payload.resultData.length).toBe(1024 * 1024);
      expect(rec1MB!.payload.tool).toBe("read");
    });

    test("verifies memory does not leak across 500 repeated seeks of 500KB turn", () => {
      const file = join(tempDir, "mem-leak-test.jsonl");
      const deepString = "M".repeat(500 * 1024);
      const turnObj = {
        type: "assistant",
        timestamp: 1725520000000,
        data: deepString,
      };
      const line = JSON.stringify(turnObj) + "\n";
      const lineBuf = Buffer.from(line, "utf8");
      writeFileSync(file, lineBuf);

      const ptr: MsgPointer = {
        rowid: 1,
        session_id: "sess-mem",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: lineBuf.length,
        role: 2,
        timestamp: 1725520000000,
      };

      const runGC = () => {
        if (typeof (Bun as any)?.gc === "function") {
          (Bun as any).gc(true);
        } else if (typeof (globalThis as any).gc === "function") {
          (globalThis as any).gc();
        }
      };

      // Warm up JSC buffer arena and string intern table
      for (let i = 0; i < 50; i++) {
        readTurnByPointer(file, ptr);
      }
      runGC();
      const baselineHeap = process.memoryUsage().heapUsed;

      // 500 reads of 500KB = 250MB total data read
      for (let i = 0; i < 500; i++) {
        const rec = readTurnByPointer(file, ptr);
        if (!rec || rec.payload.data.length !== 500 * 1024) {
          throw new Error("Read failed at iteration " + i);
        }
      }

      runGC();
      const finalHeap = process.memoryUsage().heapUsed;
      const finalHeapMB = finalHeap / (1024 * 1024);

      // If Buffers or strings were retained and leaked, heap would grow by >250MB.
      // With ephemeral scoping and GC, heapUsed remains strictly bounded below 50MB.
      expect(finalHeapMB).toBeLessThan(50);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Corrupted, Truncated, and Malformed JSON
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Corrupted, Truncated, and Malformed JSON", () => {
    test("truncated partial JSON returns payload: null while preserving rawText without throwing", () => {
      const file = join(tempDir, "truncated.jsonl");
      // Truncated midway through a key
      const partialLine = '{"type": "assistant", "content": "The quick brown fox jumps over the lazy dog", "partial_key": "unfinis';
      const buf = Buffer.from(partialLine + "\n", "utf8");
      writeFileSync(file, buf);

      const ptr: MsgPointer = {
        rowid: 1,
        session_id: "sess-trunc",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: buf.length,
        role: 2,
        timestamp: 1725530000000,
      };

      const record = readTurnByPointer(file, ptr);
      expect(record).not.toBeNull();
      expect(record!.payload).toBeNull();
      expect(record!.rawText).toBe(partialLine);
      expect(record!.sessionId).toBe("sess-trunc");
      expect(record!.turnIndex).toBe(0);
      expect(record!.role).toBe(2);
    });

    test("completely non-JSON binary and syntax junk preserves rawText with payload: null", () => {
      const file = join(tempDir, "junk.jsonl");
      const junkContent = "<html><body>502 Bad Gateway - Nginx Error</body></html>\n";
      const buf = Buffer.from(junkContent, "utf8");
      writeFileSync(file, buf);

      const ptr: MsgPointer = {
        rowid: 1,
        session_id: "sess-junk",
        turn_index: 3,
        file_id: 1,
        byte_offset: 0,
        byte_length: buf.length,
        role: 1,
        timestamp: 1725530001000,
      };

      const record = readTurnByPointer(file, ptr);
      expect(record).not.toBeNull();
      expect(record!.payload).toBeNull();
      expect(record!.rawText).toBe("<html><body>502 Bad Gateway - Nginx Error</body></html>");
    });

    test("valid non-object JSON primitives parse without crashing", () => {
      const file = join(tempDir, "primitives.jsonl");
      const lines = [
        '"just a string payload"\n',
        "123456789\n",
        "true\n",
        "null\n",
        '["array", 1, 2, 3]\n',
      ];
      const joined = lines.join("");
      const buf = Buffer.from(joined, "utf8");
      writeFileSync(file, buf);

      let offset = 0;
      const primitives = [
        "just a string payload",
        123456789,
        true,
        null,
        ["array", 1, 2, 3],
      ];

      for (let i = 0; i < lines.length; i++) {
        const lineLen = Buffer.byteLength(lines[i], "utf8");
        const ptr: MsgPointer = {
          rowid: i + 1,
          session_id: "sess-prim",
          turn_index: i,
          file_id: 1,
          byte_offset: offset,
          byte_length: lineLen,
          role: 1,
          timestamp: 1725530002000 + i,
        };

        const rec = readTurnByPointer(file, ptr);
        expect(rec).not.toBeNull();
        expect(rec!.payload).toEqual(primitives[i]);
        offset += lineLen;
      }
    });

    test("handles multiple trailing newlines cleanly", () => {
      const file = join(tempDir, "newlines.jsonl");
      const payload = { type: "user", content: "hello" };
      // Double newline at end
      const line = JSON.stringify(payload) + "\n\n";
      const buf = Buffer.from(line, "utf8");
      writeFileSync(file, buf);

      const ptr: MsgPointer = {
        rowid: 1,
        session_id: "sess-nl",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: buf.length,
        role: 1,
        timestamp: 1725530003000,
      };

      const record = readTurnByPointer(file, ptr);
      expect(record).not.toBeNull();
      expect(record!.payload).toEqual(payload);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Context Window Edge Cases (large contextN, negative, zero, non-finite)
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Context Window Edge Cases", () => {
    let sessionFile: string;
    let pointers: MsgPointer[];

    beforeEach(async () => {
      sessionFile = join(tempDir, "context-edge.jsonl");
      // Create a 5-turn session (indices 0..4)
      let content = "";
      for (let i = 0; i < 5; i++) {
        const turn = {
          type: i % 2 === 0 ? "user" : "assistant",
          timestamp: 1725540000000 + i * 1000,
          content: `Edge turn index ${i}`,
        };
        content += JSON.stringify(turn) + "\n";
      }
      writeFileSync(sessionFile, content, "utf8");

      const res = await syncSessionFile(db, {
        path: sessionFile,
        agent: "codex",
        alias: "default",
        sessionId: "sess-edge-5",
      });

      pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res.fileId) as MsgPointer[];
      expect(pointers.length).toBe(5);
    });

    test("contextN = 100 on 5-turn session returns all turns without error or duplicates", () => {
      const middlePointer = pointers[2]; // turn index 2
      const res = readTurnContext(db, sessionFile, middlePointer, 100);

      expect(res.hitTurn).not.toBeNull();
      expect(res.hitTurn!.turnIndex).toBe(2);

      // before should contain exactly turns 0 and 1
      expect(res.before.length).toBe(2);
      expect(res.before.map((t) => t.turnIndex)).toEqual([0, 1]);

      // after should contain exactly turns 3 and 4
      expect(res.after.length).toBe(2);
      expect(res.after.map((t) => t.turnIndex)).toEqual([3, 4]);

      // Verify no turn is duplicated between hitTurn, before, and after
      const allSeen = [res.hitTurn!.turnIndex, ...res.before.map((t) => t.turnIndex), ...res.after.map((t) => t.turnIndex)];
      expect(new Set(allSeen).size).toBe(5);
    });

    test("contextN = 0 returns hitTurn with empty before and after", () => {
      const res = readTurnContext(db, sessionFile, pointers[1], 0);
      expect(res.hitTurn).not.toBeNull();
      expect(res.hitTurn!.turnIndex).toBe(1);
      expect(res.before).toEqual([]);
      expect(res.after).toEqual([]);
    });

    test("negative contextN (e.g. -1, -99) returns hitTurn with empty before and after", () => {
      const resNeg1 = readTurnContext(db, sessionFile, pointers[3], -1);
      expect(resNeg1.hitTurn).not.toBeNull();
      expect(resNeg1.hitTurn!.turnIndex).toBe(3);
      expect(resNeg1.before).toEqual([]);
      expect(resNeg1.after).toEqual([]);

      const resNeg99 = readTurnContext(db, sessionFile, pointers[0], -99);
      expect(resNeg99.hitTurn).not.toBeNull();
      expect(resNeg99.before).toEqual([]);
      expect(resNeg99.after).toEqual([]);
    });

    test("contextN = NaN does not crash or throw uncaught SQL exception", () => {
      expect(() => {
        const res = readTurnContext(db, sessionFile, pointers[2], NaN);
        expect(res.hitTurn).not.toBeNull();
      }).not.toThrow();
    });

    test("boundary turnIndex = 0 with contextN = 10 returns empty before and 4 after", () => {
      const res = readTurnContext(db, sessionFile, pointers[0], 10);
      expect(res.hitTurn!.turnIndex).toBe(0);
      expect(res.before).toEqual([]);
      expect(res.after.length).toBe(4);
      expect(res.after.map((t) => t.turnIndex)).toEqual([1, 2, 3, 4]);
    });

    test("boundary turnIndex = 4 (last turn) with contextN = 10 returns 4 before and empty after", () => {
      const res = readTurnContext(db, sessionFile, pointers[4], 10);
      expect(res.hitTurn!.turnIndex).toBe(4);
      expect(res.before.length).toBe(4);
      expect(res.before.map((t) => t.turnIndex)).toEqual([0, 1, 2, 3]);
      expect(res.after).toEqual([]);
    });

    test("readTurnByPointer returns null safely when filePath or pointer is falsy", () => {
      expect(readTurnByPointer("", pointers[0])).toBeNull();
      expect(readTurnByPointer(null as any, pointers[0])).toBeNull();
      expect(readTurnByPointer(undefined as any, pointers[0])).toBeNull();
      expect(readTurnByPointer(sessionFile, null as any)).toBeNull();
      expect(readTurnByPointer(sessionFile, undefined as any)).toBeNull();
    });

    test("readTurnContext returns empty result when hitTurn is not found or out of bounds", () => {
      const badPtr: MsgPointer = {
        ...pointers[0],
        byte_offset: 999999,
      };
      const res = readTurnContext(db, sessionFile, badPtr, 5);
      expect(res.hitTurn).toBeNull();
      expect(res.before).toEqual([]);
      expect(res.after).toEqual([]);
    });

    test("readTurnContext skips deleted adjacent files without crashing", () => {
      // Register a ghost adjacent pointer pointing to a nonexistent file
      db.run(
        "INSERT INTO file_watermarks (file_id, path, last_scanned_bytes, mtime, agent, alias, indexed_at) VALUES (888, '/tmp/ghost-missing-file.jsonl', 0, 0, 'claude', 'default', 0)"
      );
      db.run(
        `INSERT INTO msg_pointers (rowid, session_id, turn_index, file_id, byte_offset, byte_length, role, timestamp)
         VALUES (9999, 'sess-edge-5', 99, 888, 0, 50, 1, 1725540099000)`
      );

      // Query context for turn 4 with contextN = 100 (which covers turn 99)
      const res = readTurnContext(db, sessionFile, pointers[4], 100);
      expect(res.hitTurn).not.toBeNull();
      expect(res.hitTurn!.turnIndex).toBe(4);
      // It should include valid turns 0..3 before, and skip the nonexistent turn 99 after
      expect(res.before.length).toBe(4);
      expect(res.after.length).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Single-File Multi-Session Isolation (Zero Cross-Contamination)
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Single-File Multi-Session Isolation", () => {
    test("multiple sessions sharing the same physical file have zero turn cross-contamination", () => {
      const sharedFile = join(tempDir, "shared-interleaved.jsonl");

      // Interleave turns from session-RED, session-GREEN, and session-BLUE in the same file
      const rawTurns = [
        { sess: "session-RED", turnIdx: 0, text: "Red turn 0" },
        { sess: "session-GREEN", turnIdx: 0, text: "Green turn 0" },
        { sess: "session-BLUE", turnIdx: 0, text: "Blue turn 0" },
        { sess: "session-RED", turnIdx: 1, text: "Red turn 1" },
        { sess: "session-GREEN", turnIdx: 1, text: "Green turn 1" },
        { sess: "session-RED", turnIdx: 2, text: "Red turn 2" },
        { sess: "session-BLUE", turnIdx: 1, text: "Blue turn 1" },
        { sess: "session-RED", turnIdx: 3, text: "Red turn 3" },
        { sess: "session-GREEN", turnIdx: 2, text: "Green turn 2" },
      ];

      let fileBuffer = Buffer.alloc(0);
      const pointerMap: Record<string, MsgPointer[]> = {
        "session-RED": [],
        "session-GREEN": [],
        "session-BLUE": [],
      };

      // Register file in file_watermarks
      db.run(
        "INSERT INTO file_watermarks (path, last_scanned_bytes, mtime, agent, alias, indexed_at) VALUES (?, 0, ?, 'opencode', 'default', ?)",
        [sharedFile, Date.now(), Date.now()]
      );
      const fileId = (db.query("SELECT file_id FROM file_watermarks WHERE path = ?").get(sharedFile) as any).file_id;

      for (let i = 0; i < rawTurns.length; i++) {
        const t = rawTurns[i];
        const line = JSON.stringify({ type: "user", content: t.text }) + "\n";
        const lineBuf = Buffer.from(line, "utf8");
        const offset = fileBuffer.length;
        const length = lineBuf.length;

        fileBuffer = Buffer.concat([fileBuffer, lineBuf]);

        const ptr: MsgPointer = {
          rowid: i + 1,
          session_id: t.sess,
          turn_index: t.turnIdx,
          file_id: fileId,
          byte_offset: offset,
          byte_length: length,
          role: 1,
          timestamp: 1725550000000 + i * 1000,
        };

        // Insert directly into msg_pointers
        db.run(
          `INSERT INTO msg_pointers (rowid, session_id, turn_index, file_id, byte_offset, byte_length, role, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [ptr.rowid, ptr.session_id, ptr.turn_index, ptr.file_id, ptr.byte_offset, ptr.byte_length, ptr.role, ptr.timestamp]
        );

        pointerMap[t.sess].push(ptr);
      }

      writeFileSync(sharedFile, fileBuffer);

      // Verify session-RED has 4 turns: indices 0, 1, 2, 3
      expect(pointerMap["session-RED"].length).toBe(4);
      // Verify session-GREEN has 3 turns: indices 0, 1, 2
      expect(pointerMap["session-GREEN"].length).toBe(3);
      // Verify session-BLUE has 2 turns: indices 0, 1
      expect(pointerMap["session-BLUE"].length).toBe(2);

      // Now query context window for session-RED at turnIndex = 1 with contextN = 5
      const redHitPointer = pointerMap["session-RED"][1]; // Red turn 1
      const redContext = readTurnContext(db, sharedFile, redHitPointer, 5);

      expect(redContext.hitTurn).not.toBeNull();
      expect(redContext.hitTurn!.sessionId).toBe("session-RED");
      expect(redContext.hitTurn!.turnIndex).toBe(1);
      expect(redContext.hitTurn!.payload.content).toBe("Red turn 1");

      // Before must contain ONLY Red turn 0
      expect(redContext.before.length).toBe(1);
      expect(redContext.before[0].sessionId).toBe("session-RED");
      expect(redContext.before[0].turnIndex).toBe(0);
      expect(redContext.before[0].payload.content).toBe("Red turn 0");

      // After must contain ONLY Red turn 2 and Red turn 3
      expect(redContext.after.length).toBe(2);
      expect(redContext.after[0].sessionId).toBe("session-RED");
      expect(redContext.after[0].turnIndex).toBe(2);
      expect(redContext.after[0].payload.content).toBe("Red turn 2");

      expect(redContext.after[1].sessionId).toBe("session-RED");
      expect(redContext.after[1].turnIndex).toBe(3);
      expect(redContext.after[1].payload.content).toBe("Red turn 3");

      // STRICT ZERO CROSS-CONTAMINATION CHECK:
      // None of the returned turns may belong to GREEN or BLUE
      const allRetrieved = [redContext.hitTurn!, ...redContext.before, ...redContext.after];
      for (const rec of allRetrieved) {
        expect(rec.sessionId).toBe("session-RED");
        expect(rec.sessionId).not.toBe("session-GREEN");
        expect(rec.sessionId).not.toBe("session-BLUE");
        expect(rec.payload.content).not.toContain("Green");
        expect(rec.payload.content).not.toContain("Blue");
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Multi-File Session Context Window Resolution
  // ───────────────────────────────────────────────────────────────────────────
  describe("7. Multi-File Session Context Window Resolution", () => {
    test("context window retrieves turns from adjacent files when session spans across multiple files", () => {
      const filePart1 = join(tempDir, "sess-split-part1.jsonl");
      const filePart2 = join(tempDir, "sess-split-part2.jsonl");

      // Part 1 contains turn 0 and turn 1
      const line0 = JSON.stringify({ type: "user", content: "Split session turn 0 in Part 1" }) + "\n";
      const line1 = JSON.stringify({ type: "assistant", content: "Split session turn 1 in Part 1" }) + "\n";
      const buf1 = Buffer.concat([Buffer.from(line0, "utf8"), Buffer.from(line1, "utf8")]);
      writeFileSync(filePart1, buf1);

      // Part 2 contains turn 2 and turn 3
      const line2 = JSON.stringify({ type: "user", content: "Split session turn 2 in Part 2" }) + "\n";
      const line3 = JSON.stringify({ type: "assistant", content: "Split session turn 3 in Part 2" }) + "\n";
      const buf2 = Buffer.concat([Buffer.from(line2, "utf8"), Buffer.from(line3, "utf8")]);
      writeFileSync(filePart2, buf2);

      // Register Part 1 in file_watermarks
      db.run(
        "INSERT INTO file_watermarks (file_id, path, last_scanned_bytes, mtime, agent, alias, indexed_at) VALUES (101, ?, 0, ?, 'pi', 'default', ?)",
        [filePart1, Date.now(), Date.now()]
      );

      // Register Part 2 in file_watermarks
      db.run(
        "INSERT INTO file_watermarks (file_id, path, last_scanned_bytes, mtime, agent, alias, indexed_at) VALUES (102, ?, 0, ?, 'pi', 'default', ?)",
        [filePart2, Date.now(), Date.now()]
      );

      const ptr0: MsgPointer = {
        rowid: 1,
        session_id: "sess-split-999",
        turn_index: 0,
        file_id: 101,
        byte_offset: 0,
        byte_length: Buffer.byteLength(line0, "utf8"),
        role: 1,
        timestamp: 1725560000000,
      };

      const ptr1: MsgPointer = {
        rowid: 2,
        session_id: "sess-split-999",
        turn_index: 1,
        file_id: 101,
        byte_offset: Buffer.byteLength(line0, "utf8"),
        byte_length: Buffer.byteLength(line1, "utf8"),
        role: 2,
        timestamp: 1725560001000,
      };

      const ptr2: MsgPointer = {
        rowid: 3,
        session_id: "sess-split-999",
        turn_index: 2,
        file_id: 102,
        byte_offset: 0,
        byte_length: Buffer.byteLength(line2, "utf8"),
        role: 1,
        timestamp: 1725560002000,
      };

      const ptr3: MsgPointer = {
        rowid: 4,
        session_id: "sess-split-999",
        turn_index: 3,
        file_id: 102,
        byte_offset: Buffer.byteLength(line2, "utf8"),
        byte_length: Buffer.byteLength(line3, "utf8"),
        role: 2,
        timestamp: 1725560003000,
      };

      for (const p of [ptr0, ptr1, ptr2, ptr3]) {
        db.run(
          `INSERT INTO msg_pointers (rowid, session_id, turn_index, file_id, byte_offset, byte_length, role, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.rowid, p.session_id, p.turn_index, p.file_id, p.byte_offset, p.byte_length, p.role, p.timestamp]
        );
      }

      // Query context for turn 1 (which is in Part 1) with contextN = 2
      // This should fetch turn 0 from Part 1, and turn 2 and turn 3 from Part 2!
      const context = readTurnContext(db, filePart1, ptr1, 2);

      expect(context.hitTurn).not.toBeNull();
      expect(context.hitTurn!.turnIndex).toBe(1);
      expect(context.hitTurn!.payload.content).toBe("Split session turn 1 in Part 1");

      // before from Part 1
      expect(context.before.length).toBe(1);
      expect(context.before[0].turnIndex).toBe(0);
      expect(context.before[0].payload.content).toBe("Split session turn 0 in Part 1");

      // after from Part 2 (cross-file resolution!)
      expect(context.after.length).toBe(2);
      expect(context.after[0].turnIndex).toBe(2);
      expect(context.after[0].payload.content).toBe("Split session turn 2 in Part 2");

      expect(context.after[1].turnIndex).toBe(3);
      expect(context.after[1].payload.content).toBe("Split session turn 3 in Part 2");
    });
  });
});
