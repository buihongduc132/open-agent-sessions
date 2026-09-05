/**
 * scripts/benchmark-reader.ts
 *
 * Comprehensive empirical benchmark and performance bound verification
 * for Milestone 4: Byte-Offset Direct File Reader (src/search/reader.ts).
 *
 * Verification objectives:
 * 1. Single-turn O(1) random seek performance across 5,000-turn session file:
 *    - 1,000 random seeks using readTurnByPointer.
 *    - Target: Average seek latency < 0.05ms/seek (<50 microseconds).
 *    - O(1) validation: Compare seek latency at head, middle, and tail of file.
 * 2. Context window query performance:
 *    - readTurnContext(db, filePath, pointer, 2) across 500 random positions.
 *    - Target: Average context retrieval latency < 0.5ms per hit.
 * 3. Memory boundedness:
 *    - RSS memory remains flat after 5,000 consecutive seeks (<10MB delta).
 * 4. File descriptor safety:
 *    - Verify zero file descriptor leaks after thousands of openSync/readSync/closeSync operations.
 */

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
import { syncSessionFile, type SyncFileInput } from "../src/search/sync";
import type { MsgPointer } from "../src/search/types";

interface Stats {
  count: number;
  totalMs: number;
  meanMs: number;
  meanUs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
}

function calculateStats(samplesMs: number[]): Stats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const count = sorted.length;
  const totalMs = sorted.reduce((sum, v) => sum + v, 0);
  const meanMs = totalMs / count;
  const meanUs = meanMs * 1000;
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
    meanUs,
    minMs,
    maxMs,
    p50Ms,
    p90Ms,
    p95Ms,
    p99Ms,
  };
}

