/**
 * test/search-reader-benchmark.test.ts
 *
 * Empirical benchmark and performance bound verification for Milestone 4 (src/search/reader.ts).
 *
 * Verifies:
 * 1. Single-turn O(1) random seek latency < 0.05ms/seek (<50µs) across 1,000 seeks in 5,000-turn session.
 * 2. O(1) offset invariance: head (offset ~0) vs middle (~50%) vs tail (~100%) have identical latency.
 * 3. Context window query latency < 0.5ms/hit across 500 random positions (context = 2).
 * 4. Memory boundedness: RSS memory remains flat (<10MB delta) after 5,000 consecutive seeks.
 * 5. File descriptor safety: zero leaked file descriptors after thousands of seeks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
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
import type { MsgPointer } from "../src/search/types";

function calculateStats(samplesMs: number[]) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const count = sorted.length;
  const totalMs = sorted.reduce((sum, v) => sum + v, 0);
  const meanMs = totalMs / count;
  const minMs = sorted[0];
  const maxMs = sorted[count - 1];
  const p50Ms = sorted[Math.floor(count * 0.5)];
  const p90Ms = sorted[Math.floor(count * 0.9)];
  const p95Ms = sorted[Math.floor(count * 0.95)];
  const p99Ms = sorted[Math.floor(count * 0.99)];

  return {
    count,
    totalMs,
    meanMs,
    meanUs: meanMs * 1000,
    minMs,
    maxMs,
    p50Ms,
    p90Ms,
    p95Ms,
    p99Ms,
  };
}

function getOpenFdCount(): number {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return -1;
  }
}

describe("Milestone 4 Empirical Benchmark & Performance Bounds (src/search/reader.ts)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let sessionFile: string;
  let pointers: MsgPointer[];
  const turnCount = 5000;

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `oas-reader-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "search.sqlite");
    db = openSearchDb({ dbPath });
    initSearchSchema(db);

    sessionFile = join(tempDir, "session_5000_turns.jsonl");

    const toolNames = ["bash", "read_file", "edit_file", "grep_search", "run_command"];
    const commands = [
      "git status",
      "bun test",
      "cat package.json",
      "ls -la src/search/",
      "cargo build --release",
      "dolt sql -q 'SELECT * FROM requirements'",
    ];

    let content = "";
    for (let i = 0; i < turnCount; i++) {
      const roleType = i % 3;
      let turnObj: any;
      if (roleType === 0) {
        turnObj = {
          type: "user",
          timestamp: 1725500000000 + i * 1000,
          content: `Benchmark user prompt #${i}: requesting analysis on component ${i % 25}`,
        };
      } else if (roleType === 1) {
        turnObj = {
          type: "assistant",
          timestamp: 1725500000200 + i * 1000,
          content: `Benchmark assistant answer #${i}: verified component ${i % 25} in O(1) latency.`,
        };
      } else {
        turnObj = {
          type: "tool",
          timestamp: 1725500000400 + i * 1000,
          tool: toolNames[i % toolNames.length],
          arguments: {
            command: commands[i % commands.length],
            path: `/src/file_${i % 50}.ts`,
          },
        };
      }
      content += JSON.stringify(turnObj) + "\n";
    }

    writeFileSync(sessionFile, content, "utf8");

    const syncRes = await syncSessionFile(db, {
      path: sessionFile,
      agent: "claude",
      alias: "default",
      sessionId: "sess-bench-5000",
    });

    pointers = db
      .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
      .all(syncRes.fileId) as MsgPointer[];
  });

  afterEach(() => {
    closeSearchDb(db);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Single-Turn O(1) Random Seek Performance
  // ───────────────────────────────────────────────────────────────────────────
  test("1,000 random seeks across 5,000 turns achieve average latency < 0.05ms (<50µs)", () => {
    expect(pointers.length).toBe(turnCount);

    // Warm-up 50 seeks
    for (let i = 0; i < 50; i++) {
      readTurnByPointer(sessionFile, pointers[i]);
    }

    const seekCount = 1000;
    const durationsMs: number[] = new Array(seekCount);

    for (let i = 0; i < seekCount; i++) {
      const randIdx = Math.floor(Math.random() * turnCount);
      const ptr = pointers[randIdx];

      const t0 = performance.now();
      const rec = readTurnByPointer(sessionFile, ptr);
      const t1 = performance.now();

      durationsMs[i] = t1 - t0;

      expect(rec).not.toBeNull();
      expect(rec!.turnIndex).toBe(ptr.turn_index);
      expect(rec!.sessionId).toBe("sess-bench-5000");
    }

    const stats = calculateStats(durationsMs);
    console.log(
      `[Benchmark 1] Seeks: ${stats.count} | Mean: ${stats.meanUs.toFixed(2)}µs | p50: ${(stats.p50Ms * 1000).toFixed(2)}µs | p95: ${(stats.p95Ms * 1000).toFixed(2)}µs | p99: ${(stats.p99Ms * 1000).toFixed(2)}µs`
    );

    // Bound check: average seek latency must be <0.05ms (<50 microseconds)
    expect(stats.meanMs).toBeLessThan(0.05);
  });

  test("O(1) offset invariance: seek latency is independent of byte offset in file", () => {
    const sampleSize = 200;
    const headSamples: number[] = [];
    const midSamples: number[] = [];
    const tailSamples: number[] = [];

    // Warmup
    readTurnByPointer(sessionFile, pointers[0]);

    for (let i = 0; i < sampleSize; i++) {
      const headIdx = Math.floor(Math.random() * 500);
      const midIdx = 2250 + Math.floor(Math.random() * 500);
      const tailIdx = 4500 + Math.floor(Math.random() * 500);

      const t0 = performance.now();
      readTurnByPointer(sessionFile, pointers[headIdx]);
      headSamples.push(performance.now() - t0);

      const t1 = performance.now();
      readTurnByPointer(sessionFile, pointers[midIdx]);
      midSamples.push(performance.now() - t1);

      const t2 = performance.now();
      readTurnByPointer(sessionFile, pointers[tailIdx]);
      tailSamples.push(performance.now() - t2);
    }

    const headStats = calculateStats(headSamples);
    const midStats = calculateStats(midSamples);
    const tailStats = calculateStats(tailSamples);

    console.log(
      `[O(1) Invariant] Head: ${headStats.meanUs.toFixed(2)}µs | Mid: ${midStats.meanUs.toFixed(2)}µs | Tail: ${tailStats.meanUs.toFixed(2)}µs`
    );

    // All section means should be well below 50µs
    expect(headStats.meanMs).toBeLessThan(0.05);
    expect(midStats.meanMs).toBeLessThan(0.05);
    expect(tailStats.meanMs).toBeLessThan(0.05);

    // Tail seeks should not be significantly slower than head seeks (ratio < 2.5x)
    expect(tailStats.meanMs).toBeLessThan(headStats.meanMs * 2.5 + 0.02);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Context Window Query Performance
  // ───────────────────────────────────────────────────────────────────────────
  test("500 context window queries (context=2) achieve average latency < 0.5ms (<500µs)", () => {
    // Warm-up 20 context queries
    for (let i = 0; i < 20; i++) {
      readTurnContext(db, sessionFile, pointers[i], 2);
    }

    const queryCount = 500;
    const durationsMs: number[] = new Array(queryCount);

    for (let i = 0; i < queryCount; i++) {
      const randIdx = Math.floor(Math.random() * turnCount);
      const ptr = pointers[randIdx];

      const t0 = performance.now();
      const ctx = readTurnContext(db, sessionFile, ptr, 2);
      const t1 = performance.now();

      durationsMs[i] = t1 - t0;

      expect(ctx.hitTurn).not.toBeNull();
      expect(ctx.hitTurn!.turnIndex).toBe(ptr.turn_index);
      expect(ctx.before.length).toBeLessThanOrEqual(2);
      expect(ctx.after.length).toBeLessThanOrEqual(2);
    }

    const stats = calculateStats(durationsMs);
    console.log(
      `[Benchmark 2] Context queries: ${stats.count} | Mean: ${stats.meanMs.toFixed(4)}ms (${stats.meanUs.toFixed(2)}µs) | p50: ${(stats.p50Ms * 1000).toFixed(2)}µs | p95: ${(stats.p95Ms * 1000).toFixed(2)}µs | p99: ${(stats.p99Ms * 1000).toFixed(2)}µs`
    );

    // Bound check: average context retrieval time must be <0.5ms per hit
    expect(stats.meanMs).toBeLessThan(0.5);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. RSS Memory Boundedness
  // ───────────────────────────────────────────────────────────────────────────
  test("RSS memory remains flat (<10MB delta) after 5,000 consecutive seeks", () => {
    if (typeof Bun !== "undefined" && typeof (Bun as any).gc === "function") {
      (Bun as any).gc(true);
    }

    const rssBefore = process.memoryUsage().rss;
    let checksum = 0;

    for (let i = 0; i < turnCount; i++) {
      const rec = readTurnByPointer(sessionFile, pointers[i]);
      if (rec) {
        checksum += rec.turnIndex;
      }
    }

    expect(checksum).toBeGreaterThan(0);

    if (typeof Bun !== "undefined" && typeof (Bun as any).gc === "function") {
      (Bun as any).gc(true);
    }

    const rssAfter = process.memoryUsage().rss;
    const rssDelta = rssAfter - rssBefore;
    const rssDeltaMB = rssDelta / (1024 * 1024);

    console.log(
      `[Benchmark 3] Memory RSS Before: ${(rssBefore / 1024 / 1024).toFixed(2)}MB | After: ${(rssAfter / 1024 / 1024).toFixed(2)}MB | Delta: ${rssDeltaMB.toFixed(2)}MB`
    );

    // Bound check: RSS delta must be <10MB
    expect(rssDeltaMB).toBeLessThan(10);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. File Descriptor Leak Safety
  // ───────────────────────────────────────────────────────────────────────────
  test("zero file descriptor leaks after 1,000 seeks", () => {
    const fdStart = getOpenFdCount();
    if (fdStart === -1) {
      return; // Not on Linux /proc/self/fd
    }

    for (let i = 0; i < 1000; i++) {
      readTurnByPointer(sessionFile, pointers[i % pointers.length]);
    }

    const fdEnd = getOpenFdCount();
    expect(fdEnd).toBeLessThanOrEqual(fdStart);
  });
});
