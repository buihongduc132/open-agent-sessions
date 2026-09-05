/**
 * scripts/benchmark-sync.ts
 *
 * Comprehensive empirical benchmark and performance bound verification
 * for Milestone 3 Sync Engine (src/search/sync.ts).
 *
 * Evaluates:
 * 1. Unchanged file skip latency (<20ms across 100 files, <0.2ms/file).
 * 2. Large session indexing throughput (>10,000 lines/sec on 5,000+ turns).
 * 3. Memory bounding (<50MB RSS increase).
 * 4. Contentless index storage footprint vs raw session data.
 * 5. Pointer byte-coordinate accuracy across 50 random samples.
 */

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
import { Database } from "bun:sqlite";

import { closeSearchDb, initSearchSchema, openSearchDb } from "../src/search/db";
import {
  syncAllSessions,
  syncSessionFile,
  type SyncFileInput,
} from "../src/search/sync";
import type { MsgPointer } from "../src/search/types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark 1: Unchanged File Skip Performance
// ─────────────────────────────────────────────────────────────────────────────
async function benchmarkUnchangedFileSkip(tempDir: string) {
  console.log("\n================================================================================");
  console.log("  Benchmark 1: Unchanged File Skip Performance (Target: <20ms for 100 files)");
  console.log("================================================================================");

  const dbPath = join(tempDir, "skip_benchmark.sqlite");
  const db = openSearchDb({ dbPath });
  initSearchSchema(db);

  const fileCount = 100;
  const sessionDir = join(tempDir, "skip_sessions");
  mkdirSync(sessionDir, { recursive: true });

  const inputs: SyncFileInput[] = [];

  console.log(`• Generating ${fileCount} session files with 5 turns each...`);
  for (let i = 0; i < fileCount; i++) {
    const filePath = join(sessionDir, `session_${String(i).padStart(4, "0")}.jsonl`);
    const turns = [
      JSON.stringify({ type: "user", timestamp: 1725500000000 + i * 1000, content: `User query in file ${i}` }) + "\n",
      JSON.stringify({ type: "assistant", timestamp: 1725500000100 + i * 1000, content: `Assistant reply in file ${i}` }) + "\n",
      JSON.stringify({ type: "tool", timestamp: 1725500000200 + i * 1000, tool: "bash", arguments: { command: `ls -la /tmp/${i}` } }) + "\n",
      JSON.stringify({ type: "assistant", timestamp: 1725500000300 + i * 1000, content: `Operation completed for file ${i}` }) + "\n",
      JSON.stringify({ type: "user", timestamp: 1725500000400 + i * 1000, content: `Thank you for file ${i}` }) + "\n",
    ].join("");

    writeFileSync(filePath, turns, "utf8");
    inputs.push({
      path: filePath,
      agent: "claude",
      alias: "default",
      sessionId: `sess-skip-${i}`,
    });
  }

  // Initial Sync
  console.log("• Running initial sync to index files and populate file_watermarks...");
  const initialSummary = await syncAllSessions(db, inputs);
  console.log(`  Initial sync indexed: ${initialSummary.updatedFiles} files, ${initialSummary.totalTurns} turns.`);

  // Warmup run on unchanged files
  await syncAllSessions(db, inputs);

  // Timed Unchanged Sync Runs (5 iterations to compute average and min)
  console.log("• Running 5 benchmark iterations on 100 unchanged files...");
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    const summary = await syncAllSessions(db, inputs);
    const t1 = performance.now();
    const elapsed = t1 - t0;
    runs.push(elapsed);
    if (summary.updatedFiles !== 0 || summary.totalTurns !== 0) {
      throw new Error(`Unchanged skip failure: updatedFiles=${summary.updatedFiles}, totalTurns=${summary.totalTurns}`);
    }
  }

  const minTime = Math.min(...runs);
  const avgTime = runs.reduce((a, b) => a + b, 0) / runs.length;
  const perFileMs = avgTime / fileCount;

  console.log("\nResults:");
  console.log(`  Files Tested       : ${fileCount}`);
  console.log(`  Min Time           : ${minTime.toFixed(3)} ms`);
  console.log(`  Average Time       : ${avgTime.toFixed(3)} ms`);
  console.log(`  Per-File Latency   : ${perFileMs.toFixed(4)} ms / file`);
  console.log(`  Target Requirement : <20.00 ms total (<0.20 ms / file)`);
  const pass = avgTime < 20.0 && perFileMs < 0.2;
  console.log(`  Verdict            : ${pass ? "PASS ✓" : "FAIL ✗"}`);

  closeSearchDb(db);
  return { fileCount, minTime, avgTime, perFileMs, pass };
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark 2: Transaction Batching and Throughput (5,000+ turns)
// ─────────────────────────────────────────────────────────────────────────────
async function benchmarkThroughputAndMemory(tempDir: string) {
  console.log("\n================================================================================");
  console.log("  Benchmark 2: Throughput, Batching & Memory (Target: >10,000 lines/sec, <50MB RSS)");
  console.log("================================================================================");

  const dbPath = join(tempDir, "throughput_benchmark.sqlite");
  const db = openSearchDb({ dbPath });
  initSearchSchema(db);

  const targetTurns = 5000;
  const sessionFile = join(tempDir, "large_session_5000.jsonl");

  console.log(`• Generating large session file with ${targetTurns} realistic turns...`);
  const lines: string[] = [];

  // Seed turns with realistic content: conversational text, multi-byte UTF-8, tool arguments, reasoning
  const sampleTopics = [
    "FTS5 inverted index optimization with unicode61 tokenizer",
    "Direct byte seek via fs.openSync and fs.readSync at byte_offset",
    "Watermark synchronization with mtime and last_scanned_bytes",
    "Contentless virtual table content='' with secondary pointers",
    "Multi-turn context window slicing with --context flag",
  ];

  for (let i = 0; i < targetTurns; i++) {
    const topic = sampleTopics[i % sampleTopics.length];
    const roleChoice = i % 4;
    let turnObj: Record<string, unknown>;

    if (roleChoice === 0) {
      turnObj = {
        type: "user",
        timestamp: 1725500000000 + i * 500,
        content: `Turn #${i}: How can we optimize ${topic}? Here are some Japanese test characters: 日本語テスト and emojis: 🚀⚡🔍.`,
      };
    } else if (roleChoice === 1) {
      turnObj = {
        type: "assistant",
        timestamp: 1725500000100 + i * 500,
        content: `Turn #${i}: For ${topic}, we implement batch transactions (1,000 items/tx) and verify coordinate alignment.`,
      };
    } else if (roleChoice === 2) {
      turnObj = {
        type: "tool",
        timestamp: 1725500000200 + i * 500,
        tool: "bash",
        arguments: {
          command: `bun test --filter="batching_${i}" src/search/sync.ts --verbose`,
          cwd: `/home/bhd/Documents/Projects/bhd/open-agent-sessions/session_${i}`,
        },
      };
    } else {
      turnObj = {
        type: "assistant",
        timestamp: 1725500000300 + i * 500,
        content: [
          { type: "thinking", thinking: `Analyzing transaction boundary for turn ${i}.` },
          { type: "text", text: `Verification passed for ${topic}.` },
        ],
      };
    }

    lines.push(JSON.stringify(turnObj) + "\n");
  }

  writeFileSync(sessionFile, lines.join(""), "utf8");
  const rawFileSize = statSync(sessionFile).size;
  console.log(`• Session file written: ${formatBytes(rawFileSize)} (${lines.length} lines)`);

  // Force garbage collection if exposed to stabilize baseline
  if (global.gc) {
    global.gc();
  }

  const initialRss = process.memoryUsage().rss;
  const initialHeap = process.memoryUsage().heapUsed;

  console.log("• Syncing 5,000-turn session file into SQLite index...");
  const t0 = performance.now();
  const syncResult = await syncSessionFile(
    db,
    {
      path: sessionFile,
      agent: "claude",
      alias: "default",
      sessionId: "sess-large-5000",
    },
    { batchSize: 1000 }
  );
  const t1 = performance.now();
  const elapsedMs = t1 - t0;

  const finalRss = process.memoryUsage().rss;
  const finalHeap = process.memoryUsage().heapUsed;

  const rssDeltaMb = (finalRss - initialRss) / (1024 * 1024);
  const heapDeltaMb = (finalHeap - initialHeap) / (1024 * 1024);
  const throughput = Math.round((syncResult.indexedTurns / elapsedMs) * 1000);

  // Check SQLite database size on disk
  const dbFileSize = statSync(dbPath).size;
  let walSize = 0;
  const walPath = `${dbPath}-wal`;
  if (existsSync(walPath)) {
    walSize = statSync(walPath).size;
  }
  const totalDbSize = dbFileSize + walSize;
  const storageRatioPct = ((totalDbSize / rawFileSize) * 100).toFixed(2);

  // Verify record counts
  const pointerCount = (db.query("SELECT COUNT(*) as count FROM msg_pointers").get() as { count: number }).count;
  const watermarkRow = db.query("SELECT * FROM file_watermarks WHERE path = ?").get(sessionFile) as { last_scanned_bytes: number };

  console.log("\nResults:");
  console.log(`  Indexed Turns      : ${syncResult.indexedTurns.toLocaleString()}`);
  console.log(`  Pointers in DB     : ${pointerCount.toLocaleString()}`);
  console.log(`  Watermark Offset   : ${watermarkRow.last_scanned_bytes.toLocaleString()} / ${rawFileSize.toLocaleString()} bytes`);
  console.log(`  Indexing Time      : ${elapsedMs.toFixed(2)} ms`);
  console.log(`  Throughput         : ${throughput.toLocaleString()} lines/sec (Target: >10,000 lines/sec)`);
  console.log(`  Initial RSS        : ${formatBytes(initialRss)}`);
  console.log(`  Final RSS          : ${formatBytes(finalRss)}`);
  console.log(`  RSS Delta          : ${rssDeltaMb.toFixed(2)} MB (Target: <50 MB)`);
  console.log(`  Heap Delta         : ${heapDeltaMb.toFixed(2)} MB`);
  console.log(`  Raw JSONL Size     : ${formatBytes(rawFileSize)}`);
  console.log(`  DB Size (main+wal) : ${formatBytes(totalDbSize)}`);
  console.log(`  Index Footprint    : ${storageRatioPct}% of raw file`);

  const throughputPass = throughput >= 10000;
  const memoryPass = rssDeltaMb < 50.0;
  const countPass = pointerCount === targetTurns;

  console.log(`  Throughput Verdict : ${throughputPass ? "PASS ✓" : "FAIL ✗"}`);
  console.log(`  Memory Verdict     : ${memoryPass ? "PASS ✓" : "FAIL ✗"}`);
  console.log(`  Count Verdict      : ${countPass ? "PASS ✓" : "FAIL ✗"}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // Benchmark 3: Pointer Accuracy Verification (50 Random Samples)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n================================================================================");
  console.log("  Benchmark 3: Byte-Offset Pointer Accuracy (50 Random Direct Seeks)");
  console.log("================================================================================");

  const sampleCount = 50;
  // Fetch all pointers
  const allPointers = db
    .query("SELECT * FROM msg_pointers WHERE file_id = ? ORDER BY turn_index ASC")
    .all(syncResult.fileId) as MsgPointer[];

  // Select 50 pseudo-random distributed sample indices
  const sampleIndices = new Set<number>();
  while (sampleIndices.size < sampleCount) {
    const idx = Math.floor(Math.random() * allPointers.length);
    sampleIndices.add(idx);
  }

  console.log(`• Testing ${sampleCount} randomly sampled pointers via direct fs.openSync + fs.readSync...`);
  const fd = openSync(sessionFile, "r");

  let matchCount = 0;
  let jsonParseFailures = 0;
  let coordinateMismatches = 0;

  try {
    for (const idx of Array.from(sampleIndices).sort((a, b) => a - b)) {
      const ptr = allPointers[idx];
      const buffer = Buffer.alloc(ptr.byte_length);

      readSync(fd, new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), 0, ptr.byte_length, ptr.byte_offset);

      // Verify buffer ends with newline
      const lastChar = buffer[buffer.length - 1];
      if (lastChar !== 0x0a) {
        console.error(`  Pointer #${ptr.turn_index}: Does not end with newline! Last byte: 0x${lastChar.toString(16)}`);
        coordinateMismatches++;
        continue;
      }

      // Verify slice parses as valid JSON
      const rawSlice = buffer.toString("utf8");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawSlice.trim());
      } catch (e) {
        console.error(`  Pointer #${ptr.turn_index}: JSON parse failed at offset ${ptr.byte_offset}:`, e);
        jsonParseFailures++;
        continue;
      }

      // Verify content matches the generated line at this turn_index
      const originalLine = lines[ptr.turn_index];
      const expectedObj = JSON.parse(originalLine.trim());

      if (parsed.type !== expectedObj.type) {
        console.error(`  Pointer #${ptr.turn_index}: Type mismatch. Got ${parsed.type}, expected ${expectedObj.type}`);
        coordinateMismatches++;
        continue;
      }

      if (parsed.timestamp !== expectedObj.timestamp) {
        console.error(`  Pointer #${ptr.turn_index}: Timestamp mismatch. Got ${parsed.timestamp}, expected ${expectedObj.timestamp}`);
        coordinateMismatches++;
        continue;
      }

      // Verify exact byte slice matches original file slice
      const originalSlice = Buffer.from(originalLine, "utf8");
      if (Buffer.compare(buffer, originalSlice) !== 0) {
        console.error(`  Pointer #${ptr.turn_index}: Exact byte content mismatch!`);
        coordinateMismatches++;
        continue;
      }

      matchCount++;
    }
  } finally {
    closeSync(fd);
  }

  console.log("\nResults:");
  console.log(`  Sampled Pointers   : ${sampleCount}`);
  console.log(`  Exact Byte Matches : ${matchCount} / ${sampleCount}`);
  console.log(`  JSON Failures      : ${jsonParseFailures}`);
  console.log(`  Coordinate Errors  : ${coordinateMismatches}`);
  const pointerPass = matchCount === sampleCount && jsonParseFailures === 0 && coordinateMismatches === 0;
  console.log(`  Pointer Verdict    : ${pointerPass ? "PASS ✓ (100% Byte-Exact)" : "FAIL ✗"}`);

  closeSearchDb(db);

  return {
    targetTurns,
    elapsedMs,
    throughput,
    rssDeltaMb,
    heapDeltaMb,
    rawFileSize,
    totalDbSize,
    storageRatioPct,
    throughputPass,
    memoryPass,
    countPass,
    matchCount,
    pointerPass,
  };
}

