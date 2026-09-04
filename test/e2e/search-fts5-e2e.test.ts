/**
 * test/e2e/search-fts5-e2e.test.ts
 *
 * Comprehensive End-to-End Test Suite, Latency Benchmarks, and Hardening Verification
 * for Milestone 7: Contentless FTS5 Low-Disk Search Engine.
 *
 * Test Specifications & Primary Success Criteria:
 * 1. Primary Success Criterion 1: Zero-duplication disk footprint:
 *    - Generates & indexes 2,000+ realistic turns across multiple session files (Pi, Claude, OpenCode, Codex, Grok).
 *    - Measures total raw JSONL byte size on disk.
 *    - Measures SQLite search database size (statSync(dbPath).size).
 *    - Asserts SQLite database disk footprint is strictly < 3% of raw JSONL file size.
 *
 * 2. Primary Success Criterion 2: Search latency & Memory bounds:
 *    - Executes single-word, multi-word, and prefix BM25 queries across the 2,000+ indexed turns.
 *    - Asserts average query latency is strictly < 50ms (and < 10ms for single keyword).
 *    - Asserts RSS memory growth across 1,000 consecutive queries remains strictly < 50MB.
 *
 * 3. Primary Success Criterion 3: Incremental sync skip latency:
 *    - Calls syncAllSessions on unchanged indexed files.
 *    - Asserts incremental re-index skip time is strictly < 20ms across the corpus.
 *
 * 4. Primary Success Criterion 4: O(1) Random byte-offset seek:
 *    - Asserts readTurnByPointer latency is strictly < 0.05ms (< 50 microseconds) per turn without full file reads.
 *
 * 5. Primary Success Criterion 5: CLI Subprocess E2E execution (bin/oas search):
 *    - Runs child process bin/oas search --text <query> with temporary clean environment.
 *    - Asserts exitCode === 0, output contains message-level hits (timestamp YYYY-MM-DD HH:mm:ss, [agent/alias], 7-char shortId, #turn, snippet).
 *    - Runs child process bin/oas search --text <query> --context 2.
 *    - Asserts visual delimiters (│ [context] and ▶ [hit]) and sequential before/after turns are displayed.
 *    - Runs child process bin/oas search --text <query> --format json.
 *    - Asserts output parses as valid JSON array with contextBefore and contextAfter.
 *
 * 6. Primary Success Criterion 6: Cold CLI Process Latency:
 *    - Measures full child process execution of bin/oas search --text <query>.
 *    - Asserts total invocation time is < 100ms.
 *    - (RED State Note: Fails initially because bin/oas has a top-level static import of React/Ink (runTuiApp) taking ~200ms+. Worker M7 will make it lazy).
 *
 * 7. Primary Success Criterion 7: Demonstration Script Verification:
 *    - Asserts scripts/demo-fts5-search.ts exists and executes successfully with exitCode === 0.
 *    - (RED State Note: Fails initially because scripts/demo-fts5-search.ts is not yet authored).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import type { Database } from "bun:sqlite";

import { openSearchDb, closeSearchDb, initSearchSchema } from "../../src/search/db";
import { syncSessionFile, syncAllSessions, type SyncFileInput } from "../../src/search/sync";
import { readTurnByPointer } from "../../src/search/reader";
import { querySearch } from "../../src/search/engine";
import type { MsgPointer } from "../../src/search/types";

// ============================================================================
// Types & Subprocess Utilities
// ============================================================================

interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runSubprocess(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {}
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const cwd = options.cwd ?? join(__dirname, "..", "..");
    const start = performance.now();
    const proc = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + `\n[timeout after ${options.timeoutMs ?? 15000}ms]`,
          durationMs: performance.now() - start,
        });
      }
    }, options.timeoutMs ?? 15000);

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
          durationMs: performance.now() - start,
        });
      }
    });
    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message,
          durationMs: performance.now() - start,
        });
      }
    });
  });
}

function runCli(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {}
): Promise<SubprocessResult> {
  const cwd = options.cwd ?? join(__dirname, "..", "..");
  const cliPath = join(cwd, "bin", "oas");
  return runSubprocess("bun", [cliPath, ...args], options);
}

// ============================================================================
// Test Suite Setup: Multi-Provider 2,500-Turn Corpus Generation
// ============================================================================

describe("Milestone 7: End-to-End Search Engine, Latency Bounds & Hardening", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let sessionFiles: string[] = [];
  let syncInputs: SyncFileInput[] = [];
  let testEnv: Record<string, string>;
  let totalRawJsonlBytes = 0;
  let totalTurnsIndexed = 0;

  const TOPICS = [
    "kubernetes cluster orchestration deployment helm ingress service pod container",
    "postgresql database replication backup migration schema partition index query",
    "authentication authorization oauth2 jwt session cookie token security rbac",
    "microservices grpc protobuf envoy gateway latency throughput tracing metrics",
    "frontend react typescript vite tailwind state redux zustand virtualized",
    "fulltext fts5 sqlite bm25 indexing tokenizer contentless search ranking",
    "continuous integration github actions workflow runner build test lint artifact",
    "observability prometheus grafana opentelemetry jaeger distributed logging alerts",
    "caching redis memcached eviction ttl lru write-through invalidation cluster",
    "distributed consensus raft paxos leader election etcd zookeeper quorum",
  ];

  // Specific canonical sessions for 5 providers
  const PROVIDER_CONFIGS = [
    { agent: "pi", alias: "default", sessionId: "01a05951-382a-4318-8f81-5421d0199e1a", shortId: "01a0595" },
    { agent: "claude", alias: "work", sessionId: "7f9b1c22-9481-4231-901a-83b271a06412", shortId: "7f9b1c2" },
    { agent: "opencode", alias: "personal", sessionId: "b8c7d6e3-1234-5678-9abc-def012345678", shortId: "b8c7d6e" },
    { agent: "codex", alias: "default", sessionId: "e4d3c2b4-5678-9abc-def0-123456789abc", shortId: "e4d3c2b" },
    { agent: "grok", alias: "research", sessionId: "2a3b4c55-6e7f-8a9b-0c1d-2e3f4a5b6c7d", shortId: "2a3b4c5" },
  ];

  const TURNS_PER_PROVIDER = 500; // 5 providers * 500 = 2,500 turns total

  beforeAll(async () => {
    tempDir = join(
      tmpdir(),
      `oas-fts5-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tempDir, { recursive: true });

    const oasDir = join(tempDir, "oas");
    mkdirSync(oasDir, { recursive: true });
    dbPath = join(oasDir, "search.sqlite");

    db = openSearchDb({ dbPath });
    initSearchSchema(db);

    const sessionsDir = join(tempDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    console.log(`\n[E2E Setup] Synthesizing ${TURNS_PER_PROVIDER * PROVIDER_CONFIGS.length} realistic turns across 5 providers...`);
    const setupStart = performance.now();

    for (let pIdx = 0; pIdx < PROVIDER_CONFIGS.length; pIdx++) {
      const cfg = PROVIDER_CONFIGS[pIdx];
      const filePath = join(sessionsDir, `${cfg.agent}-session.jsonl`);
      sessionFiles.push(filePath);
      syncInputs.push({
        path: filePath,
        agent: cfg.agent,
        alias: cfg.alias,
        sessionId: cfg.sessionId,
      });

      const lines: string[] = [];
      const baseTimestamp = 1704067200000 + pIdx * 86400000;

      for (let turnIdx = 0; turnIdx < TURNS_PER_PROVIDER; turnIdx++) {
        const topic = TOPICS[(pIdx * 100 + turnIdx) % TOPICS.length];
        const isUser = turnIdx % 2 === 0;
        const turnTs = baseTimestamp + turnIdx * 1000;

        let turnObj: any;

        // Provider 1: Pi / OMP format
        if (cfg.agent === "pi") {
          let userPrompt = `User request turn #${turnIdx}: Please configure ${topic} with automated validation.`;
          if (turnIdx === 100) {
            userPrompt += " Critical emergency incident response protocol triggered for cluster failure.";
          }
          turnObj = {
            type: "message",
            id: `pi-msg-${turnIdx}`,
            timestamp: turnTs,
            message: {
              role: isUser ? "user" : "assistant",
              content: isUser
                ? [{ type: "text", text: userPrompt }]
                : [
                    { type: "reasoning", text: `Analyzing operational telemetry and cluster state for ${topic}.` },
                    { type: "text", text: `Assistant advice turn #${turnIdx}: Executing health-check automated configuration for ${topic}.` },
                    { type: "tool", tool: "bash", state: { command: `deploy-service --topic ${topic} --turn ${turnIdx}` } },
                  ],
            },
            // Realistic bulk stdout/stderr dumps omitted by selective extractor
            tool_result: "Detailed container cluster execution output log dump: ".repeat(300),
            debug_meta: "Metadata payload buffer with trace spans and events: ".repeat(100),
          };
        }
        // Provider 2: Claude format
        else if (cfg.agent === "claude") {
          let userPrompt = `Claude question turn #${turnIdx}: How do we optimize ${topic} in production?`;
          if (turnIdx === 42) {
            userPrompt += " Crucial canary release configuration with strict rollback safety.";
          }
          turnObj = {
            type: isUser ? "user" : "assistant",
            id: `claude-msg-${turnIdx}`,
            timestamp: turnTs,
            content: isUser
              ? [{ type: "text", text: userPrompt }]
              : [
                  { type: "thinking", thinking: `Assessing concurrency bottlenecks and index selectivity for ${topic}.` },
                  { type: "text", text: `Claude assistant recommendation #${turnIdx}: Apply partitioned query plans and connection pooling for ${topic}.` },
                  { type: "tool_use", name: "edit", input: { path: `/etc/system/${topic}.conf`, content: `enabled: true\nstep: ${turnIdx}` } },
                ],
            tool_result: "Raw file content inspection buffer with syntax tree diff: ".repeat(300),
            context_cache: "Context cache token state vector: ".repeat(100),
          };
        }
        // Provider 3: OpenCode format
        else if (cfg.agent === "opencode") {
          let prompt = isUser
            ? `OpenCode prompt turn #${turnIdx}: Implement security policies for ${topic}.`
            : `OpenCode assistant turn #${turnIdx}: Applied RBAC roles and token inspection for ${topic}.`;
          if (turnIdx === 200) {
            prompt += " Distributed synchronization anomaly detected in storage partition quorum.";
          }
          turnObj = {
            id: `oc-msg-${turnIdx}`,
            sessionID: cfg.sessionId,
            timeCreated: turnTs,
            role: isUser ? "user" : "assistant",
            content: prompt,
            tool_calls: isUser
              ? undefined
              : [{ name: "run_command", arguments: { command: `apply-policy --target ${topic} --id ${turnIdx}` } }],
            build_output: "Compiler diagnostics and linker debug output stream: ".repeat(300),
          };
        }
        // Provider 4: Codex format
        else if (cfg.agent === "codex") {
          let text = `Codex turn #${turnIdx}: Managing ${topic} infrastructure deployment.`;
          if (turnIdx === 300) {
            text += " Postgresql database replication backup migration schema partition index query optimization.";
          }
          turnObj = {
            type: "response_item",
            timestamp: turnTs,
            payload: {
              role: isUser ? "user" : "assistant",
              content: [{ type: isUser ? "input_text" : "output_text", text }],
            },
            event_stream: "Raw Codex SSE frame buffer dump with token probabilities: ".repeat(300),
          };
        }
        // Provider 5: Grok format
        else {
          let text = isUser
            ? `Grok prompt turn #${turnIdx}: Investigate distributed consensus in ${topic}.`
            : `Grok response turn #${turnIdx}: Verified Raft leader election and quorum health for ${topic}.`;
          if (turnIdx === 400) {
            text += " Microservices grpc protobuf envoy gateway latency throughput tracing metrics.";
          }
          turnObj = {
            role: isUser ? "user" : "assistant",
            content: text,
            tool_calls: isUser
              ? undefined
              : [{ name: "grep_search", arguments: { query: topic, path: `/src/${topic}/` } }],
            summary: [{ text: `Consensus protocol analysis for ${topic}` }],
            network_trace: "Full TCP packet hex dump and HTTP proxy exchange trace: ".repeat(300),
          };
        }

        lines.push(JSON.stringify(turnObj) + "\n");
      }

      const jsonlData = lines.join("");
      writeFileSync(filePath, jsonlData, "utf8");
      totalRawJsonlBytes += statSync(filePath).size;

      const syncRes = await syncSessionFile(db, syncInputs[pIdx]);
      totalTurnsIndexed += syncRes.indexedTurns;
    }

    // Force SQLite WAL checkpoint to ensure all indexed pages are flushed to search.sqlite
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");

    const setupDuration = performance.now() - setupStart;
    console.log(`[E2E Setup] Indexed ${totalTurnsIndexed} turns across 5 providers in ${setupDuration.toFixed(1)}ms. Total Raw JSONL: ${(totalRawJsonlBytes / (1024 * 1024)).toFixed(2)}MB.\n`);

    // Prepare clean temporary configuration environment for subprocess CLI tests
    const configDir = join(tempDir, ".config", "oas");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.yaml");
    const yamlConfig = `
agents:
  - agent: pi
    alias: default
    enabled: true
  - agent: claude
    alias: work
    enabled: true
  - agent: opencode
    alias: personal
    enabled: true
  - agent: codex
    alias: default
    enabled: true
  - agent: grok
    alias: research
    enabled: true
`;
    writeFileSync(configPath, yamlConfig, "utf8");

    testEnv = {
      XDG_CACHE_HOME: tempDir,
      HOME: tempDir,
      OAS_CONFIG_PATH: configPath,
    };
  });

  afterAll(() => {
    closeSearchDb(db);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // Primary Success Criterion 1: Zero-Duplication Disk Footprint (< 3%)
  // ==========================================================================
  describe("Primary Success Criterion 1: Zero-duplication disk footprint", () => {
    test("indexes 2,000+ realistic turns across 5 providers (Pi, Claude, OpenCode, Codex, Grok)", () => {
      expect(totalTurnsIndexed).toBeGreaterThanOrEqual(2000);
      expect(sessionFiles.length).toBe(5);

      const pointerCount = (db.query("SELECT COUNT(*) as count FROM msg_pointers").get() as { count: number }).count;
      expect(pointerCount).toBe(totalTurnsIndexed);
    });

    test("SQLite database disk footprint is strictly < 3% of raw JSONL file size", () => {
      const dbSizeBytes = statSync(dbPath).size;
      expect(dbSizeBytes).toBeGreaterThan(0);
      expect(totalRawJsonlBytes).toBeGreaterThan(10 * 1024 * 1024); // at least 10MB+ raw data

      const diskFootprintRatio = (dbSizeBytes / totalRawJsonlBytes) * 100;

      console.log(`\n--- Disk Footprint Ratio ---`);
      console.log(`Raw JSONL Size:    ${(totalRawJsonlBytes / (1024 * 1024)).toFixed(2)} MB (${totalRawJsonlBytes.toLocaleString()} bytes)`);
      console.log(`SQLite DB Size:    ${(dbSizeBytes / 1024).toFixed(2)} KB (${dbSizeBytes.toLocaleString()} bytes)`);
      console.log(`Footprint Ratio:   ${diskFootprintRatio.toFixed(2)}% (Upper Bound: < 3.00%)`);

      expect(diskFootprintRatio).toBeLessThan(3.0);
    });
  });

  // ==========================================================================
  // Primary Success Criterion 2: Search Latency & Memory Bounds
  // ==========================================================================
  describe("Primary Success Criterion 2: Search latency & Memory bounds", () => {
    test("single keyword queries execute with average latency < 10ms across 2,000+ turns", async () => {
      const keywords = [
        "kubernetes",
        "postgresql",
        "authentication",
        "microservices",
        "frontend",
        "sqlite",
        "prometheus",
        "redis",
        "distributed",
        "canary",
        "emergency",
        "quorum",
      ];

      // Warm-up
      for (const kw of keywords.slice(0, 3)) {
        await querySearch(db, { text: kw, limit: 20 });
      }

      const latencies: number[] = [];
      const ITERATIONS = 10;

      for (const kw of keywords) {
        for (let i = 0; i < ITERATIONS; i++) {
          const t0 = performance.now();
          const res = await querySearch(db, { text: kw, limit: 20 });
          const duration = performance.now() - t0;
          expect(res.hits.length).toBeGreaterThan(0);
          latencies.push(duration);
        }
      }

      const meanMs = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;
      console.log(`\n[Single Keyword Latency] Mean: ${meanMs.toFixed(3)}ms across ${latencies.length} samples (Threshold: < 10.0ms)`);
      expect(meanMs).toBeLessThan(10.0);
    });

    test("multi-word and prefix BM25 queries execute with average latency < 50ms across 2,000+ turns", async () => {
      const queries = [
        "kubernetes cluster deployment",
        "postgresql database replication",
        "authentication oauth2 token",
        "microservices grpc envoy",
        "fulltext fts5 sqlite bm25",
        "kuber*",
        "postgre*",
        "auth*",
        "micro*",
        "sql*",
        "prometh*",
        "distrib*",
      ];

      // Warm-up
      for (const q of queries.slice(0, 2)) {
        await querySearch(db, { text: q, limit: 20 });
      }

      const latencies: number[] = [];
      const ITERATIONS = 10;

      for (const q of queries) {
        for (let i = 0; i < ITERATIONS; i++) {
          const t0 = performance.now();
          const res = await querySearch(db, { text: q, limit: 20 });
          const duration = performance.now() - t0;
          expect(res.hits.length).toBeGreaterThan(0);
          latencies.push(duration);
        }
      }

      const meanMs = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;
      console.log(`\n[Multi-Word & Prefix Latency] Mean: ${meanMs.toFixed(3)}ms across ${latencies.length} samples (Threshold: < 50.0ms)`);
      expect(meanMs).toBeLessThan(50.0);
    });

    test("RSS memory growth across 1,000 consecutive queries remains strictly < 50MB", async () => {
      if (typeof Bun !== "undefined" && typeof (Bun as any).gc === "function") {
        (Bun as any).gc(true);
      }

      const initialRssMb = process.memoryUsage().rss / (1024 * 1024);

      const queryPool = [
        { text: "kubernetes", contextN: 0 },
        { text: "postgresql database", contextN: 0 },
        { text: "auth*", contextN: 0 },
        { text: "microservices grpc", contextN: 2 },
        { text: "prometheus alerts", contextN: 0 },
        { text: "distributed consensus raft", contextN: 2 },
        { text: "redis eviction", contextN: 0 },
        { text: "canary release", contextN: 2 },
        { text: "emergency incident", contextN: 0 },
        { text: "quorum*", contextN: 0 },
      ];

      const TOTAL_QUERIES = 1000;
      for (let i = 0; i < TOTAL_QUERIES; i++) {
        const item = queryPool[i % queryPool.length];
        const res = await querySearch(db, {
          text: item.text,
          contextN: item.contextN,
          limit: 20,
        });
        expect(res.hits).toBeDefined();
      }

      if (typeof Bun !== "undefined" && typeof (Bun as any).gc === "function") {
        (Bun as any).gc(true);
      }

      const finalRssMb = process.memoryUsage().rss / (1024 * 1024);
      const rssDeltaMb = finalRssMb - initialRssMb;

      console.log(`\n[RSS Memory Bounds] Initial: ${initialRssMb.toFixed(2)} MB, Final: ${finalRssMb.toFixed(2)} MB, Delta: ${rssDeltaMb.toFixed(2)} MB (Threshold: < 50.0MB)`);
      expect(rssDeltaMb).toBeLessThan(50.0);
    });
  });

  // ==========================================================================
  // Primary Success Criterion 3: Incremental Sync Skip Latency (< 20ms)
  // ==========================================================================
  describe("Primary Success Criterion 3: Incremental sync skip latency", () => {
    test("syncAllSessions on unchanged indexed files skips in strictly < 20ms", async () => {
      // Warm-up call
      await syncAllSessions(db, syncInputs);

      const t0 = performance.now();
      const skipSummary = await syncAllSessions(db, syncInputs);
      const elapsedMs = performance.now() - t0;

      console.log(`\n[Incremental Sync Skip] Skipped ${skipSummary.totalFiles} files in ${elapsedMs.toFixed(3)}ms (Threshold: < 20.0ms)`);

      expect(skipSummary.totalFiles).toBe(syncInputs.length);
      expect(skipSummary.updatedFiles).toBe(0);
      expect(skipSummary.totalTurns).toBe(0);
      expect(elapsedMs).toBeLessThan(20.0);
    });
  });

  // ==========================================================================
  // Primary Success Criterion 4: O(1) Random Byte-Offset Seek (< 0.05ms)
  // ==========================================================================
  describe("Primary Success Criterion 4: O(1) Random byte-offset seek", () => {
    test("readTurnByPointer latency is strictly < 0.05ms (< 50 microseconds) per turn without reading full files", () => {
      const allPointers = db
        .query("SELECT * FROM msg_pointers ORDER BY file_id, turn_index")
        .all() as MsgPointer[];
      expect(allPointers.length).toBe(totalTurnsIndexed);

      const watermarks = db
        .query("SELECT file_id, path FROM file_watermarks")
        .all() as { file_id: number; path: string }[];
      const fileMap = new Map<number, string>();
      for (const w of watermarks) {
        fileMap.set(w.file_id, w.path);
      }

      // Warm-up seeks
      for (let i = 0; i < 50; i++) {
        const ptr = allPointers[i];
        readTurnByPointer(fileMap.get(ptr.file_id)!, ptr);
      }

      const SEEK_COUNT = 1000;
      const latencies: number[] = new Array(SEEK_COUNT);

      for (let i = 0; i < SEEK_COUNT; i++) {
        const randIdx = Math.floor(Math.random() * allPointers.length);
        const ptr = allPointers[randIdx];
        const filePath = fileMap.get(ptr.file_id)!;

        const t0 = performance.now();
        const turn = readTurnByPointer(filePath, ptr);
        const duration = performance.now() - t0;

        expect(turn).toBeDefined();
        latencies[i] = duration;
      }

      const meanMs = latencies.reduce((sum, v) => sum + v, 0) / SEEK_COUNT;
      const meanUs = meanMs * 1000;

      console.log(`\n[O(1) Seek Benchmark] Mean: ${meanMs.toFixed(5)}ms (${meanUs.toFixed(2)} µs) across ${SEEK_COUNT} random seeks (Threshold: < 0.05ms / 50µs)`);
      expect(meanMs).toBeLessThan(0.05);
    });
  });

  // ==========================================================================
  // Primary Success Criterion 5: CLI Subprocess E2E Execution (bin/oas search)
  // ==========================================================================
  describe("Primary Success Criterion 5: CLI Subprocess E2E execution (bin/oas search)", () => {
    test("runs `bin/oas search --text <query>` and outputs message-level hits (timestamp, [agent/alias], 7-char shortId, #turn, snippet)", async () => {
      const res = await runCli(["search", "--text", "canary", "--no-sync", "--no-color"], {
        env: testEnv,
      });

      expect(res.exitCode).toBe(0);
      // Verify message-level output format: timestamp YYYY-MM-DD HH:mm:ss
      expect(res.stdout).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      // Agent and alias tag
      expect(res.stdout).toContain("[claude/work]");
      // 7-character shortId
      expect(res.stdout).toContain("7f9b1c2");
      // Turn index #42
      expect(res.stdout).toContain("#42");
      // Snippet content
      expect(res.stdout).toContain("canary");
      expect(res.stdout).toContain("rollback safety");
    });

    test("runs `bin/oas search --text <query> --context 2` and displays visual delimiters and sequential before/after turns", async () => {
      const res = await runCli(["search", "--text", "canary", "--context", "2", "--no-sync", "--no-color"], {
        env: testEnv,
      });

      expect(res.exitCode).toBe(0);
      // Visual delimiters
      expect(res.stdout).toContain("│ [context]");
      expect(res.stdout).toContain("▶ [hit]");
      // Surrounding turn indices
      expect(res.stdout).toContain("#40");
      expect(res.stdout).toContain("#41");
      expect(res.stdout).toContain("#42");
      expect(res.stdout).toContain("#43");
      expect(res.stdout).toContain("#44");
    });

    test("runs `bin/oas search --text <query> --format json` and outputs valid JSON with contextBefore and contextAfter", async () => {
      const res = await runCli(["search", "--text", "canary", "--context", "2", "--format", "json", "--no-sync"], {
        env: testEnv,
      });

      expect(res.exitCode).toBe(0);
      let parsed: any[];
      expect(() => {
        parsed = JSON.parse(res.stdout);
      }).not.toThrow();

      expect(Array.isArray(parsed!)).toBe(true);
      expect(parsed!.length).toBeGreaterThan(0);

      const hit = parsed![0];
      expect(hit.shortId).toBe("7f9b1c2");
      expect(hit.agent).toBe("claude");
      expect(hit.alias).toBe("work");
      expect(hit.turnIndex).toBe(42);

      expect(Array.isArray(hit.contextBefore)).toBe(true);
      expect(hit.contextBefore.length).toBe(2);
      expect(hit.contextBefore[0].turnIndex).toBe(40);
      expect(hit.contextBefore[1].turnIndex).toBe(41);

      expect(Array.isArray(hit.contextAfter)).toBe(true);
      expect(hit.contextAfter.length).toBe(2);
      expect(hit.contextAfter[0].turnIndex).toBe(43);
      expect(hit.contextAfter[1].turnIndex).toBe(44);
    });
  });

  // ==========================================================================
  // Primary Success Criterion 6: Cold CLI Process Latency (< 100ms)
  // ==========================================================================
  describe("Primary Success Criterion 6: Cold CLI Process Latency", () => {
    test("measures cold CLI child process invocation of `bin/oas search --text <query>` and asserts total time is < 100ms", async () => {
      // Note for RED state: bin/oas currently imports runTuiApp (React/Ink) statically at top-level,
      // which takes ~200-380ms on cold invocation. In GREEN phase, worker_m7 will lazily import runTuiApp.
      const start = performance.now();
      const res = await runCli(["search", "--text", "canary", "--no-sync", "--no-color"], {
        env: testEnv,
      });
      const durationMs = performance.now() - start;

      console.log(`\n[Cold CLI Process Latency] Invocation duration: ${durationMs.toFixed(2)}ms (Threshold: < 100.0ms)`);

      expect(res.exitCode).toBe(0);
      expect(durationMs).toBeLessThan(100.0);
    });
  });

  // ==========================================================================
  // Primary Success Criterion 7: Demonstration Script Verification
  // ==========================================================================
  describe("Primary Success Criterion 7: Demonstration Script Verification", () => {
    test("asserts that `scripts/demo-fts5-search.ts` exists and executes successfully with exitCode === 0", async () => {
      const repoRoot = join(__dirname, "..", "..");
      const demoScriptPath = join(repoRoot, "scripts", "demo-fts5-search.ts");

      // Verify file existence
      expect(existsSync(demoScriptPath)).toBe(true);

      // Execute demonstration script end-to-end
      const res = await runSubprocess("bun", [demoScriptPath], {
        cwd: repoRoot,
        timeoutMs: 15000,
      });

      console.log(`\n[Demo Script Execution] Exit Code: ${res.exitCode}, Duration: ${res.durationMs.toFixed(2)}ms`);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("oas search");
    });
  });
});
