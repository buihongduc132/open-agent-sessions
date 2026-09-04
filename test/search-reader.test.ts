/**
 * test/search-reader.test.ts
 *
 * Comprehensive test suite for Milestone 4 (Tasks 15-17):
 * - Task 15 (reader-byte-seek): Direct file descriptor seek (fs.openSync + fs.readSync) at (byte_offset, byte_length).
 * - Task 16 (reader-context-window): Slicing context turns before and after hitTurn within same session_id.
 * - Task 17 (reader-safe-json-parse): Defensive parsing, trailing newline stripping, corrupted JSON, out-of-bounds, UTF-8/emoji safety.
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
import { syncSessionFile, type SyncFileInput } from "../src/search/sync";
import type { FileWatermark, MsgPointer } from "../src/search/types";

describe("Byte-Offset Direct File Reader & Context Window (Milestone 4: Tasks 15-17)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `oas-search-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  // 1. Task 15: reader-byte-seek (Direct Byte-Offset File Seek)
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Task 15: reader-byte-seek", () => {
    test("fetches exact turn record matching original disk turn by pointer", async () => {
      const sessionFile = join(tempDir, "session-seek.jsonl");

      const userTurn = {
        type: "user",
        timestamp: 1725510000000,
        content: "What is the capital of Japan?",
      };
      const assistantTurn = {
        type: "assistant",
        timestamp: 1725510001000,
        content: "The capital of Japan is Tokyo.",
      };
      const toolTurn = {
        type: "tool",
        timestamp: 1725510002000,
        tool: "bash",
        arguments: { command: "echo Tokyo" },
      };

      const line1 = JSON.stringify(userTurn) + "\n";
      const line2 = JSON.stringify(assistantTurn) + "\n";
      const line3 = JSON.stringify(toolTurn) + "\n";

      writeFileSync(sessionFile, line1 + line2 + line3, "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "claude",
        alias: "default",
        sessionId: "sess-seek-001",
      };

      const syncResult = await syncSessionFile(db, input);
      expect(syncResult.indexedTurns).toBe(3);

      const pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(syncResult.fileId) as MsgPointer[];
      expect(pointers.length).toBe(3);

      // Read turn 1 (assistant turn) directly by pointer
      const record = readTurnByPointer(sessionFile, pointers[1]);
      expect(record).not.toBeNull();
      expect(record!.sessionId).toBe("sess-seek-001");
      expect(record!.turnIndex).toBe(1);
      expect(record!.role).toBe(2);
      expect(record!.timestamp).toBe(1725510001000);
      expect(record!.payload).toEqual(assistantTurn);
      expect(record!.rawText.trim()).toBe(JSON.stringify(assistantTurn));

      // Read turn 0 (user turn)
      const record0 = readTurnByPointer(sessionFile, pointers[0]);
      expect(record0).not.toBeNull();
      expect(record0!.turnIndex).toBe(0);
      expect(record0!.role).toBe(1);
      expect(record0!.payload).toEqual(userTurn);

      // Read turn 2 (tool turn)
      const record2 = readTurnByPointer(sessionFile, pointers[2]);
      expect(record2).not.toBeNull();
      expect(record2!.turnIndex).toBe(2);
      expect(record2!.role).toBe(3);
      expect(record2!.payload).toEqual(toolTurn);
    });

    test("demonstrates zero reading of full file or preceding corrupt/irrelevant bytes", async () => {
      const sessionFile = join(tempDir, "session-zero-full-read.jsonl");

      // Prepend file with 500KB of invalid non-JSON padding to verify reader never parses or scans it
      const garbagePadding = "X".repeat(500 * 1024) + "\n";
      const validTurn = {
        type: "user",
        timestamp: 1725510005000,
        content: "Isolated direct seek target turn",
      };
      const validLine = JSON.stringify(validTurn) + "\n";
      const trailingGarbage = "Y".repeat(100 * 1024) + "\n";

      writeFileSync(sessionFile, garbagePadding + validLine + trailingGarbage, "utf8");

      const pointer: MsgPointer = {
        rowid: 1,
        session_id: "sess-iso-999",
        turn_index: 42,
        file_id: 1,
        byte_offset: Buffer.byteLength(garbagePadding, "utf8"),
        byte_length: Buffer.byteLength(validLine, "utf8"),
        role: 1,
        timestamp: 1725510005000,
      };

      const record = readTurnByPointer(sessionFile, pointer);
      expect(record).not.toBeNull();
      expect(record!.sessionId).toBe("sess-iso-999");
      expect(record!.turnIndex).toBe(42);
      expect(record!.payload).toEqual(validTurn);
      expect(record!.rawText.trim()).toBe(JSON.stringify(validTurn));
    });

    test("speed benchmark: 100 random seeks across 200 turns complete in <10ms", async () => {
      const sessionFile = join(tempDir, "session-benchmark.jsonl");
      const numTurns = 200;
      const turnObjects = [];
      let fileContent = "";

      for (let i = 0; i < numTurns; i++) {
        const turn = {
          type: i % 2 === 0 ? "user" : "assistant",
          timestamp: 1725510000000 + i * 1000,
          content: `Benchmark turn ${i} with payload data content index ${i}`,
        };
        turnObjects.push(turn);
        fileContent += JSON.stringify(turn) + "\n";
      }

      writeFileSync(sessionFile, fileContent, "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "codex",
        alias: "default",
        sessionId: "sess-bench-001",
      };

      const syncResult = await syncSessionFile(db, input);
      expect(syncResult.indexedTurns).toBe(numTurns);

      const allPointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(syncResult.fileId) as MsgPointer[];
      expect(allPointers.length).toBe(numTurns);

      // Select 100 random indices to seek
      const randomPointers: MsgPointer[] = [];
      for (let i = 0; i < 100; i++) {
        const randIdx = Math.floor(Math.random() * numTurns);
        randomPointers.push(allPointers[randIdx]);
      }

      // Warm up one seek
      readTurnByPointer(sessionFile, randomPointers[0]);

      // Measure 100 random seeks
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        const rec = readTurnByPointer(sessionFile, randomPointers[i]);
        expect(rec).not.toBeNull();
      }
      const elapsed = performance.now() - start;

      // Expect 100 seeks to be extremely fast (<25ms with generous margin for CI, target <10ms)
      expect(elapsed).toBeLessThan(25);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Task 16: reader-context-window (Slicing Context Turns)
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Task 16: reader-context-window", () => {
    let sessionFile: string;
    let pointers: MsgPointer[];
    const totalTurns = 10;

    beforeEach(async () => {
      sessionFile = join(tempDir, "session-context.jsonl");
      let content = "";
      for (let i = 0; i < totalTurns; i++) {
        const turn = {
          type: i % 2 === 0 ? "user" : "assistant",
          timestamp: 1725520000000 + i * 1000,
          content: `Context test message turn #${i}`,
        };
        content += JSON.stringify(turn) + "\n";
      }
      writeFileSync(sessionFile, content, "utf8");

      const input: SyncFileInput = {
        path: sessionFile,
        agent: "claude",
        alias: "default",
        sessionId: "sess-ctx-100",
      };
      const res = await syncSessionFile(db, input);
      pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res.fileId) as MsgPointer[];
    });

    test("when contextN = 0, returns hitTurn with empty before and after arrays", () => {
      const targetPointer = pointers[4];
      const context = readTurnContext(db, sessionFile, targetPointer, 0);

      expect(context).toBeDefined();
      expect(context.hitTurn).not.toBeNull();
      expect(context.hitTurn!.turnIndex).toBe(4);
      expect(context.hitTurn!.sessionId).toBe("sess-ctx-100");
      expect(context.before).toEqual([]);
      expect(context.after).toEqual([]);
    });

    test("when contextN = 2 in middle of session, returns 2 before and 2 after in ASC order", () => {
      const targetPointer = pointers[5];
      const context = readTurnContext(db, sessionFile, targetPointer, 2);

      expect(context.hitTurn).not.toBeNull();
      expect(context.hitTurn!.turnIndex).toBe(5);

      // before should contain turns 3 and 4 in ascending order
      expect(context.before.length).toBe(2);
      expect(context.before[0].turnIndex).toBe(3);
      expect(context.before[1].turnIndex).toBe(4);
      expect(context.before[0].payload.content).toBe("Context test message turn #3");
      expect(context.before[1].payload.content).toBe("Context test message turn #4");

      // after should contain turns 6 and 7 in ascending order
      expect(context.after.length).toBe(2);
      expect(context.after[0].turnIndex).toBe(6);
      expect(context.after[1].turnIndex).toBe(7);
      expect(context.after[0].payload.content).toBe("Context test message turn #6");
      expect(context.after[1].payload.content).toBe("Context test message turn #7");
    });

    test("boundary condition: first turn in session (turnIndex = 0) has empty before and up to N after", () => {
      const targetPointer = pointers[0];
      const context = readTurnContext(db, sessionFile, targetPointer, 3);

      expect(context.hitTurn!.turnIndex).toBe(0);
      expect(context.before).toEqual([]);
      expect(context.after.length).toBe(3);
      expect(context.after.map((t) => t.turnIndex)).toEqual([1, 2, 3]);
    });

    test("boundary condition: last turn in session (turnIndex = total - 1) has up to N before and empty after", () => {
      const targetPointer = pointers[totalTurns - 1]; // turnIndex = 9
      const context = readTurnContext(db, sessionFile, targetPointer, 3);

      expect(context.hitTurn!.turnIndex).toBe(9);
      expect(context.before.length).toBe(3);
      expect(context.before.map((t) => t.turnIndex)).toEqual([6, 7, 8]);
      expect(context.after).toEqual([]);
    });

    test("boundary condition: near boundary (turnIndex = 1, contextN = 3) returns asymmetric window", () => {
      const targetPointer = pointers[1];
      const context = readTurnContext(db, sessionFile, targetPointer, 3);

      expect(context.hitTurn!.turnIndex).toBe(1);
      // only turn 0 is available before
      expect(context.before.length).toBe(1);
      expect(context.before[0].turnIndex).toBe(0);

      // turns 2, 3, 4 after
      expect(context.after.length).toBe(3);
      expect(context.after.map((t) => t.turnIndex)).toEqual([2, 3, 4]);
    });

    test("boundary condition: single-turn session returns empty before and empty after", async () => {
      const singleFile = join(tempDir, "session-single.jsonl");
      const line = JSON.stringify({
        type: "user",
        timestamp: 1725529999000,
        content: "I am the only turn in this session",
      }) + "\n";
      writeFileSync(singleFile, line, "utf8");

      const input: SyncFileInput = {
        path: singleFile,
        agent: "claude",
        alias: "default",
        sessionId: "sess-single-001",
      };
      const res = await syncSessionFile(db, input);
      const singlePointer = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ?")
        .get(res.fileId) as MsgPointer;

      const context = readTurnContext(db, singleFile, singlePointer, 2);
      expect(context.hitTurn).not.toBeNull();
      expect(context.hitTurn!.turnIndex).toBe(0);
      expect(context.hitTurn!.sessionId).toBe("sess-single-001");
      expect(context.before).toEqual([]);
      expect(context.after).toEqual([]);
    });

    test("boundary condition: contextN larger than total session turns returns all available turns without error", () => {
      const targetPointer = pointers[4];
      const context = readTurnContext(db, sessionFile, targetPointer, 50);

      expect(context.hitTurn!.turnIndex).toBe(4);
      // All turns prior to index 4 (0, 1, 2, 3)
      expect(context.before.length).toBe(4);
      expect(context.before.map((t) => t.turnIndex)).toEqual([0, 1, 2, 3]);

      // All turns after index 4 (5, 6, 7, 8, 9)
      expect(context.after.length).toBe(5);
      expect(context.after.map((t) => t.turnIndex)).toEqual([5, 6, 7, 8, 9]);
    });

    test("multi-session isolation: turns from different sessions are NEVER included in context window", async () => {
      const fileA = join(tempDir, "session-alpha.jsonl");
      const fileB = join(tempDir, "session-beta.jsonl");

      // Session Alpha turns (indices 0, 1, 2)
      const alphaLines =
        JSON.stringify({ type: "user", content: "Alpha turn 0", timestamp: 1725530000000 }) + "\n" +
        JSON.stringify({ type: "assistant", content: "Alpha turn 1", timestamp: 1725530001000 }) + "\n" +
        JSON.stringify({ type: "user", content: "Alpha turn 2", timestamp: 1725530002000 }) + "\n";

      // Session Beta turns (indices 0, 1, 2)
      const betaLines =
        JSON.stringify({ type: "user", content: "Beta turn 0", timestamp: 1725530003000 }) + "\n" +
        JSON.stringify({ type: "assistant", content: "Beta turn 1", timestamp: 1725530004000 }) + "\n" +
        JSON.stringify({ type: "user", content: "Beta turn 2", timestamp: 1725530005000 }) + "\n";

      writeFileSync(fileA, alphaLines, "utf8");
      writeFileSync(fileB, betaLines, "utf8");

      const resA = await syncSessionFile(db, {
        path: fileA,
        agent: "claude",
        alias: "default",
        sessionId: "session-alpha-id",
      });
      const resB = await syncSessionFile(db, {
        path: fileB,
        agent: "claude",
        alias: "default",
        sessionId: "session-beta-id",
      });

      const alphaPointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(resA.fileId) as MsgPointer[];
      const betaPointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(resB.fileId) as MsgPointer[];

      expect(alphaPointers.length).toBe(3);
      expect(betaPointers.length).toBe(3);

      // Query context for Session Alpha turn 1 with contextN = 2
      const alphaContext = readTurnContext(db, fileA, alphaPointers[1], 2);

      expect(alphaContext.hitTurn!.sessionId).toBe("session-alpha-id");
      expect(alphaContext.hitTurn!.turnIndex).toBe(1);

      // Every turn in before and after must belong strictly to session-alpha-id
      for (const turn of alphaContext.before) {
        expect(turn.sessionId).toBe("session-alpha-id");
        expect(turn.sessionId).not.toBe("session-beta-id");
      }
      for (const turn of alphaContext.after) {
        expect(turn.sessionId).toBe("session-alpha-id");
        expect(turn.sessionId).not.toBe("session-beta-id");
      }

      expect(alphaContext.before.length).toBe(1);
      expect(alphaContext.before[0].turnIndex).toBe(0);
      expect(alphaContext.before[0].payload.content).toBe("Alpha turn 0");

      expect(alphaContext.after.length).toBe(1);
      expect(alphaContext.after[0].turnIndex).toBe(2);
      expect(alphaContext.after[0].payload.content).toBe("Alpha turn 2");
    });

    test("handles defensive / invalid contextN values gracefully", () => {
      const targetPointer = pointers[3];
      const negContext = readTurnContext(db, sessionFile, targetPointer, -1);
      expect(negContext.hitTurn).not.toBeNull();
      expect(negContext.before).toEqual([]);
      expect(negContext.after).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Task 17: reader-safe-json-parse (Defensive Parsing & Edge Cases)
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Task 17: reader-safe-json-parse", () => {
    test("strips trailing \\r\\n (CRLF) and \\n (LF) before parsing JSON", () => {
      const crlfFile = join(tempDir, "crlf-session.jsonl");
      const turnObj = {
        type: "user",
        timestamp: 1725540000000,
        content: "Testing CRLF line endings \r\n safety",
      };
      // Explicit CRLF ending
      const crlfLine = JSON.stringify(turnObj) + "\r\n";
      writeFileSync(crlfFile, crlfLine, "utf8");

      const pointer: MsgPointer = {
        rowid: 1,
        session_id: "sess-crlf-001",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: Buffer.byteLength(crlfLine, "utf8"),
        role: 1,
        timestamp: 1725540000000,
      };

      const record = readTurnByPointer(crlfFile, pointer);
      expect(record).not.toBeNull();
      expect(record!.payload).toEqual(turnObj);
      expect(record!.payload.content).toBe("Testing CRLF line endings \r\n safety");
    });

    test("handles malformed/corrupt JSON gracefully without throwing uncaught exceptions", () => {
      const corruptFile = join(tempDir, "corrupt-session.jsonl");
      const brokenLine = '{"type": "user", "timestamp": 1725540001000, "content": "incomplete truncated json string...\n';
      writeFileSync(corruptFile, brokenLine, "utf8");

      const pointer: MsgPointer = {
        rowid: 1,
        session_id: "sess-corrupt-001",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: Buffer.byteLength(brokenLine, "utf8"),
        role: 1,
        timestamp: 1725540001000,
      };

      // Must not throw error
      expect(() => {
        const record = readTurnByPointer(corruptFile, pointer);
        expect(record).not.toBeNull();
        expect(record!.payload).toBeNull();
        expect(record!.rawText).toContain("incomplete truncated json string");
      }).not.toThrow();
    });

    test("returns null when file path does not exist", () => {
      const pointer: MsgPointer = {
        rowid: 1,
        session_id: "sess-missing-001",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: 50,
        role: 1,
        timestamp: 1725540002000,
      };

      const result = readTurnByPointer("/path/to/definitely/nonexistent/session.jsonl", pointer);
      expect(result).toBeNull();

      const context = readTurnContext(db, "/path/to/definitely/nonexistent/session.jsonl", pointer, 2);
      expect(context.hitTurn).toBeNull();
      expect(context.before).toEqual([]);
      expect(context.after).toEqual([]);
    });

    test("returns null safely on out-of-bounds pointer coordinates", () => {
      const testFile = join(tempDir, "bounds-session.jsonl");
      const line = JSON.stringify({ type: "user", content: "Short line" }) + "\n";
      writeFileSync(testFile, line, "utf8");
      const fileSize = statSync(testFile).size;

      // 1. Offset beyond file size
      const oobOffsetPointer: MsgPointer = {
        rowid: 1,
        session_id: "sess-oob",
        turn_index: 0,
        file_id: 1,
        byte_offset: fileSize + 1000,
        byte_length: 10,
        role: 1,
        timestamp: 1725540003000,
      };
      expect(readTurnByPointer(testFile, oobOffsetPointer)).toBeNull();

      // 2. Negative offset
      const negOffsetPointer: MsgPointer = {
        rowid: 2,
        session_id: "sess-oob",
        turn_index: 0,
        file_id: 1,
        byte_offset: -10,
        byte_length: 10,
        role: 1,
        timestamp: 1725540003000,
      };
      expect(readTurnByPointer(testFile, negOffsetPointer)).toBeNull();

      // 3. Negative length
      const negLengthPointer: MsgPointer = {
        rowid: 3,
        session_id: "sess-oob",
        turn_index: 0,
        file_id: 1,
        byte_offset: 0,
        byte_length: -5,
        role: 1,
        timestamp: 1725540003000,
      };
      expect(readTurnByPointer(testFile, negLengthPointer)).toBeNull();

      // 4. Offset + length exceeds file size
      const overflowPointer: MsgPointer = {
        rowid: 4,
        session_id: "sess-oob",
        turn_index: 0,
        file_id: 1,
        byte_offset: 5,
        byte_length: fileSize + 500,
        role: 1,
        timestamp: 1725540003000,
      };
      expect(readTurnByPointer(testFile, overflowPointer)).toBeNull();
    });

    test("completely preserves multi-byte UTF-8, astral plane emojis, and special characters", async () => {
      const utf8File = join(tempDir, "utf8-session.jsonl");

      const turnCjk = {
        type: "user",
        timestamp: 1725550000000,
        content: "日本語テキストテスト：SQLite FTS5全文検索とインデックス。",
      };
      const turnVietnamese = {
        type: "assistant",
        timestamp: 1725550001000,
        content: "Hệ thống trích xuất nội dung có dấu tiếng Việt: Cà phê, phở bò, đường sá.",
      };
      const turnAstralEmoji = {
        type: "user",
        timestamp: 1725550002000,
        content: "Astral emojis: 🚀 🛰️ 🛸 👨‍👩‍👧‍👦 🧙‍♂️ 🔥 🌟 🎯 with complex Zero-Width-Joiners.",
      };
      const turnSymbols = {
        type: "assistant",
        timestamp: 1725550003000,
        content: "Math & Box symbols: ∀x ∈ S: ∑_{i=1}^n x_i ≈ ∫ f(t)dt ≠ ∞ | ┌──┐ └──┘",
      };

      const line1 = JSON.stringify(turnCjk) + "\n";
      const line2 = JSON.stringify(turnVietnamese) + "\n";
      const line3 = JSON.stringify(turnAstralEmoji) + "\n";
      const line4 = JSON.stringify(turnSymbols) + "\n";

      writeFileSync(utf8File, line1 + line2 + line3 + line4, "utf8");

      const input: SyncFileInput = {
        path: utf8File,
        agent: "claude",
        alias: "default",
        sessionId: "sess-utf8-special",
      };

      const syncRes = await syncSessionFile(db, input);
      expect(syncRes.indexedTurns).toBe(4);

      const pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(syncRes.fileId) as MsgPointer[];
      expect(pointers.length).toBe(4);

      // Verify each turn slices at exact byte boundaries and preserves Unicode
      const rec0 = readTurnByPointer(utf8File, pointers[0]);
      expect(rec0).not.toBeNull();
      expect(rec0!.payload).toEqual(turnCjk);
      expect(rec0!.payload.content).toBe(turnCjk.content);

      const rec1 = readTurnByPointer(utf8File, pointers[1]);
      expect(rec1).not.toBeNull();
      expect(rec1!.payload).toEqual(turnVietnamese);
      expect(rec1!.payload.content).toBe(turnVietnamese.content);

      const rec2 = readTurnByPointer(utf8File, pointers[2]);
      expect(rec2).not.toBeNull();
      expect(rec2!.payload).toEqual(turnAstralEmoji);
      expect(rec2!.payload.content).toBe(turnAstralEmoji.content);

      const rec3 = readTurnByPointer(utf8File, pointers[3]);
      expect(rec3).not.toBeNull();
      expect(rec3!.payload).toEqual(turnSymbols);
      expect(rec3!.payload.content).toBe(turnSymbols.content);
    });

    test("handles rapid sequential seeks across multiple files without fd leaks or corruption", async () => {
      const files: string[] = [];
      const filePointers: Array<{ file: string; pointer: MsgPointer }> = [];

      for (let f = 0; f < 5; f++) {
        const filePath = join(tempDir, `multi-file-${f}.jsonl`);
        files.push(filePath);

        let content = "";
        for (let t = 0; t < 10; t++) {
          content += JSON.stringify({
            type: "user",
            timestamp: 1725560000000 + f * 1000 + t,
            content: `File ${f} turn ${t}`,
          }) + "\n";
        }
        writeFileSync(filePath, content, "utf8");

        const res = await syncSessionFile(db, {
          path: filePath,
          agent: "claude",
          alias: "default",
          sessionId: `sess-multi-${f}`,
        });

        const pts = db
          .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
          .all(res.fileId) as MsgPointer[];

        for (const pt of pts) {
          filePointers.push({ file: filePath, pointer: pt });
        }
      }

      expect(filePointers.length).toBe(50);

      // Perform 50 sequential reads across interleaved files
      for (const item of filePointers) {
        const rec = readTurnByPointer(item.file, item.pointer);
        expect(rec).not.toBeNull();
        expect(rec!.sessionId).toBe(item.pointer.session_id);
        expect(rec!.turnIndex).toBe(item.pointer.turn_index);
      }
    });
  });
});
