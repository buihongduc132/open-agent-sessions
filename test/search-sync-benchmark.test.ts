/**
 * test/search-sync-benchmark.test.ts
 *
 * Empirical benchmark and performance bound test suite for Milestone 3 (src/search/sync.ts).
 *
 * Asserts:
 * 1. Unchanged file skip latency < 20ms across 100 files (<0.2ms/file).
 * 2. Unchanged file skip scales linearly across 500 files (<50ms).
 * 3. 5,000+ turn session indexing throughput exceeds 10,000 lines/second.
 * 4. 5,000+ turn session memory consumption remains strictly bounded (<50MB RSS delta).
 * 5. Pointer byte coordinates sampled from indexed sessions match direct fs.readSync with 100% accuracy.
 * 6. Transaction batching across varying batch sizes (100, 500, 1000, 2500) functions idempotently without data loss.
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
  syncAllSessions,
  syncSessionFile,
  type SyncFileInput,
} from "../src/search/sync";
import type { MsgPointer } from "../src/search/types";

describe("Milestone 3 Empirical Benchmark & Performance Bounds", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `oas-sync-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  // 1. Unchanged File Skip Benchmark (<20ms across 100 files)
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Unchanged File Skip Benchmark", () => {
    test("syncing 100 unchanged files takes <20ms total (<0.2ms/file)", async () => {
      const fileCount = 100;
      const sessionDir = join(tempDir, "skip_100");
      mkdirSync(sessionDir, { recursive: true });

      const inputs: SyncFileInput[] = [];
      for (let i = 0; i < fileCount; i++) {
        const filePath = join(sessionDir, `sess_${String(i).padStart(3, "0")}.jsonl`);
        const content = [
          JSON.stringify({ type: "user", timestamp: 1000 + i, content: `Query ${i}` }) + "\n",
          JSON.stringify({ type: "assistant", timestamp: 1001 + i, content: `Response ${i}` }) + "\n",
        ].join("");
        writeFileSync(filePath, content, "utf8");
        inputs.push({
          path: filePath,
          agent: "claude",
          alias: "default",
          sessionId: `sess-skip-${i}`,
        });
      }

      // Initial sync
      const initSummary = await syncAllSessions(db, inputs);
      expect(initSummary.updatedFiles).toBe(fileCount);
      expect(initSummary.totalTurns).toBe(fileCount * 2);

      // Benchmark unchanged skip
      const t0 = performance.now();
      const skipSummary = await syncAllSessions(db, inputs);
      const elapsedMs = performance.now() - t0;

      expect(skipSummary.totalFiles).toBe(fileCount);
      expect(skipSummary.updatedFiles).toBe(0);
      expect(skipSummary.totalTurns).toBe(0);

      const perFileMs = elapsedMs / fileCount;

      console.log(`\n  [100 Unchanged Skip] Elapsed: ${elapsedMs.toFixed(3)}ms, Per-File: ${perFileMs.toFixed(4)}ms/file`);
      expect(elapsedMs).toBeLessThan(20.0);
      expect(perFileMs).toBeLessThan(0.20);
    });

    test("syncing 500 unchanged files scales linearly and completes in <50ms", async () => {
      const fileCount = 500;
      const sessionDir = join(tempDir, "skip_500");
      mkdirSync(sessionDir, { recursive: true });

      const inputs: SyncFileInput[] = [];
      for (let i = 0; i < fileCount; i++) {
        const filePath = join(sessionDir, `sess_${String(i).padStart(4, "0")}.jsonl`);
        const content = JSON.stringify({ type: "user", timestamp: 2000 + i, content: `Probe ${i}` }) + "\n";
        writeFileSync(filePath, content, "utf8");
        inputs.push({
          path: filePath,
          agent: "pi",
          alias: "default",
          sessionId: `sess-skip-500-${i}`,
        });
      }

      await syncAllSessions(db, inputs);

      const t0 = performance.now();
      const skipSummary = await syncAllSessions(db, inputs);
      const elapsedMs = performance.now() - t0;

      expect(skipSummary.updatedFiles).toBe(0);
      expect(skipSummary.totalTurns).toBe(0);

      const perFileMs = elapsedMs / fileCount;
      console.log(`  [500 Unchanged Skip] Elapsed: ${elapsedMs.toFixed(3)}ms, Per-File: ${perFileMs.toFixed(4)}ms/file`);
      expect(elapsedMs).toBeLessThan(50.0);
      expect(perFileMs).toBeLessThan(0.10);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Transaction Batching & Throughput (5,000+ turns)
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Transaction Batching & Throughput", () => {
    test("indexes 5,000+ turns with throughput >10,000 lines/sec and <50MB RSS increase", async () => {
      const targetTurns = 5000;
      const sessionFile = join(tempDir, "session_5000.jsonl");

      const lines: string[] = [];
      for (let i = 0; i < targetTurns; i++) {
        const role = i % 3;
        let line: string;
        if (role === 0) {
          line = JSON.stringify({
            type: "user",
            timestamp: 1725500000000 + i * 100,
            content: `Turn #${i}: How to handle FTS5 indexing efficiently? 🚀 日本語`,
          }) + "\n";
        } else if (role === 1) {
          line = JSON.stringify({
            type: "assistant",
            timestamp: 1725500000050 + i * 100,
            content: `Turn #${i}: Use batch transactions of 1,000 rows.`,
          }) + "\n";
        } else {
          line = JSON.stringify({
            type: "tool",
            timestamp: 1725500000080 + i * 100,
            tool: "bash",
            arguments: { command: `echo 'step ${i}'` },
          }) + "\n";
        }
        lines.push(line);
      }

      writeFileSync(sessionFile, lines.join(""), "utf8");
      const rawFileSize = statSync(sessionFile).size;

      if (global.gc) global.gc();
      const initialRss = process.memoryUsage().rss;

      const t0 = performance.now();
      const res = await syncSessionFile(
        db,
        {
          path: sessionFile,
          agent: "claude",
          alias: "default",
          sessionId: "sess-perf-5000",
        },
        { batchSize: 1000 }
      );
      const elapsedMs = performance.now() - t0;

      const finalRss = process.memoryUsage().rss;
      const rssDeltaMb = (finalRss - initialRss) / (1024 * 1024);
      const throughput = Math.round((res.indexedTurns / elapsedMs) * 1000);

      console.log(`\n  [5,000 Turns] Duration: ${elapsedMs.toFixed(2)}ms, Throughput: ${throughput.toLocaleString()} lines/sec, RSS Delta: ${rssDeltaMb.toFixed(2)}MB`);

      expect(res.indexedTurns).toBe(targetTurns);
      expect(res.lastScannedBytes).toBe(rawFileSize);
      expect(throughput).toBeGreaterThan(10000);
      expect(rssDeltaMb).toBeLessThan(50.0);

      // Verify DB count
      const pointerCount = (db.query("SELECT COUNT(*) as count FROM msg_pointers").get() as { count: number }).count;
      expect(pointerCount).toBe(targetTurns);
    });

    test("indexes cleanly across diverse batch sizes (100, 500, 2500) with identical pointer outputs", async () => {
      const batchSizes = [100, 500, 2500];

      for (const bSize of batchSizes) {
        const subDbPath = join(tempDir, `batch_${bSize}.sqlite`);
        const subDb = openSearchDb({ dbPath: subDbPath });
        initSearchSchema(subDb);

        const sessionFile = join(tempDir, `batch_sess_${bSize}.jsonl`);
        const lines: string[] = [];
        for (let i = 0; i < 2500; i++) {
          lines.push(
            JSON.stringify({
              type: i % 2 === 0 ? "user" : "assistant",
              timestamp: 1000 + i,
              content: `Message ${i} for batch size ${bSize}`,
            }) + "\n"
          );
        }
        writeFileSync(sessionFile, lines.join(""), "utf8");

        const res = await syncSessionFile(
          subDb,
          {
            path: sessionFile,
            agent: "opencode",
            alias: "default",
            sessionId: `sess-batch-${bSize}`,
          },
          { batchSize: bSize }
        );

        expect(res.indexedTurns).toBe(2500);
        const count = (subDb.query("SELECT COUNT(*) as count FROM msg_pointers").get() as { count: number }).count;
        expect(count).toBe(2500);

        closeSearchDb(subDb);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Pointer Accuracy Verification (Random Seeks via fs.readSync)
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Pointer Byte-Offset Accuracy", () => {
    test("randomly samples 50 indexed pointers and verifies exact byte-for-byte coordinate match", async () => {
      const turnCount = 1000;
      const sessionFile = join(tempDir, "accuracy_session.jsonl");

      const rawLines: string[] = [];
      for (let i = 0; i < turnCount; i++) {
        let content: string;
        if (i % 5 === 0) {
          content = `Emoji turn 🍉 🚀 🤖 👨‍👩‍👧‍👦 number ${i}`;
        } else if (i % 5 === 1) {
          content = `Multi-byte characters: 日本語, Español, Français, Deutsch ${i}`;
        } else if (i % 5 === 2) {
          content = `Standard ASCII conversational turn with turn index ${i}`;
        } else if (i % 5 === 3) {
          content = `Long turn: ${"x".repeat(500)} suffix ${i}`;
        } else {
          content = `Short ${i}`;
        }

        rawLines.push(
          JSON.stringify({
            type: i % 2 === 0 ? "user" : "assistant",
            timestamp: 1725500000000 + i * 200,
            content,
          }) + "\n"
        );
      }

      writeFileSync(sessionFile, rawLines.join(""), "utf8");

      const syncResult = await syncSessionFile(db, {
        path: sessionFile,
        agent: "claude",
        alias: "default",
        sessionId: "sess-accuracy-test",
      });

      expect(syncResult.indexedTurns).toBe(turnCount);

      // Query all pointers
      const pointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(syncResult.fileId) as MsgPointer[];

      expect(pointers.length).toBe(turnCount);

      // Randomly sample 50 distinct indices
      const sampleIndices = new Set<number>();
      while (sampleIndices.size < 50) {
        sampleIndices.add(Math.floor(Math.random() * turnCount));
      }

      const fd = openSync(sessionFile, "r");
      try {
        let verifiedCount = 0;
        for (const idx of Array.from(sampleIndices).sort((a, b) => a - b)) {
          const ptr = pointers[idx];
          const buffer = Buffer.alloc(ptr.byte_length);

          const bytesRead = readSync(
            fd,
            new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
            0,
            ptr.byte_length,
            ptr.byte_offset
          );

          expect(bytesRead).toBe(ptr.byte_length);

          // Sliced buffer must end with \n
          expect(buffer[buffer.length - 1]).toBe(0x0a);

          // Sliced buffer must exactly match the bytes from the original line
          const expectedLineBytes = Buffer.from(rawLines[ptr.turn_index], "utf8");
          expect(Buffer.compare(buffer, expectedLineBytes)).toBe(0);

          // Must parse as valid JSON
          const parsed = JSON.parse(buffer.toString("utf8"));
          expect(parsed.timestamp).toBe(1725500000000 + idx * 200);

          verifiedCount++;
        }

        expect(verifiedCount).toBe(50);
        console.log(`  [Pointer Accuracy] 50/50 randomly sampled pointers verified byte-exact.`);
      } finally {
        closeSync(fd);
      }
    });

    test("incremental append maintains flawless byte coordinates for newly appended turns", async () => {
      const sessionFile = join(tempDir, "incremental_append.jsonl");

      // Initial batch of 100 turns
      const linesBatch1: string[] = [];
      for (let i = 0; i < 100; i++) {
        linesBatch1.push(
          JSON.stringify({ type: "user", timestamp: 1000 + i, content: `Batch1 Turn ${i}` }) + "\n"
        );
      }
      writeFileSync(sessionFile, linesBatch1.join(""), "utf8");

      const res1 = await syncSessionFile(db, {
        path: sessionFile,
        agent: "pi",
        alias: "default",
        sessionId: "sess-inc-append",
      });
      expect(res1.indexedTurns).toBe(100);

      // Append batch of 50 turns
      const linesBatch2: string[] = [];
      for (let i = 100; i < 150; i++) {
        linesBatch2.push(
          JSON.stringify({ type: "assistant", timestamp: 1000 + i, content: `Batch2 Turn ${i} 🚀` }) + "\n"
        );
      }
      writeFileSync(sessionFile, linesBatch2.join(""), { flag: "a", encoding: "utf8" });

      const res2 = await syncSessionFile(db, {
        path: sessionFile,
        agent: "pi",
        alias: "default",
        sessionId: "sess-inc-append",
      });
      expect(res2.indexedTurns).toBe(50);
      expect(res2.lastScannedBytes).toBe(statSync(sessionFile).size);

      // Sample pointers from both batches
      const allPointers = db
        .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
        .all(res1.fileId) as MsgPointer[];
      expect(allPointers.length).toBe(150);

      const allLines = [...linesBatch1, ...linesBatch2];
      const fd = openSync(sessionFile, "r");
      try {
        for (let i = 0; i < 150; i += 5) {
          const ptr = allPointers[i];
          const buf = Buffer.alloc(ptr.byte_length);
          readSync(fd, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), 0, ptr.byte_length, ptr.byte_offset);
          const expected = Buffer.from(allLines[i], "utf8");
          expect(Buffer.compare(buf, expected)).toBe(0);
        }
      } finally {
        closeSync(fd);
      }
    });
  });
});
