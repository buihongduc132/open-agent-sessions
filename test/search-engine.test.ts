/**
 * test/search-engine.test.ts
 *
 * Comprehensive test suite for Milestone 5 (Search Query Engine & Integration: Tasks 18-22):
 * - Task 18 (query-fts-bm25): BM25 keyword matching, ranking, sub-10ms performance, empty/no-match handling, FTS5 escaping.
 * - Task 19 (query-pointer-join): FTS5 rowid join with msg_pointers and file_watermarks, direct seek hitTurn via readTurnByPointer.
 * - Task 20 (query-agent-scope): Agent and alias filtering via SQL constraints on file_watermarks.
 * - Task 21 (query-memory-cap & limit): Result capping, default limit (20), bounded memory under high candidate counts.
 * - Task 22 (defer-vec-safe-fallback): Graceful fallback to FTS5 BM25 when vector/sqlite-vec extension is absent.
 * - Context Window (context / contextN): Fetching adjacent before/after turns via readTurnContext.
 * - Index Barrel Export: Verification of public API re-exports from src/search/index.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

// Imports from Milestone 5 modules (engine and barrel export)
import {
  querySearch,
  escapeFts5Query,
  type SearchQueryResult,
  type SearchEngineHit,
} from "../src/search/engine";
import {
  initSearchDb,
  getDbPath,
  extractTurnPayload,
  syncFileWatermarks,
  syncAllSessions,
  readTurnByPointer,
  readTurnContext,
  querySearch as indexQuerySearch,
  openSearchDb as indexOpenSearchDb,
  closeSearchDb as indexCloseSearchDb,
  initSearchSchema as indexInitSearchSchema,
  syncSessionFile as indexSyncSessionFile,
} from "../src/search/index";

// Foundation imports from M1-M4
import {
  closeSearchDb,
  getSearchDbPath,
  initSearchSchema,
  openSearchDb,
} from "../src/search/db";
import {
  syncAllSessions as syncEngineAllSessions,
  syncFileWatermarks as syncEngineFileWatermarks,
  syncSessionFile,
  type SyncFileInput,
  type SyncFileResult,
  type SyncSummary,
} from "../src/search/sync";
import {
  readTurnByPointer as readerReadTurnByPointer,
  readTurnContext as readerReadTurnContext,
  type ContextWindowResult,
  type RawTurnRecord,
} from "../src/search/reader";
import type {
  ExtractedTurnPayload,
  FileWatermark,
  MsgPointer,
  SearchDbOptions,
  SearchHit,
  SearchQueryOptions,
} from "../src/search/types";

describe("Search Query Engine & Subsystem Integration (Milestone 5: Tasks 18-22)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `oas-search-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

  // Helper to write a JSONL session file with structured turn lines
  function writeJsonlFile(filePath: string, turns: any[]): void {
    const content = turns.map((t) => JSON.stringify(t)).join("\n") + "\n";
    writeFileSync(filePath, content, "utf8");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Task 18: query-fts-bm25 (FTS5 BM25 Ranking, Execution, & Escaping)
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Task 18: query-fts-bm25", () => {
    test("runs keyword queries against indexed conversational content", async () => {
      const sessionPath = join(tempDir, "auth-session.jsonl");
      writeJsonlFile(sessionPath, [
        {
          id: "sess-auth-001",
          type: "user",
          timestamp: 1725500001000,
          content: "How do I configure OAuth2 authentication for our API?",
        },
        {
          id: "sess-auth-001",
          type: "assistant",
          timestamp: 1725500002000,
          content: "You should add the OAuth2 authentication middleware in your server route definitions.",
        },
      ]);

      await syncSessionFile(db, {
        path: sessionPath,
        agent: "pi",
        alias: "work",
        sessionId: "sess-auth-001",
      });

      const res = await querySearch(db, { text: "authentication" });

      expect(res).toBeDefined();
      expect(res.query).toBe("authentication");
      expect(res.totalHits).toBeGreaterThanOrEqual(2);
      expect(res.hits.length).toBeGreaterThanOrEqual(2);
      expect(res.executionTimeMs).toBeGreaterThanOrEqual(0);

      const firstHit = res.hits[0];
      expect(firstHit.sessionId).toBe("sess-auth-001");
      expect(firstHit.agent).toBe("pi");
      expect(firstHit.alias).toBe("work");
    });

    test("runs multi-word and prefix queries (e.g. 'deploy pipeline', 'auth*')", async () => {
      const sessionPath = join(tempDir, "deploy-session.jsonl");
      writeJsonlFile(sessionPath, [
        {
          id: "sess-dep-001",
          type: "user",
          timestamp: 1725500010000,
          content: "Trigger the deploy pipeline to staging now.",
        },
        {
          id: "sess-dep-001",
          type: "assistant",
          timestamp: 1725500011000,
          content: "The deploy pipeline has successfully deployed commit 9f8a32b.",
        },
        {
          id: "sess-dep-001",
          type: "user",
          timestamp: 1725500012000,
          content: "Check authorization status.",
        },
      ]);

      await syncSessionFile(db, {
        path: sessionPath,
        agent: "claude",
        alias: "prod",
        sessionId: "sess-dep-001",
      });

      // Multi-word query
      const multiRes = await querySearch(db, { text: "deploy pipeline" });
      expect(multiRes.hits.length).toBeGreaterThanOrEqual(2);

      // Prefix query
      const prefixRes = await querySearch(db, { text: "auth*" });
      expect(prefixRes.hits.length).toBeGreaterThanOrEqual(1);
      expect(prefixRes.hits[0].turnIndex).toBe(2);
    });

    test("orders results by BM25 relevance score (higher relevance first)", async () => {
      const pathHigh = join(tempDir, "high-relevance.jsonl");
      const pathLow = join(tempDir, "low-relevance.jsonl");

      // High relevance: repeated mentions of keyword
      writeJsonlFile(pathHigh, [
        {
          id: "sess-high-001",
          type: "user",
          timestamp: 1725500020000,
          content: "database database database replication and database backup clustering",
        },
      ]);

      // Low relevance: single mention
      writeJsonlFile(pathLow, [
        {
          id: "sess-low-001",
          type: "user",
          timestamp: 1725500021000,
          content: "We need a database connection string for the dev environment.",
        },
      ]);

      await syncSessionFile(db, {
        path: pathHigh,
        agent: "pi",
        alias: "db-high",
        sessionId: "sess-high-001",
      });
      await syncSessionFile(db, {
        path: pathLow,
        agent: "pi",
        alias: "db-low",
        sessionId: "sess-low-001",
      });

      const res = await querySearch(db, { text: "database" });
      expect(res.hits.length).toBe(2);
      // Top hit should be the one with higher density/relevance
      expect(res.hits[0].sessionId).toBe("sess-high-001");
      expect(res.hits[1].sessionId).toBe("sess-low-001");
      // BM25 rank in SQLite is negative or ordered such that best match comes first
      expect(res.hits[0].score).toBeDefined();
    });

    test("completes query execution within performance bounds (<50ms, typically <10ms)", async () => {
      const sessionPath = join(tempDir, "perf-session.jsonl");
      const turns = [];
      for (let i = 0; i < 50; i++) {
        turns.push({
          id: "sess-perf-001",
          type: i % 2 === 0 ? "user" : "assistant",
          timestamp: 1725500030000 + i * 1000,
          content: `Performance benchmark turn ${i} discussing architectural constraints and indexing speeds.`,
        });
      }
      writeJsonlFile(sessionPath, turns);

      await syncSessionFile(db, {
        path: sessionPath,
        agent: "pi",
        alias: "perf",
        sessionId: "sess-perf-001",
      });

      const start = performance.now();
      const res = await querySearch(db, { text: "architectural constraints" });
      const elapsed = performance.now() - start;

      expect(res.hits.length).toBeGreaterThan(0);
      expect(res.executionTimeMs).toBeDefined();
      expect(elapsed).toBeLessThan(50); // Generous ceiling for CI environments; inner DB time < 10ms
    });

    test("returns safe empty result structure for empty string or non-matching query", async () => {
      // Empty text query
      const emptyRes = await querySearch(db, { text: "" });
      expect(emptyRes).toEqual({
        query: "",
        totalHits: 0,
        hits: [],
        executionTimeMs: expect.any(Number),
      });

      // Whitespace text query
      const wsRes = await querySearch(db, { text: "   " });
      expect(wsRes.totalHits).toBe(0);
      expect(wsRes.hits).toEqual([]);

      // Non-matching query against empty DB
      const noMatchRes = await querySearch(db, { text: "nonexistent_token_xyz_98765" });
      expect(noMatchRes.totalHits).toBe(0);
      expect(noMatchRes.hits).toEqual([]);
    });

    test("escapes FTS5 special syntax characters without throwing SQLite syntax errors", async () => {
      const sessionPath = join(tempDir, "special-chars.jsonl");
      writeJsonlFile(sessionPath, [
        {
          id: "sess-special-001",
          type: "user",
          timestamp: 1725500040000,
          content: 'Error: Cannot connect to http://localhost:8080/api (connection refused) [FATAL] *retry*',
        },
      ]);

      await syncSessionFile(db, {
        path: sessionPath,
        agent: "pi",
        alias: "debug",
        sessionId: "sess-special-001",
      });

      // Test escapeFts5Query helper directly
      const rawTerm = 'error: "unhandled exception" (FATAL) AND NOT OR NEAR *path*';
      const escaped = escapeFts5Query(rawTerm);
      expect(typeof escaped).toBe("string");
      expect(escaped.length).toBeGreaterThan(0);

      // Verify queries with troublesome special characters do not crash SQLite
      const troublesomeQueries = [
        'quotes "inside" query',
        'http://localhost:8080/api',
        'function(arg1, arg2)',
        'AND OR NOT NEAR',
        'lone " unclosed quote',
        'multiple *** asterisks',
        'colon:operator:test',
        'hyphen -minus --flag',
        'curly {braces} and [brackets] ^caret',
      ];

      for (const query of troublesomeQueries) {
        expect(async () => {
          await querySearch(db, { text: query });
        }).not.toThrow();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Task 19: query-pointer-join (FTS5 Join With msg_pointers & Watermarks)
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Task 19: query-pointer-join", () => {
    test("joins msg_pointers and file_watermarks to produce structured search hits", async () => {
      const sessionPath = join(tempDir, "pointer-join-session.jsonl");
      writeJsonlFile(sessionPath, [
        {
          id: "sess-join-001",
          type: "user",
          timestamp: 1725500100000,
          content: "Show me the redis caching configuration for session tokens.",
        },
      ]);

      await syncSessionFile(db, {
        path: sessionPath,
        agent: "hermes",
        alias: "caching",
        sessionId: "sess-join-001",
      });

      const res = await querySearch(db, { text: "redis caching" });
      expect(res.hits.length).toBe(1);

      const hit = res.hits[0];
      // Verify all required fields from Task 19 specification
      expect(typeof hit.rowid).toBe("number");
      expect(hit.rowid).toBeGreaterThan(0);
      expect(hit.sessionId).toBe("sess-join-001");
      expect(hit.shortId).toBe("sess-jo"); // 7-character short ID
      expect(hit.turnIndex).toBe(0);
      expect(hit.timestamp).toBe(1725500100000);
      expect(hit.agent).toBe("hermes");
      expect(hit.alias).toBe("caching");
      expect(hit.filePath).toBe(sessionPath);
      expect(typeof hit.score).toBe("number");
      expect(hit.role).toBeDefined();
    });

    test("populates hitTurn with genuine turn data via direct file seek (readTurnByPointer)", async () => {
      const sessionPath = join(tempDir, "seek-populate.jsonl");
      const originalTurn = {
        id: "sess-seek-001",
        type: "user",
        timestamp: 1725500110000,
        content: "What is the timeout threshold for database transactions?",
      };
      writeJsonlFile(sessionPath, [originalTurn]);

      await syncSessionFile(db, {
        path: sessionPath,
        agent: "pi",
        alias: "default",
        sessionId: "sess-seek-001",
      });

      const res = await querySearch(db, { text: "timeout threshold" });
      expect(res.hits.length).toBe(1);

      const hit = res.hits[0];
      expect(hit.hitTurn).toBeDefined();
      expect(hit.hitTurn).not.toBeNull();

      // Verify fields of hitTurn populated via readTurnByPointer
      const turn = hit.hitTurn as RawTurnRecord;
      expect(turn.sessionId).toBe("sess-seek-001");
      expect(turn.turnIndex).toBe(0);
      expect(turn.timestamp).toBe(1725500110000);
      expect(turn.rawText).toContain("timeout threshold");
      expect(turn.payload).toBeDefined();
      expect(turn.payload.content).toBe("What is the timeout threshold for database transactions?");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Task 20: query-agent-scope (Agent and Alias Filtering)
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Task 20: query-agent-scope", () => {
    beforeEach(async () => {
      // Create three separate sessions across different agents and aliases
      const pathPiWork = join(tempDir, "session-pi-work.jsonl");
      const pathClaudeWork = join(tempDir, "session-claude-work.jsonl");
      const pathHermesHome = join(tempDir, "session-hermes-home.jsonl");

      writeJsonlFile(pathPiWork, [
        {
          id: "sess-scope-pi",
          type: "user",
          timestamp: 1725500200000,
          content: "Docker container healthcheck configuration.",
        },
      ]);

      writeJsonlFile(pathClaudeWork, [
        {
          id: "sess-scope-claude",
          type: "user",
          timestamp: 1725500201000,
          content: "Docker container port mapping setup.",
        },
      ]);

      writeJsonlFile(pathHermesHome, [
        {
          id: "sess-scope-hermes",
          type: "user",
          timestamp: 1725500202000,
          content: "Docker container volume mounts for storage.",
        },
      ]);

      await syncSessionFile(db, {
        path: pathPiWork,
        agent: "pi",
        alias: "work",
        sessionId: "sess-scope-pi",
      });

      await syncSessionFile(db, {
        path: pathClaudeWork,
        agent: "claude",
        alias: "work",
        sessionId: "sess-scope-claude",
      });

      await syncSessionFile(db, {
        path: pathHermesHome,
        agent: "hermes",
        alias: "home",
        sessionId: "sess-scope-hermes",
      });
    });

    test("filters search hits strictly by agent (agent: 'pi')", async () => {
      const res = await querySearch(db, { text: "Docker container", agent: "pi" });

      expect(res.hits.length).toBe(1);
      expect(res.hits[0].agent).toBe("pi");
      expect(res.hits[0].sessionId).toBe("sess-scope-pi");
    });

    test("filters search hits strictly by alias (alias: 'work')", async () => {
      const res = await querySearch(db, { text: "Docker container", alias: "work" });

      expect(res.hits.length).toBe(2);
      for (const hit of res.hits) {
        expect(hit.alias).toBe("work");
      }
      const agents = res.hits.map((h) => h.agent);
      expect(agents).toContain("pi");
      expect(agents).toContain("claude");
      expect(agents).not.toContain("hermes");
    });

    test("filters search hits by both agent AND alias simultaneously", async () => {
      const res = await querySearch(db, {
        text: "Docker container",
        agent: "claude",
        alias: "work",
      });

      expect(res.hits.length).toBe(1);
      expect(res.hits[0].agent).toBe("claude");
      expect(res.hits[0].alias).toBe("work");
      expect(res.hits[0].sessionId).toBe("sess-scope-claude");
    });

    test("returns empty hits array when filtering by non-matching agent or alias", async () => {
      const resNonAgent = await querySearch(db, {
        text: "Docker container",
        agent: "nonexistent-agent",
      });
      expect(resNonAgent.totalHits).toBe(0);
      expect(resNonAgent.hits).toEqual([]);

      const resNonAlias = await querySearch(db, {
        text: "Docker container",
        alias: "nonexistent-alias",
      });
      expect(resNonAlias.totalHits).toBe(0);
      expect(resNonAlias.hits).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Task 21: query-memory-cap (Limit Capping & Bounded RAM)
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Task 21: query-memory-cap & limit", () => {
    test("respects explicit limit parameter and defaults to 20 when unspecified", async () => {
      const sessionPath = join(tempDir, "limit-session.jsonl");
      const turns = [];
      for (let i = 0; i < 40; i++) {
        turns.push({
          id: "sess-limit-001",
          type: "user",
          timestamp: 1725500300000 + i * 1000,
          content: `Replication cluster checkpoint ${i} with active consensus monitoring.`,
        });
      }
      writeJsonlFile(sessionPath, turns);

      await syncSessionFile(db, {
        path: sessionPath,
        agent: "pi",
        alias: "cluster",
        sessionId: "sess-limit-001",
      });

      // Default limit (20)
      const defaultRes = await querySearch(db, { text: "consensus monitoring" });
      expect(defaultRes.hits.length).toBe(20);

      // Custom limit: 5
      const limit5Res = await querySearch(db, { text: "consensus monitoring", limit: 5 });
      expect(limit5Res.hits.length).toBe(5);

      // Custom limit: 30
      const limit30Res = await querySearch(db, { text: "consensus monitoring", limit: 30 });
      expect(limit30Res.hits.length).toBe(30);

      // Limit higher than available hits
      const limit50Res = await querySearch(db, { text: "consensus monitoring", limit: 50 });
      expect(limit50Res.hits.length).toBe(40);
    });

    test("handles large candidate sets efficiently without unbounded RAM spikes", async () => {
      const sessionPath = join(tempDir, "heavy-session.jsonl");
      const turns = [];
      for (let i = 0; i < 200; i++) {
        turns.push({
          id: `sess-heavy-${Math.floor(i / 10)}`,
          type: i % 2 === 0 ? "user" : "assistant",
          timestamp: 1725500400000 + i * 1000,
          content: `High throughput payload iteration ${i} with streaming telemetry data and batch pipeline telemetry.`,
        });
      }
      writeJsonlFile(sessionPath, turns);

      await syncSessionFile(db, {
        path: sessionPath,
        agent: "pi",
        alias: "telemetry",
        sessionId: "sess-heavy-001",
      });

      const initialRss = process.memoryUsage().rss;
      const res = await querySearch(db, { text: "telemetry data", limit: 10 });
      const finalRss = process.memoryUsage().rss;

      expect(res.hits.length).toBe(10);
      // Memory growth must remain strictly below 50MB (52,428,800 bytes)
      const memoryDelta = finalRss - initialRss;
      expect(memoryDelta).toBeLessThan(50 * 1024 * 1024);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Task 22: defer-vec-safe-fallback (Absence of sqlite-vec)
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Task 22: defer-vec-safe-fallback", () => {
    test("falls back cleanly to FTS5 BM25 search when vector extensions are absent without throwing", async () => {
      const sessionPath = join(tempDir, "vec-fallback-session.jsonl");
      writeJsonlFile(sessionPath, [
        {
          id: "sess-vec-001",
          type: "user",
          timestamp: 1725500500000,
          content: "Implement vector similarity embeddings using cosine distance.",
        },
      ]);

      await syncSessionFile(db, {
        path: sessionPath,
        agent: "pi",
        alias: "ai",
        sessionId: "sess-vec-001",
      });

      // Standard query must execute cleanly and not attempt to call missing vector functions
      expect(async () => {
        const res = await querySearch(db, { text: "vector similarity" });
        expect(res.hits.length).toBe(1);
        expect(res.hits[0].sessionId).toBe("sess-vec-001");
      }).not.toThrow();

      // Passing extended options with vector/hybrid flags should degrade gracefully to FTS5 BM25
      expect(async () => {
        const res = await querySearch(db, {
          text: "vector similarity",
          ...({ hybrid: true, useVector: true } as any),
        });
        expect(res.hits.length).toBe(1);
      }).not.toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Context Window (context / contextN)
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Context Window (context / contextN)", () => {
    let sessionPath: string;

    beforeEach(async () => {
      sessionPath = join(tempDir, "context-session.jsonl");
      const turns = [
        { id: "sess-ctx-001", type: "user", timestamp: 1725500600000, content: "Turn 0: Introduction" },
        { id: "sess-ctx-001", type: "assistant", timestamp: 1725500601000, content: "Turn 1: Clarification" },
        { id: "sess-ctx-001", type: "user", timestamp: 1725500602000, content: "Turn 2: Target keyword needle in haystack" },
        { id: "sess-ctx-001", type: "assistant", timestamp: 1725500603000, content: "Turn 3: Solution details" },
        { id: "sess-ctx-001", type: "user", timestamp: 1725500604000, content: "Turn 4: Wrapup question" },
      ];
      writeJsonlFile(sessionPath, turns);

      await syncSessionFile(db, {
        path: sessionPath,
        agent: "pi",
        alias: "context-test",
        sessionId: "sess-ctx-001",
      });
    });

    test("includes adjacent context turns (before and after) when context > 0 is requested", async () => {
      const res = await querySearch(db, {
        text: "needle in haystack",
        context: 2,
      });

      expect(res.hits.length).toBe(1);
      const hit = res.hits[0];

      expect(hit.context).toBeDefined();
      const ctx = hit.context as ContextWindowResult;
      expect(ctx.hitTurn).toBeDefined();
      expect(ctx.hitTurn?.turnIndex).toBe(2);

      // Exactly 2 before: turns 0 and 1
      expect(ctx.before.length).toBe(2);
      expect(ctx.before[0].turnIndex).toBe(0);
      expect(ctx.before[1].turnIndex).toBe(1);

      // Exactly 2 after: turns 3 and 4
      expect(ctx.after.length).toBe(2);
      expect(ctx.after[0].turnIndex).toBe(3);
      expect(ctx.after[1].turnIndex).toBe(4);
    });

    test("supports contextN parameter naming alias", async () => {
      const res = await querySearch(db, {
        text: "needle in haystack",
        ...({ contextN: 1 } as any),
      });

      expect(res.hits.length).toBe(1);
      const ctx = res.hits[0].context as ContextWindowResult;
      expect(ctx).toBeDefined();
      expect(ctx.before.length).toBe(1);
      expect(ctx.before[0].turnIndex).toBe(1);
      expect(ctx.after.length).toBe(1);
      expect(ctx.after[0].turnIndex).toBe(3);
    });

    test("handles boundary hits (turn 0) with empty before array", async () => {
      const res = await querySearch(db, {
        text: "Introduction",
        context: 2,
      });

      expect(res.hits.length).toBe(1);
      const ctx = res.hits[0].context as ContextWindowResult;
      expect(ctx.hitTurn?.turnIndex).toBe(0);
      expect(ctx.before).toEqual([]);
      expect(ctx.after.length).toBe(2);
    });

    test("does not populate context arrays when context is 0 or omitted", async () => {
      const res = await querySearch(db, { text: "needle in haystack" });
      expect(res.hits.length).toBe(1);
      const hit = res.hits[0];
      // Either context is undefined or before/after are empty
      if (hit.context) {
        expect(hit.context.before).toEqual([]);
        expect(hit.context.after).toEqual([]);
      } else {
        expect(hit.context).toBeUndefined();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Index Barrel Export (src/search/index.ts)
  // ───────────────────────────────────────────────────────────────────────────
  describe("7. Index Barrel Export (src/search/index.ts)", () => {
    test("re-exports complete search public API functions", () => {
      expect(typeof initSearchDb).toBe("function");
      expect(typeof getDbPath).toBe("function");
      expect(typeof extractTurnPayload).toBe("function");
      expect(typeof syncFileWatermarks).toBe("function");
      expect(typeof syncAllSessions).toBe("function");
      expect(typeof readTurnByPointer).toBe("function");
      expect(typeof readTurnContext).toBe("function");
      expect(typeof indexQuerySearch).toBe("function");
    });

    test("executes search query successfully via barrel export functions", async () => {
      // Initialize DB via barrel function
      const barrelDb = initSearchDb({ dbPath: join(tempDir, "barrel-search.sqlite") });
      try {
        const sessionPath = join(tempDir, "barrel-session.jsonl");
        writeJsonlFile(sessionPath, [
          {
            id: "sess-barrel-001",
            type: "user",
            timestamp: 1725500700000,
            content: "Integration test through barrel export facade.",
          },
        ]);

        await syncFileWatermarks(barrelDb, {
          path: sessionPath,
          agent: "barrel-agent",
          alias: "test-alias",
          sessionId: "sess-barrel-001",
        });

        const res = await indexQuerySearch(barrelDb, { text: "barrel export facade" });
        expect(res.hits.length).toBe(1);
        expect(res.hits[0].agent).toBe("barrel-agent");
      } finally {
        closeSearchDb(barrelDb);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Adversarial & Boundary Hardening
  // ───────────────────────────────────────────────────────────────────────────
  describe("8. Adversarial & Boundary Hardening", () => {
    test("handles searching immediately after incremental append sync", async () => {
      const sessionPath = join(tempDir, "append-sync.jsonl");

      // Step 1: Initial 1 turn
      writeJsonlFile(sessionPath, [
        { id: "sess-app-001", type: "user", timestamp: 1725500800000, content: "First turn initial" },
      ]);
      await syncSessionFile(db, {
        path: sessionPath,
        agent: "pi",
        alias: "append",
        sessionId: "sess-app-001",
      });

      let res = await querySearch(db, { text: "First turn" });
      expect(res.hits.length).toBe(1);

      // Step 2: Append 2nd turn
      const appendLine = JSON.stringify({
        id: "sess-app-001",
        type: "assistant",
        timestamp: 1725500801000,
        content: "Second turn newly appended after initial index",
      }) + "\n";
      writeFileSync(sessionPath, appendLine, { flag: "a" });

      // Step 3: Re-sync incrementally
      await syncSessionFile(db, {
        path: sessionPath,
        agent: "pi",
        alias: "append",
        sessionId: "sess-app-001",
      });

      res = await querySearch(db, { text: "newly appended" });
      expect(res.hits.length).toBe(1);
      expect(res.hits[0].turnIndex).toBe(1);
    });

    test("handles non-existent or deleted physical files gracefully during seek", async () => {
      const sessionPath = join(tempDir, "temp-to-delete.jsonl");
      writeJsonlFile(sessionPath, [
        { id: "sess-del-001", type: "user", timestamp: 1725500900000, content: "File about to be deleted from disk" },
      ]);

      await syncSessionFile(db, {
        path: sessionPath,
        agent: "pi",
        alias: "volatile",
        sessionId: "sess-del-001",
      });

      // Delete physical file
      rmSync(sessionPath, { force: true });

      // Querying should still succeed: index has metadata, but hitTurn handles missing file safely
      const res = await querySearch(db, { text: "deleted from disk" });
      expect(res.hits.length).toBe(1);
      expect(res.hits[0].sessionId).toBe("sess-del-001");
      expect(res.hits[0].hitTurn).toBeNull();
    });

    test("handles queries with multi-byte unicode and astral emojis", async () => {
      const sessionPath = join(tempDir, "emoji-session.jsonl");
      writeJsonlFile(sessionPath, [
        {
          id: "sess-emoji-001",
          type: "user",
          timestamp: 1725500950000,
          content: "Deploy succeeded 🚀🎉 with zero downtime in Tokyo 🗼",
        },
      ]);

      await syncSessionFile(db, {
        path: sessionPath,
        agent: "pi",
        alias: "unicode",
        sessionId: "sess-emoji-001",
      });

      const res = await querySearch(db, { text: "downtime Tokyo" });
      expect(res.hits.length).toBe(1);
      expect(res.hits[0].hitTurn?.rawText).toContain("🚀🎉");
    });
  });
});