async function main() {
  console.log("################################################################################");
  console.log("#  oas Search Subsystem — Milestone 3 Sync Engine Challenger Benchmark        #");
  console.log("################################################################################");

  const tempDir = join(
    tmpdir(),
    `oas-sync-challenge-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempDir, { recursive: true });

  try {
    const res1 = await benchmarkUnchangedFileSkip(tempDir);
    const res2 = await benchmarkThroughputAndMemory(tempDir);

    console.log("\n================================================================================");
    console.log("  OVERALL MILESTONE 3 BENCHMARK SUMMARY");
    console.log("================================================================================");
    console.log(`• 1. Unchanged Skip  : ${res1.avgTime.toFixed(2)} ms total (${res1.perFileMs.toFixed(4)} ms/file) [Target: <20ms, <0.2ms/file] -> ${res1.pass ? "PASS" : "FAIL"}`);
    console.log(`• 2. Line Throughput : ${res2.throughput.toLocaleString()} lines/sec [Target: >10,000 lines/sec] -> ${res2.throughputPass ? "PASS" : "FAIL"}`);
    console.log(`• 3. Memory Steady   : +${res2.rssDeltaMb.toFixed(2)} MB RSS [Target: <50MB] -> ${res2.memoryPass ? "PASS" : "FAIL"}`);
    console.log(`• 4. Pointer Accuracy: ${res2.matchCount}/50 (100%) direct seeks byte-exact -> ${res2.pointerPass ? "PASS" : "FAIL"}`);

    const overallVerdict = res1.pass && res2.throughputPass && res2.memoryPass && res2.countPass && res2.pointerPass;
    console.log(`\nFINAL VERDICT: ${overallVerdict ? "APPROVE" : "REQUEST_CHANGES"}`);
    console.log("================================================================================\n");
  } finally {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error("Benchmark failed with uncaught exception:", err);
  process.exit(1);
});