function formatBytes(bytes: number): string {
  if (Math.abs(bytes) < 1024) return `${bytes} B`;
  if (Math.abs(bytes) < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getOpenFdCount(): number {
  try {
    const fds = readdirSync("/proc/self/fd");
    return fds.length;
  } catch {
    return -1;
  }
}

async function main() {
  console.log("================================================================================");
  console.log("  EMPIRICAL CHALLENGER BENCHMARK: Milestone 4 (src/search/reader.ts)");
  console.log("================================================================================");

  const tempDir = join(
    tmpdir(),
    `oas-reader-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempDir, { recursive: true });

  const dbPath = join(tempDir, "search.sqlite");
  const db = openSearchDb({ dbPath });
  initSearchSchema(db);

  const sessionFile = join(tempDir, "session_5000_turns.jsonl");
  const turnCount = 5000;

  console.log(`\n[Setup] Generating ${turnCount}-turn realistic session file...`);
  const initialFd = getOpenFdCount();

  const toolNames = ["bash", "read_file", "edit_file", "grep_search", "run_command"];
  const commands = [
    "git status",
    "bun test",
    "cat package.json",
    "ls -la src/search/",
    "cargo build --release",
    "dolt sql -q 'SELECT * FROM requirements'",
  ];

  let fileContent = "";
  for (let i = 0; i < turnCount; i++) {
    const roleType = i % 3;
    let turnObj: any;
    if (roleType === 0) {
      turnObj = {
        type: "user",
        timestamp: 1725500000000 + i * 1000,
        content: `User query ${i}: Please examine the system performance and trace latency bottlenecks for transaction #${i * 37}.`,
      };
    } else if (roleType === 1) {
      turnObj = {
        type: "assistant",
        timestamp: 1725500000200 + i * 1000,
        content: `Assistant reply ${i}: I have analyzed the execution traces. Turn index ${i} shows sub-millisecond seek times. Running verification command.`,
      };
    } else {
      turnObj = {
        type: "tool",
        timestamp: 1725500000400 + i * 1000,
        tool: toolNames[i % toolNames.length],
        arguments: {
          command: commands[i % commands.length],
          path: `/home/bhd/project/file_${i % 100}.ts`,
        },
      };
    }
    fileContent += JSON.stringify(turnObj) + "\n";
  }

  writeFileSync(sessionFile, fileContent, "utf8");
  const rawSize = statSync(sessionFile).size;
  console.log(`[Setup] Session file written: ${formatBytes(rawSize)} across ${turnCount} turns.`);

  console.log(`[Setup] Indexing session file into SQLite via syncSessionFile...`);
  const syncStart = performance.now();
  const syncRes = await syncSessionFile(db, {
    path: sessionFile,
    agent: "claude",
    alias: "default",
    sessionId: "sess-bench-5000-id",
  });
  const syncElapsed = performance.now() - syncStart;
  console.log(`[Setup] Indexing completed in ${syncElapsed.toFixed(2)}ms. Indexed turns: ${syncRes.indexedTurns}`);

  const pointers = db
    .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
    .all(syncRes.fileId) as MsgPointer[];

  if (pointers.length !== turnCount) {
    console.error(`FATAL: Expected ${turnCount} pointers in DB, got ${pointers.length}`);
    process.exit(1);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BENCHMARK 1: Single-Turn O(1) Random Seek Performance
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n================================================================================");
  console.log("  Benchmark 1: Single-Turn O(1) Random Seek Performance (1,000 seeks)");
  console.log("  Requirement: Average latency < 0.05ms/seek (< 50 microseconds)");
  console.log("================================================================================");

  // Warm-up 50 seeks
  for (let i = 0; i < 50; i++) {
    readTurnByPointer(sessionFile, pointers[i]);
  }

  const seekCount = 1000;
  const randomIndices: number[] = [];
  for (let i = 0; i < seekCount; i++) {
    randomIndices.push(Math.floor(Math.random() * turnCount));
  }

  const seekDurationsMs: number[] = new Array(seekCount);
  let seekValidCount = 0;

  const bench1Start = performance.now();
  for (let i = 0; i < seekCount; i++) {
    const idx = randomIndices[i];
    const pointer = pointers[idx];

    const t0 = performance.now();
    const record = readTurnByPointer(sessionFile, pointer);
    const t1 = performance.now();

    seekDurationsMs[i] = t1 - t0;

    if (
      record !== null &&
      record.turnIndex === pointer.turn_index &&
      record.sessionId === pointer.session_id &&
      record.payload !== null
    ) {
      seekValidCount++;
    }
  }
  const bench1TotalElapsed = performance.now() - bench1Start;
  const seekStats = calculateStats(seekDurationsMs);

  console.log(`• Seeks executed: ${seekStats.count}`);
  console.log(`• Data integrity check: ${seekValidCount}/${seekCount} valid records parsed`);
  console.log(`• Total duration: ${bench1TotalElapsed.toFixed(3)}ms (loop overhead included)`);
  console.log(`• Mean seek latency: ${seekStats.meanMs.toFixed(5)} ms (${seekStats.meanUs.toFixed(2)} µs)`);
  console.log(`• Min seek latency:  ${seekStats.minMs.toFixed(5)} ms (${(seekStats.minMs * 1000).toFixed(2)} µs)`);
  console.log(`• p50 (Median):      ${seekStats.p50Ms.toFixed(5)} ms (${(seekStats.p50Ms * 1000).toFixed(2)} µs)`);
  console.log(`• p90:               ${seekStats.p90Ms.toFixed(5)} ms (${(seekStats.p90Ms * 1000).toFixed(2)} µs)`);
  console.log(`• p95:               ${seekStats.p95Ms.toFixed(5)} ms (${(seekStats.p95Ms * 1000).toFixed(2)} µs)`);
  console.log(`• p99:               ${seekStats.p99Ms.toFixed(5)} ms (${(seekStats.p99Ms * 1000).toFixed(2)} µs)`);
  console.log(`• Max seek latency:  ${seekStats.maxMs.toFixed(5)} ms (${(seekStats.maxMs * 1000).toFixed(2)} µs)`);

  const seekPass = seekStats.meanMs < 0.05;
  console.log(`\n>>> VERDICT Benchmark 1: ${seekPass ? "PASS" : "FAIL"} (Mean: ${seekStats.meanUs.toFixed(2)} µs vs Threshold: 50.00 µs) <<<`);

  // O(1) Seeking Verification: Compare Head (turns 0-499), Middle (turns 2250-2749), and Tail (turns 4500-4999)
  console.log("\n--- O(1) Invariant Verification (File Offset Independence) ---");
  const headSamples: number[] = [];
  const midSamples: number[] = [];
  const tailSamples: number[] = [];
  const sectionSampleCount = 200;

  for (let i = 0; i < sectionSampleCount; i++) {
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

  console.log(`• Head turns (0-500, offset ~0MB):     Mean = ${headStats.meanUs.toFixed(2)} µs | p50 = ${(headStats.p50Ms * 1000).toFixed(2)} µs`);
  console.log(`• Middle turns (2250-2750, offset ~50%): Mean = ${midStats.meanUs.toFixed(2)} µs | p50 = ${(midStats.p50Ms * 1000).toFixed(2)} µs`);
  console.log(`• Tail turns (4500-5000, offset ~100%): Mean = ${tailStats.meanUs.toFixed(2)} µs | p50 = ${(tailStats.p50Ms * 1000).toFixed(2)} µs`);

  // ───────────────────────────────────────────────────────────────────────────
  // BENCHMARK 2: Context Window Query Performance (500 queries, window = 2)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n================================================================================");
  console.log("  Benchmark 2: Context Window Query Performance (500 positions, context = 2)");
  console.log("  Requirement: Average latency < 0.5ms/hit (< 500 microseconds)");
  console.log("================================================================================");

  // Warm-up 20 queries
  for (let i = 0; i < 20; i++) {
    readTurnContext(db, sessionFile, pointers[i], 2);
  }

  const ctxQueryCount = 500;
  const ctxIndices: number[] = [];
  for (let i = 0; i < ctxQueryCount; i++) {
    ctxIndices.push(Math.floor(Math.random() * turnCount));
  }

  const ctxDurationsMs: number[] = new Array(ctxQueryCount);
  let ctxValidCount = 0;

  const bench2Start = performance.now();
  for (let i = 0; i < ctxQueryCount; i++) {
    const idx = ctxIndices[i];
    const pointer = pointers[idx];

    const t0 = performance.now();
    const ctx = readTurnContext(db, sessionFile, pointer, 2);
    const t1 = performance.now();

    ctxDurationsMs[i] = t1 - t0;

    if (
      ctx.hitTurn !== null &&
      ctx.hitTurn.turnIndex === pointer.turn_index &&
      Array.isArray(ctx.before) &&
      Array.isArray(ctx.after)
    ) {
      ctxValidCount++;
    }
  }
  const bench2TotalElapsed = performance.now() - bench2Start;
  const ctxStats = calculateStats(ctxDurationsMs);

  console.log(`• Context queries executed: ${ctxStats.count}`);
  console.log(`• Integrity check: ${ctxValidCount}/${ctxQueryCount} valid context windows returned`);
  console.log(`• Total duration: ${bench2TotalElapsed.toFixed(3)}ms`);
  console.log(`• Mean context latency: ${ctxStats.meanMs.toFixed(5)} ms (${ctxStats.meanUs.toFixed(2)} µs)`);
  console.log(`• Min context latency:  ${ctxStats.minMs.toFixed(5)} ms (${(ctxStats.minMs * 1000).toFixed(2)} µs)`);
  console.log(`• p50 (Median):         ${ctxStats.p50Ms.toFixed(5)} ms (${(ctxStats.p50Ms * 1000).toFixed(2)} µs)`);
  console.log(`• p90:                  ${ctxStats.p90Ms.toFixed(5)} ms (${(ctxStats.p90Ms * 1000).toFixed(2)} µs)`);
  console.log(`• p95:                  ${ctxStats.p95Ms.toFixed(5)} ms (${(ctxStats.p95Ms * 1000).toFixed(2)} µs)`);
  console.log(`• p99:                  ${ctxStats.p99Ms.toFixed(5)} ms (${(ctxStats.p99Ms * 1000).toFixed(2)} µs)`);
  console.log(`• Max context latency:  ${ctxStats.maxMs.toFixed(5)} ms (${(ctxStats.maxMs * 1000).toFixed(2)} µs)`);

  const ctxPass = ctxStats.meanMs < 0.5;
  console.log(`\n>>> VERDICT Benchmark 2: ${ctxPass ? "PASS" : "FAIL"} (Mean: ${ctxStats.meanMs.toFixed(4)} ms vs Threshold: 0.50 ms) <<<`);

  // ───────────────────────────────────────────────────────────────────────────
  // BENCHMARK 3: RSS Memory Boundedness (5,000 consecutive seeks)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n================================================================================");
  console.log("  Benchmark 3: RSS Memory Boundedness (5,000 consecutive seeks)");
  console.log("  Requirement: RSS delta < 10MB after 5,000 consecutive seeks");
  console.log("================================================================================");

  // Force GC if available or wait for memory stabilization
  if (typeof Bun !== "undefined" && typeof (Bun as any).gc === "function") {
    (Bun as any).gc(true);
  }

  const memBefore = process.memoryUsage();
  console.log(`• Baseline RSS: ${formatBytes(memBefore.rss)} (Heap: ${formatBytes(memBefore.heapUsed)})`);

  const consecutiveCount = 5000;
  const checkpoints = [1000, 2000, 3000, 4000, 5000];
  let dummyAccumulator = 0;

  for (let i = 0; i < consecutiveCount; i++) {
    const pt = pointers[i];
    const rec = readTurnByPointer(sessionFile, pt);
    if (rec) {
      dummyAccumulator += rec.turnIndex;
    }

    if (checkpoints.includes(i + 1)) {
      const currentMem = process.memoryUsage();
      console.log(`  [Checkpoint ${i + 1} seeks] RSS: ${formatBytes(currentMem.rss)} (Heap: ${formatBytes(currentMem.heapUsed)})`);
    }
  }

  if (typeof Bun !== "undefined" && typeof (Bun as any).gc === "function") {
    (Bun as any).gc(true);
  }

  const memAfter = process.memoryUsage();
  const rssDelta = memAfter.rss - memBefore.rss;
  const heapDelta = memAfter.heapUsed - memBefore.heapUsed;

  console.log(`• Final RSS:    ${formatBytes(memAfter.rss)} (Heap: ${formatBytes(memAfter.heapUsed)})`);
  console.log(`• RSS Delta:    ${formatBytes(rssDelta)} (${rssDelta} bytes)`);
  console.log(`• Heap Delta:   ${formatBytes(heapDelta)} (${heapDelta} bytes)`);

  const memPass = rssDelta < 10 * 1024 * 1024;
  console.log(`\n>>> VERDICT Benchmark 3: ${memPass ? "PASS" : "FAIL"} (RSS Delta: ${formatBytes(rssDelta)} vs Cap: 10.00 MB) <<<`);

  // ───────────────────────────────────────────────────────────────────────────
  // BENCHMARK 4: File Descriptor Safety Check
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n================================================================================");
  console.log("  Benchmark 4: File Descriptor Leak Check");
  console.log("================================================================================");

  const finalFd = getOpenFdCount();
  console.log(`• Initial Open FDs: ${initialFd}`);
  console.log(`• Final Open FDs:   ${finalFd}`);
  const fdLeak = finalFd - initialFd;
  console.log(`• Leaked FDs:       ${fdLeak}`);

  const fdPass = fdLeak <= 0;
  console.log(`\n>>> VERDICT Benchmark 4: ${fdPass ? "PASS" : "FAIL"} (FD Leaks: ${fdLeak}) <<<`);

  // Cleanup
  closeSearchDb(db);
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log("\n================================================================================");
  const allPass = seekPass && ctxPass && memPass && fdPass;
  console.log(`  OVERALL M4 CHALLENGER VERDICT: ${allPass ? "APPROVE" : "REQUEST_CHANGES"}`);
  console.log("================================================================================\n");

  if (!allPass) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Benchmark failed with error:", err);
  process.exit(1);
});
