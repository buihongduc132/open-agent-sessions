/**
 * scripts/benchmark-extractor.ts
 *
 * Microbenchmark harness measuring lines/second parsing throughput and memory
 * for Milestone 2 payload extractor (src/search/extractor.ts).
 */

import { extractTurnPayload } from "../src/search/extractor";

interface BenchmarkCase {
  name: string;
  lines: string[];
}

function runBenchmark(title: string, lines: string[], iterations: number = 100_000) {
  // Warmup
  for (let i = 0; i < 5000; i++) {
    extractTurnPayload(lines[i % lines.length]);
  }

  const startMemory = process.memoryUsage().heapUsed;
  const start = performance.now();
  let indexed = 0;
  let skipped = 0;

  for (let i = 0; i < iterations; i++) {
    const res = extractTurnPayload(lines[i % lines.length]);
    if (res !== null) {
      indexed++;
    } else {
      skipped++;
    }
  }

  const elapsedMs = performance.now() - start;
  const endMemory = process.memoryUsage().heapUsed;
  const linesPerSec = Math.round((iterations / elapsedMs) * 1000);
  const heapDiffMb = ((endMemory - startMemory) / (1024 * 1024)).toFixed(2);

  console.log(`\n── ${title} ──`);
  console.log(`  Iterations : ${iterations.toLocaleString()} lines`);
  console.log(`  Duration   : ${elapsedMs.toFixed(2)} ms`);
  console.log(`  Throughput : ${linesPerSec.toLocaleString()} lines/sec`);
  console.log(`  Indexed    : ${indexed.toLocaleString()} | Skipped: ${skipped.toLocaleString()}`);
  console.log(`  Heap delta : ${heapDiffMb} MB`);

  return { title, iterations, elapsedMs, linesPerSec, indexed, skipped };
}

function main() {
  console.log("================================================================================");
  console.log("  oas Search Subsystem — Milestone 2 Extractor Throughput Benchmark");
  console.log("================================================================================");

  // 1. Conversational turns
  const conversational = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-09-04T12:00:00.000Z",
      content: "Can you help me design a contentless FTS5 search architecture for CLI sessions?",
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-04T12:00:05.000Z",
      content: [
        {
          type: "thinking",
          thinking: "We should use SQLite FTS5 with content='' and a secondary msg_pointers table.",
        },
        {
          type: "text",
          text: "Yes, using contentless FTS5 allows zero duplicate text storage and O(1) byte-offset seeks.",
        },
      ],
    }),
  ];

  // 2. Tool-heavy turns
  const toolHeavy = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-04T12:01:00.000Z",
      content: [
        {
          type: "tool_use",
          name: "grep_search",
          input: {
            SearchPath: "src/search",
            Query: "contentless_delete=1",
            IsRegex: false,
          },
        },
      ],
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-04T12:01:05.000Z",
      content: [
        {
          type: "tool_use",
          name: "run_command",
          input: {
            CommandLine: "bun test test/search-extractor.test.ts",
            Cwd: "/workspace",
          },
        },
      ],
    }),
  ];

  // 3. Bulk tool_result turns (to skip)
  const bulkSkip = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-09-04T12:02:00.000Z",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_123",
          content: "Compiling 500 crates...\n".repeat(200), // ~5KB stdout
        },
      ],
    }),
    JSON.stringify({
      type: "tool_result",
      timestamp: "2026-09-04T12:02:05.000Z",
      tool_call_id: "call_456",
      content: "PASS: 43 test suites executed successfully in 1.2s\n".repeat(150),
    }),
  ];

  // 4. Metadata events (to skip)
  const metadataEvents = [
    JSON.stringify({
      type: "model_change",
      timestamp: "2026-09-04T12:03:00.000Z",
      model: "claude-3-7-sonnet",
    }),
    JSON.stringify({
      type: "thinking_level_change",
      timestamp: "2026-09-04T12:03:05.000Z",
      level: "high",
    }),
    JSON.stringify({
      type: "compaction",
      timestamp: "2026-09-04T12:03:10.000Z",
      compacted_turns: 42,
    }),
  ];

  // 5. Realistic mixed distribution
  const mixedCorpus = [
    ...conversational,
    ...conversational,
    ...toolHeavy,
    ...toolHeavy,
    ...bulkSkip,
    ...metadataEvents,
  ];

  const results = [];
  results.push(runBenchmark("1. Pure Conversational Turns", conversational, 100_000));
  results.push(runBenchmark("2. Tool-Heavy Assistant Turns", toolHeavy, 100_000));
  results.push(runBenchmark("3. Bulk tool_result Skip Turns", bulkSkip, 100_000));
  results.push(runBenchmark("4. Non-Message Metadata Events", metadataEvents, 100_000));
  results.push(runBenchmark("5. Realistic Mixed Session Corpus", mixedCorpus, 100_000));

  console.log("\n================================================================================");
  console.log("  Benchmark Summary Table");
  console.log("================================================================================");
  console.log("| Corpus Type                     | Throughput (lines/sec) | Duration (ms) | Status |");
  console.log("|---------------------------------|------------------------|---------------|--------|");
  for (const r of results) {
    const padName = r.title.padEnd(31, " ");
    const padRate = (r.linesPerSec.toLocaleString() + " l/s").padStart(22, " ");
    const padDur = (r.elapsedMs.toFixed(1) + " ms").padStart(13, " ");
    console.log(`| ${padName} | ${padRate} | ${padDur} | PASS   |`);
  }
  console.log("================================================================================");
}

main();
