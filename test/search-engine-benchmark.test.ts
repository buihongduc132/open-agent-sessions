/**
 * test/search-engine-benchmark.test.ts
 *
 * Empirical benchmark and performance bounds verification for Milestone 5 (src/search/engine.ts).
 *
 * Requirements & Bounds Verified:
 * 1. Query Latency on 2,000+ indexed turns across multiple session files:
 *    - Single keyword queries: average latency < 10ms.
 *    - Multi-word queries: average latency < 50ms.
 *    - Prefix queries (wildcard *): average latency < 50ms.
 *    - Context window queries (--context 2): average latency < 50ms.
 *    - Global average query execution time < 50ms.
 * 2. Memory Footprint (Process RSS):
 *    - 1,000 consecutive search queries across the indexed corpus.
 *    - Strict memory growth bound: RSS increase < 50MB.
 * 3. BM25 Relevance Ranking:
 *    - Term frequency sensitivity: turns with higher keyword frequency/density rank strictly ahead of lower density turns.
 *    - Multi-keyword coordination: documents matching all query terms rank ahead of partial matches.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { closeSearchDb, initSearchSchema, openSearchDb } from "../src/search/db";
import {
  escapeFts5Query,
  querySearch,
  type SearchQueryResult,
} from "../src/search/engine";
import { syncSessionFile } from "../src/search/sync";

interface BenchmarkStats {
  count: number;
  totalMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
}

function calculateStats(samplesMs: number[]): BenchmarkStats {
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
    minMs,
    maxMs,
    p50Ms,
    p90Ms,
    p95Ms,
    p99Ms,
  };
}

describe(
  "Milestone 5 Empirical Query Engine Benchmarks & Performance Bounds",
  () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;

  const NUM_SESSION_FILES = 10;
  const TURNS_PER_FILE = 250;
  const TOTAL_TURNS = NUM_SESSION_FILES * TURNS_PER_FILE; // 2,500 turns

  const sessionFiles: string[] = [];

  // Vocabulary sets for synthetic turn generation
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

  beforeAll(async () => {
    tempDir = join(
      tmpdir(),
      `oas-engine-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tempDir, { recursive: true });

    dbPath = join(tempDir, "search.sqlite");
    db = openSearchDb({ dbPath });
    initSearchSchema(db);

    console.log(`\n[Benchmark Setup] Generating and indexing ${TOTAL_TURNS} turns across ${NUM_SESSION_FILES} sessions...`);
    const setupStart = performance.now();

    for (let fileIdx = 0; fileIdx < NUM_SESSION_FILES; fileIdx++) {
      const sessionId = `sess-bench-${String(fileIdx).padStart(3, "0")}-${Math.random().toString(36).slice(2, 8)}`;
      const filePath = join(tempDir, `session-${fileIdx}.jsonl`);
      sessionFiles.push(filePath);

      const agent = fileIdx % 2 === 0 ? "pi" : "claude";
      const alias = `project-${fileIdx % 3}`;

      const turns: any[] = [];
      const baseTime = 1725500000000 + fileIdx * 1000000;

      for (let turnIdx = 0; turnIdx < TURNS_PER_FILE; turnIdx++) {
        const topic = TOPICS[(fileIdx + turnIdx) % TOPICS.length];
        const isUser = turnIdx % 2 === 0;

        let content = "";
        if (isUser) {
          content = `User question turn ${turnIdx}: How do we configure ${topic} in production?`;
        } else {
          content = `Assistant response turn ${turnIdx}: To properly configure ${topic}, follow standard operational procedures with automated verification and health checks.`;
        }

        // Add special markers for targeted queries
        if (turnIdx === 42) {
          content += " Crucial canary release configuration with strict rollback safety.";
        }
        if (turnIdx === 100) {
          content += " Critical emergency incident response protocol triggered for cluster failure.";
        }
        if (turnIdx === 200) {
          content += " Distributed synchronization anomaly detected in storage partition quorum.";
        }

        turns.push({
          id: sessionId,
          type: isUser ? "user" : "assistant",
          timestamp: baseTime + turnIdx * 1000,
          content,
        });
      }

      const jsonlData = turns.map((t) => JSON.stringify(t)).join("\n") + "\n";
      writeFileSync(filePath, jsonlData, "utf8");

      await syncSessionFile(db, {
        path: filePath,
        agent,
        alias,
        sessionId,
      });
    }

    const setupDuration = performance.now() - setupStart;
    console.log(`[Benchmark Setup] Successfully indexed ${TOTAL_TURNS} turns in ${setupDuration.toFixed(1)}ms (${(TOTAL_TURNS / (setupDuration / 1000)).toFixed(0)} turns/sec).\n`);
  });

  afterAll(() => {
    closeSearchDb(db);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Benchmark Query Latency Bounds
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Query Latency Bounds (<50ms avg, <10ms for single keyword)", () => {
    test("single-word queries execute in <10ms average latency across 2,000+ turns", async () => {
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
      const ITERATIONS_PER_KEYWORD = 10;

      for (const kw of keywords) {
        for (let i = 0; i < ITERATIONS_PER_KEYWORD; i++) {
          const start = performance.now();
          const result = await querySearch(db, { text: kw, limit: 20 });
          const duration = performance.now() - start;

          expect(result.hits.length).toBeGreaterThan(0);
          latencies.push(duration);
        }
      }

      const stats = calculateStats(latencies);
      console.log(`\n--- Single-Word Query Latency Benchmark ---`);
      console.log(`Samples: ${stats.count}`);
      console.log(`Mean:    ${stats.meanMs.toFixed(3)}ms (Threshold: < 10.000ms)`);
      console.log(`Min:     ${stats.minMs.toFixed(3)}ms`);
      console.log(`P50:     ${stats.p50Ms.toFixed(3)}ms`);
      console.log(`P90:     ${stats.p90Ms.toFixed(3)}ms`);
      console.log(`P95:     ${stats.p95Ms.toFixed(3)}ms`);
      console.log(`P99:     ${stats.p99Ms.toFixed(3)}ms`);
      console.log(`Max:     ${stats.maxMs.toFixed(3)}ms`);

      expect(stats.meanMs).toBeLessThan(10.0);
      expect(stats.p95Ms).toBeLessThan(25.0);
    });

    test("multi-word queries execute in <50ms average latency across 2,000+ turns", async () => {
      const multiWordQueries = [
        "kubernetes cluster deployment",
        "postgresql database backup",
        "authentication authorization oauth2",
        "microservices grpc latency",
        "frontend react typescript",
        "sqlite fts5 ranking",
        "canary release rollback",
        "emergency incident response",
        "distributed synchronization quorum",
      ];

      // Warm-up
      for (const q of multiWordQueries.slice(0, 2)) {
        await querySearch(db, { text: q, limit: 20 });
      }

      const latencies: number[] = [];
      const ITERATIONS = 10;

      for (const q of multiWordQueries) {
        for (let i = 0; i < ITERATIONS; i++) {
          const start = performance.now();
          const result = await querySearch(db, { text: q, limit: 20 });
          const duration = performance.now() - start;

          expect(result.hits.length).toBeGreaterThan(0);
          latencies.push(duration);
        }
      }

      const stats = calculateStats(latencies);
      console.log(`\n--- Multi-Word Query Latency Benchmark ---`);
      console.log(`Samples: ${stats.count}`);
      console.log(`Mean:    ${stats.meanMs.toFixed(3)}ms (Threshold: < 50.000ms)`);
      console.log(`Min:     ${stats.minMs.toFixed(3)}ms`);
      console.log(`P50:     ${stats.p50Ms.toFixed(3)}ms`);
      console.log(`P90:     ${stats.p90Ms.toFixed(3)}ms`);
      console.log(`P95:     ${stats.p95Ms.toFixed(3)}ms`);
      console.log(`P99:     ${stats.p99Ms.toFixed(3)}ms`);
      console.log(`Max:     ${stats.maxMs.toFixed(3)}ms`);

      expect(stats.meanMs).toBeLessThan(50.0);
      expect(stats.p95Ms).toBeLessThan(50.0);
    });

    test("prefix queries execute in <50ms average latency across 2,000+ turns", async () => {
      const prefixQueries = [
        "kuber*",
        "postgre*",
        "auth*",
        "micro*",
        "front*",
        "sql*",
        "prometh*",
        "distrib*",
        "canar*",
        "emerg*",
      ];

      // Warm-up
      for (const q of prefixQueries.slice(0, 2)) {
        await querySearch(db, { text: q, limit: 20 });
      }

      const latencies: number[] = [];
      const ITERATIONS = 10;

      for (const q of prefixQueries) {
        for (let i = 0; i < ITERATIONS; i++) {
          const start = performance.now();
          const result = await querySearch(db, { text: q, limit: 20 });
          const duration = performance.now() - start;

          expect(result.hits.length).toBeGreaterThan(0);
          latencies.push(duration);
        }
      }

      const stats = calculateStats(latencies);
      console.log(`\n--- Prefix Query Latency Benchmark ---`);
      console.log(`Samples: ${stats.count}`);
      console.log(`Mean:    ${stats.meanMs.toFixed(3)}ms (Threshold: < 50.000ms)`);
      console.log(`Min:     ${stats.minMs.toFixed(3)}ms`);
      console.log(`P50:     ${stats.p50Ms.toFixed(3)}ms`);
      console.log(`P90:     ${stats.p90Ms.toFixed(3)}ms`);
      console.log(`P95:     ${stats.p95Ms.toFixed(3)}ms`);
      console.log(`P99:     ${stats.p99Ms.toFixed(3)}ms`);
      console.log(`Max:     ${stats.maxMs.toFixed(3)}ms`);

      expect(stats.meanMs).toBeLessThan(50.0);
      expect(stats.p95Ms).toBeLessThan(50.0);
    });

    test("context window queries (--context 2) execute in <50ms average latency", async () => {
      const contextQueries = [
        "kubernetes",
        "postgresql",
        "authentication",
        "microservices",
        "redis",
        "canary",
        "emergency",
      ];

      // Warm-up
      for (const q of contextQueries.slice(0, 2)) {
        await querySearch(db, { text: q, contextN: 2, limit: 10 });
      }

      const latencies: number[] = [];
      const ITERATIONS = 10;

      for (const q of contextQueries) {
        for (let i = 0; i < ITERATIONS; i++) {
          const start = performance.now();
          const result = await querySearch(db, { text: q, contextN: 2, limit: 10 });
          const duration = performance.now() - start;

          expect(result.hits.length).toBeGreaterThan(0);
          // Verify that context window was actually resolved
          for (const hit of result.hits) {
            expect(hit.context).toBeDefined();
            expect(hit.context?.hitTurn).toBeDefined();
          }
          latencies.push(duration);
        }
      }

      const stats = calculateStats(latencies);
      console.log(`\n--- Context Window Query (--context 2) Latency Benchmark ---`);
      console.log(`Samples: ${stats.count}`);
      console.log(`Mean:    ${stats.meanMs.toFixed(3)}ms (Threshold: < 50.000ms)`);
      console.log(`Min:     ${stats.minMs.toFixed(3)}ms`);
      console.log(`P50:     ${stats.p50Ms.toFixed(3)}ms`);
      console.log(`P90:     ${stats.p90Ms.toFixed(3)}ms`);
      console.log(`P95:     ${stats.p95Ms.toFixed(3)}ms`);
      console.log(`P99:     ${stats.p99Ms.toFixed(3)}ms`);
      console.log(`Max:     ${stats.maxMs.toFixed(3)}ms`);

      expect(stats.meanMs).toBeLessThan(50.0);
      expect(stats.p95Ms).toBeLessThan(50.0);
    });

    test("combined workload achieves <50ms overall average across all query varieties", async () => {
      const testCases = [
        { text: "database", contextN: 0 },
        { text: "cluster ingress helm", contextN: 0 },
        { text: "token*", contextN: 0 },
        { text: "security rbac", contextN: 2 },
        { text: "canary", contextN: 2 },
        { text: "opentelemetry*", contextN: 0 },
      ];

      const allLatencies: number[] = [];
      for (const tc of testCases) {
        for (let i = 0; i < 15; i++) {
          const start = performance.now();
          await querySearch(db, { text: tc.text, contextN: tc.contextN, limit: 15 });
          allLatencies.push(performance.now() - start);
        }
      }

      const stats = calculateStats(allLatencies);
      console.log(`\n--- Combined Workload Latency Benchmark ---`);
      console.log(`Samples: ${stats.count}`);
      console.log(`Mean:    ${stats.meanMs.toFixed(3)}ms (Threshold: < 50.000ms)`);
      console.log(`P50:     ${stats.p50Ms.toFixed(3)}ms`);
      console.log(`P95:     ${stats.p95Ms.toFixed(3)}ms`);

      expect(stats.meanMs).toBeLessThan(50.0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Benchmark Memory Footprint (RSS)
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Memory Footprint (RSS) Bounds (<50MB growth over 1,000 queries)", () => {
    test("running 1,000 consecutive search queries maintains RSS growth strictly < 50MB", async () => {
      // Force GC if available to establish clean baseline
      if (typeof Bun !== "undefined" && typeof (Bun as any).gc === "function") {
        (Bun as any).gc(true);
      }

      const initialMem = process.memoryUsage();
      const initialRssMb = initialMem.rss / (1024 * 1024);
      const initialHeapUsedMb = initialMem.heapUsed / (1024 * 1024);

      const queryPool = [
        { text: "kubernetes", contextN: 0 },
        { text: "postgresql database", contextN: 0 },
        { text: "auth*", contextN: 0 },
        { text: "microservices grpc", contextN: 2 },
        { text: "prometheus alerts", contextN: 0 },
        { text: "distributed consensus raft", contextN: 2 },
        { text: "redis eviction", contextN: 0 },
        { text: "canary release", contextN: 2 },
        { text: "incident response", contextN: 0 },
        { text: "quorum*", contextN: 0 },
      ];

      const TOTAL_CONSECUTIVE_QUERIES = 1000;
      const memCheckpoints: { queryIndex: number; rssMb: number; heapUsedMb: number }[] = [];

      const queryStart = performance.now();

      for (let i = 1; i <= TOTAL_CONSECUTIVE_QUERIES; i++) {
        const q = queryPool[i % queryPool.length];
        const res = await querySearch(db, {
          text: q.text,
          contextN: q.contextN,
          limit: 20,
        });
        expect(res.hits).toBeDefined();

        if (i % 250 === 0 || i === TOTAL_CONSECUTIVE_QUERIES) {
          const curMem = process.memoryUsage();
          memCheckpoints.push({
            queryIndex: i,
            rssMb: curMem.rss / (1024 * 1024),
            heapUsedMb: curMem.heapUsed / (1024 * 1024),
          });
        }
      }

      const queryTotalDuration = performance.now() - queryStart;

      if (typeof Bun !== "undefined" && typeof (Bun as any).gc === "function") {
        (Bun as any).gc(true);
      }

      const finalMem = process.memoryUsage();
      const finalRssMb = finalMem.rss / (1024 * 1024);
      const finalHeapUsedMb = finalMem.heapUsed / (1024 * 1024);

      const rssDeltaMb = finalRssMb - initialRssMb;
      const heapDeltaMb = finalHeapUsedMb - initialHeapUsedMb;

      console.log(`\n--- Memory Footprint (1,000 Consecutive Queries) ---`);
      console.log(`Initial RSS:       ${initialRssMb.toFixed(2)} MB`);
      console.log(`Final RSS:         ${finalRssMb.toFixed(2)} MB`);
      console.log(`RSS Delta:         ${rssDeltaMb.toFixed(2)} MB (Limit: < 50.00 MB)`);
      console.log(`Initial Heap Used: ${initialHeapUsedMb.toFixed(2)} MB`);
      console.log(`Final Heap Used:   ${finalHeapUsedMb.toFixed(2)} MB`);
      console.log(`Heap Delta:        ${heapDeltaMb.toFixed(2)} MB`);
      console.log(`Total 1k Queries Time: ${queryTotalDuration.toFixed(1)}ms (${(queryTotalDuration / 1000).toFixed(2)}ms/query)`);
      console.log(`Checkpoints:`, memCheckpoints);

      expect(rssDeltaMb).toBeLessThan(50.0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Verify BM25 Relevance Ranking
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. BM25 Relevance Ranking Verification", () => {
    test("turns with higher keyword frequency/density rank ahead of lower relevance turns", async () => {
      const bm25SessionPath = join(tempDir, "bm25-relevance-test.jsonl");
      const sessionId = "sess-bm25-relevance-001";

      // Create 4 turns with strictly graded keyword frequency for "telemetry"
      // Turn 0: Background text, 0 mentions
      // Turn 1: Low relevance, 1 mention
      // Turn 2: Medium relevance, 3 mentions
      // Turn 3: High relevance, 8 mentions
      const turns = [
        {
          id: sessionId,
          type: "user",
          timestamp: 1725590000000,
          content: "General overview of the application monitoring and alerting infrastructure.",
        },
        {
          id: sessionId,
          type: "assistant",
          timestamp: 1725590001000,
          content: "Low relevance turn: The service emits telemetry events occasionally to the collector.",
        },
        {
          id: sessionId,
          type: "assistant",
          timestamp: 1725590002000,
          content: "Medium relevance turn: Telemetry pipeline ingests high-volume telemetry data and telemetry spans.",
        },
        {
          id: sessionId,
          type: "assistant",
          timestamp: 1725590003000,
          content: "High relevance turn: Telemetry telemetry telemetry architecture. Comprehensive telemetry ingestion, telemetry export, and telemetry parsing telemetry telemetry.",
        },
      ];

      writeFileSync(
        bm25SessionPath,
        turns.map((t) => JSON.stringify(t)).join("\n") + "\n",
        "utf8"
      );

      await syncSessionFile(db, {
        path: bm25SessionPath,
        agent: "pi",
        alias: "bm25-test",
        sessionId,
      });

      const res = await querySearch(db, {
        text: "telemetry",
        limit: 10,
      });

      expect(res.hits.length).toBe(3);

      // Verify strict ranking order: Turn 3 (high) > Turn 2 (medium) > Turn 1 (low)
      expect(res.hits[0].turnIndex).toBe(3);
      expect(res.hits[1].turnIndex).toBe(2);
      expect(res.hits[2].turnIndex).toBe(1);

      // Verify that SQLite BM25 ranks are strictly monotonic (lower rank value = higher relevance in SQLite FTS5)
      expect(res.hits[0].score).toBeLessThan(res.hits[1].score);
      expect(res.hits[1].score).toBeLessThan(res.hits[2].score);

      console.log("\n--- BM25 Relevance Scores by Frequency ---");
      console.log(`Rank #1 (8x mentions, turnIndex 3): score = ${res.hits[0].score}`);
      console.log(`Rank #2 (3x mentions, turnIndex 2): score = ${res.hits[1].score}`);
      console.log(`Rank #3 (1x mention,  turnIndex 1): score = ${res.hits[2].score}`);
    });

    test("turns matching multiple query terms rank ahead of single-term partial matches", async () => {
      const multiMatchSessionPath = join(tempDir, "bm25-multimatch-test.jsonl");
      const sessionId = "sess-bm25-multimatch-001";

      const turns = [
        {
          id: sessionId,
          type: "assistant",
          timestamp: 1725591000000,
          content: "Partial match turn: We need to ensure that the cryptographic signature validation passes.",
        },
        {
          id: sessionId,
          type: "assistant",
          timestamp: 1725591001000,
          content: "Exact multi-term match turn: Implementing cryptographic zero-knowledge proof verification algorithm.",
        },
      ];

      writeFileSync(
        multiMatchSessionPath,
        turns.map((t) => JSON.stringify(t)).join("\n") + "\n",
        "utf8"
      );

      await syncSessionFile(db, {
        path: multiMatchSessionPath,
        agent: "pi",
        alias: "bm25-multimatch",
        sessionId,
      });

      const res = await querySearch(db, {
        text: "cryptographic zero-knowledge verification",
        limit: 10,
      });

      expect(res.hits.length).toBeGreaterThanOrEqual(1);
      // Turn with all terms must rank first
      expect(res.hits[0].turnIndex).toBe(1);
      console.log(`Multi-match top hit score: ${res.hits[0].score} (turn ${res.hits[0].turnIndex})`);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Extended Adversarial Scaling & Stress Harness
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Extended Adversarial Scaling & Stress Harness", () => {
    test("query matching 1,000+ candidates maintains <10ms latency under default limit (20)", async () => {
      // "production" or "configure" is in every single turn (2,500 candidates)
      const latencies: number[] = [];
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        const res = await querySearch(db, { text: "configure", limit: 20 });
        const duration = performance.now() - start;

        expect(res.totalHits).toBeGreaterThanOrEqual(2000);
        expect(res.hits.length).toBe(20);
        latencies.push(duration);
      }

      const stats = calculateStats(latencies);
      console.log(`\n--- High Candidate Count (2,500 matches, limit 20) Benchmark ---`);
      console.log(`Mean:    ${stats.meanMs.toFixed(3)}ms (Threshold: < 10.000ms)`);
      console.log(`P50:     ${stats.p50Ms.toFixed(3)}ms`);
      console.log(`P95:     ${stats.p95Ms.toFixed(3)}ms`);
      console.log(`Max:     ${stats.maxMs.toFixed(3)}ms`);

      expect(stats.meanMs).toBeLessThan(10.0);
    });

    test("high limit (limit: 200) with 200 direct file seeks executes in <50ms", async () => {
      const latencies: number[] = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        const res = await querySearch(db, { text: "configure", limit: 200 });
        const duration = performance.now() - start;

        expect(res.hits.length).toBe(200);
        for (const hit of res.hits) {
          expect(hit.hitTurn).toBeDefined();
        }
        latencies.push(duration);
      }

      const stats = calculateStats(latencies);
      console.log(`\n--- Large Retrieval Limit (200 file seeks) Benchmark ---`);
      console.log(`Mean:    ${stats.meanMs.toFixed(3)}ms (Threshold: < 50.000ms)`);
      console.log(`P50:     ${stats.p50Ms.toFixed(3)}ms`);
      console.log(`P95:     ${stats.p95Ms.toFixed(3)}ms`);
      console.log(`Max:     ${stats.maxMs.toFixed(3)}ms`);

      expect(stats.meanMs).toBeLessThan(50.0);
    });

    test("deep context window (--context 5) across 50 queries executes in <50ms average", async () => {
      const latencies: number[] = [];
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        const res = await querySearch(db, {
          text: "kubernetes",
          contextN: 5,
          limit: 10,
        });
        const duration = performance.now() - start;

        expect(res.hits.length).toBeGreaterThan(0);
        for (const hit of res.hits) {
          expect(hit.context).toBeDefined();
          expect(hit.context?.before.length).toBeLessThanOrEqual(5);
          expect(hit.context?.after.length).toBeLessThanOrEqual(5);
        }
        latencies.push(duration);
      }

      const stats = calculateStats(latencies);
      console.log(`\n--- Deep Context Window (--context 5) Benchmark ---`);
      console.log(`Mean:    ${stats.meanMs.toFixed(3)}ms (Threshold: < 50.000ms)`);
      console.log(`P50:     ${stats.p50Ms.toFixed(3)}ms`);
      console.log(`P95:     ${stats.p95Ms.toFixed(3)}ms`);

      expect(stats.meanMs).toBeLessThan(50.0);
    });
  });
}, 30000);
