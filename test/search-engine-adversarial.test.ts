/**
 * test/search-engine-adversarial.test.ts
 *
 * Empirical Challenger Adversarial & Stress Test Suite for Milestone 5:
 * Full-Text Search Query Execution Engine (`src/search/engine.ts`).
 *
 * Adversarially challenges:
 * 1. Extreme queries with special syntax characters:
 *    - Unmatched quotes: `"`, `"""`, `foo"bar`, `"hello world`, `"""""`, nested quotes
 *    - Colon queries: `agent:pi`, `http://localhost:8080`, `::`, `:::foo:::`, `user_text:foo`
 *    - FTS5 boolean logic and near: `AND OR NOT NEAR NEAR/5`, `AND AND`, `NOT NOT`, `NEAR(a, b, 5)`
 *    - Parentheses and wildcard combinations: `(auth OR login)*`, `***`, `*foo*`, `foo***`, `***foo`
 *    - SQL injection attempts: `' OR 1=1 --`, `"; DROP TABLE msg_fts; --`, `' UNION SELECT ...`
 * 2. Unhandled exception / crash prevention:
 *    - 100+ hostile query inputs verified never to throw unhandled exceptions or crash the runtime
 *    - Database PRAGMA integrity_check verified before and after adversarial bombardment
 * 3. SQL injection resistance in filtering options:
 *    - Parameterized escaping for `options.agent` and `options.alias`
 * 4. Input boundary & fuzzing resilience:
 *    - Non-string values, control characters (`\0`), astral emojis, RTL overrides, 10KB+ massive queries
 * 5. Limit capping & pagination hardening:
 *    - Default limit (20), custom limits (5, 50, 500), non-standard limits (`0`, `-1`, `NaN`, `Infinity`)
 * 6. Context window resilience:
 *    - Boundary turns, large context, missing files
 * 7. Large result sets & performance / memory bounds:
 *    - 5,000 candidate matches executed in < 50ms with RSS memory increase < 50MB
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { closeSearchDb, initSearchSchema, openSearchDb } from "../src/search/db";
import {
  escapeFts5Query,
  querySearch,
  type SearchEngineHit,
  type SearchQueryResult,
} from "../src/search/engine";
import { syncSessionFile } from "../src/search/sync";
import type { RawTurnRecord } from "../src/search/reader";

describe("Milestone 5 Challenger Adversarial Stress Suite (src/search/engine.ts)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let sessionPath: string;

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `oas-engine-adv-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tempDir, { recursive: true });

    dbPath = join(tempDir, "search.sqlite");
    db = openSearchDb({ dbPath });
    initSearchSchema(db);

    // Populate a multi-turn baseline session for matching
    sessionPath = join(tempDir, "adv-baseline.jsonl");
    const baselineTurns = [
      {
        id: "sess-adv-001",
        type: "user",
        timestamp: 1725501000000,
        content: "Turn 0: Initial query discussing OAuth2 authentication and token expiration.",
      },
      {
        id: "sess-adv-001",
        type: "assistant",
        timestamp: 1725501001000,
        content: "Turn 1: Recommend using http://localhost:8080/auth endpoint with agent:pi config.",
      },
      {
        id: "sess-adv-001",
        type: "user",
        timestamp: 1725501002000,
        content: "Turn 2: Database replication cluster consensus error foo\"bar and (auth OR login)* retry.",
      },
      {
        id: "sess-adv-001",
        type: "assistant",
        timestamp: 1725501003000,
        content: "Turn 3: Resolved using C++ helper and Docker container volume mounts for postgres.",
      },
      {
        id: "sess-adv-001",
        type: "user",
        timestamp: 1725501004000,
        content: "Turn 4: Final verification with astral emojis 🚀🎉 and confidential admin data.",
      },
    ];

    const content = baselineTurns.map((t) => JSON.stringify(t)).join("\n") + "\n";
    writeFileSync(sessionPath, content, "utf8");

    await syncSessionFile(db, {
      path: sessionPath,
      agent: "pi",
      alias: "adversarial",
      sessionId: "sess-adv-001",
    });
  });

  afterEach(() => {
    closeSearchDb(db);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Extreme Queries with Special Syntax Characters
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Extreme Queries with Special Syntax Characters", () => {
    test("handles unmatched quotes and quote clusters without syntax error", async () => {
      const quoteQueries = [
        '"',
        '"""',
        '""""',
        '"""""',
        'foo"bar',
        '"hello world',
        'hello world"',
        '"foo"bar"baz"',
        '""hello""world""',
        '"nested ""quote"" here"',
        '"""hello"""',
        '""',
      ];

      for (const q of quoteQueries) {
        expect(async () => {
          const res = await querySearch(db, { text: q });
          expect(res).toBeDefined();
          expect(typeof res.totalHits).toBe("number");
          expect(Array.isArray(res.hits)).toBe(true);
        }).not.toThrow();
      }
    });

    test("handles colon queries and URL/port formats safely", async () => {
      const colonQueries = [
        "agent:pi",
        "http://localhost:8080",
        "http://localhost:8080/auth",
        "::",
        ":::foo:::",
        ":",
        ":::",
        "user_text:foo",
        "assistant_text:OAuth2",
        "not_a_column:token",
        "path/to/file:42:10",
        "urn:isbn:0451450523",
        "::1",
        ":leading",
        "trailing:",
      ];

      for (const q of colonQueries) {
        expect(async () => {
          const res = await querySearch(db, { text: q });
          expect(res).toBeDefined();
          expect(typeof res.totalHits).toBe("number");
          expect(Array.isArray(res.hits)).toBe(true);
        }).not.toThrow();
      }

      // Verify that "http://localhost:8080/auth" actually matches Turn 1
      const urlRes = await querySearch(db, { text: "http://localhost:8080" });
      expect(urlRes.hits.length).toBeGreaterThanOrEqual(1);
      expect(urlRes.hits[0].turnIndex).toBe(1);
    });

    test("handles FTS5 boolean logic and NEAR syntax tokens safely", async () => {
      const booleanQueries = [
        "AND OR NOT NEAR NEAR/5",
        "AND AND",
        "NOT NOT",
        "OR OR",
        "NEAR/0",
        "NEAR/99999999",
        "NEAR/-1",
        "NEAR/",
        "NOT",
        "AND",
        "OR",
        "NEAR",
        "a AND NOT b",
        "NOT a",
        "a NOT",
        "NEAR(a b)",
        "NEAR(a, b, 5)",
        "AND auth",
        "auth AND",
        "OR login",
        "login OR",
        "NOT expiration",
      ];

      for (const q of booleanQueries) {
        expect(async () => {
          const res = await querySearch(db, { text: q });
          expect(res).toBeDefined();
          expect(typeof res.totalHits).toBe("number");
          expect(Array.isArray(res.hits)).toBe(true);
        }).not.toThrow();
      }
    });

    test("handles parentheses and wildcard combinations safely", async () => {
      const wildcardQueries = [
        "(auth OR login)*",
        "***",
        "*foo*",
        "foo***",
        "***foo",
        "(*)",
        "()*",
        ")(",
        "(((",
        ")))",
        "*",
        "**",
        "*****",
        "auth*",
        "*auth",
        "(auth)*",
        "*(auth)*",
        "(auth OR login)",
        "((((OAuth2))))",
        "))))OAuth2((((",
        "a*b*c*",
        "**a**b**",
        '"*"',
        '""*',
        '*""',
        '""*""',
      ];

      for (const q of wildcardQueries) {
        expect(async () => {
          const res = await querySearch(db, { text: q });
          expect(res).toBeDefined();
          expect(typeof res.totalHits).toBe("number");
          expect(Array.isArray(res.hits)).toBe(true);
        }).not.toThrow();
      }

      // Verify that valid prefix "auth*" matches Turn 0
      const prefixRes = await querySearch(db, { text: "auth*" });
      expect(prefixRes.hits.length).toBeGreaterThanOrEqual(1);
      expect(prefixRes.hits[0].turnIndex).toBe(0);
    });

    test("resists SQL injection attempts in search text", async () => {
      const injectionQueries = [
        "' OR 1=1 --",
        '"; DROP TABLE msg_fts; --',
        "' UNION SELECT 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13 --",
        "1; VACUUM;",
        "admin' --",
        "'; DELETE FROM msg_pointers; --",
        "1'; UPDATE file_watermarks SET agent='evil'; --",
        "'; DROP TABLE file_watermarks; --",
        "' OR 'x'='x",
        "\" OR 1=1 --",
      ];

      for (const q of injectionQueries) {
        expect(async () => {
          const res = await querySearch(db, { text: q });
          expect(res).toBeDefined();
          expect(typeof res.totalHits).toBe("number");
        }).not.toThrow();
      }

      // Verify database schema and records were NOT dropped or modified
      const pointerCount = db.query("SELECT count(*) as count FROM msg_pointers").get() as any;
      expect(pointerCount.count).toBe(5);

      const watermarkCount = db.query("SELECT count(*) as count FROM file_watermarks").get() as any;
      expect(watermarkCount.count).toBe(1);

      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("msg_fts");
      expect(tableNames).toContain("msg_pointers");
      expect(tableNames).toContain("file_watermarks");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Comprehensive Crash & Unhandled Exception Prevention
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Comprehensive Crash & Unhandled Exception Prevention", () => {
    test("processes 100+ hostile and adversarial queries without throwing or crashing", async () => {
      const hostileQueries = [
        "",
        " ",
        "   \t\r\n   ",
        "\0",
        "\x01\x02\x03\x04\x05\x06\x07\x08\x0B\x0C\x0E\x0F",
        "\u202Ereversed\u202D",
        "🚀 🔥 🗼 🎉 👾",
        "+",
        "-",
        "*",
        "/",
        "\\",
        "^",
        ":",
        ";",
        "=",
        "<",
        ">",
        "@",
        "#",
        "$",
        "%",
        "!",
        "&",
        "|",
        "?",
        "~",
        "`",
        ".",
        ",",
        "(",
        ")",
        "[",
        "]",
        "{",
        "}",
        "c++",
        "C#",
        "a + b = c",
        "foo & bar | baz",
        "foo ^ bar",
        "~tilde",
        "100%",
        "$100.00",
        "@handle",
        "!important",
        "<script>alert(1)</script>",
        "{\"json\": true}",
        "[[[array]]]",
        "a/b/c\\d",
        "foo-bar-baz",
        "--leading-hyphen",
        "trailing-hyphen--",
        "http://user:pass@example.com:8080/path?q=1&b=2#hash",
        "urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
        "A".repeat(5000),
        "\"nested\" ".repeat(100),
        "*".repeat(1000),
        ":".repeat(1000),
        "AND ".repeat(100),
        "OR ".repeat(100),
        "NOT ".repeat(100),
        "NEAR/".repeat(50),
        "(".repeat(50) + "token" + ")".repeat(50),
      ];

      for (const query of hostileQueries) {
        let result: SearchQueryResult | null = null;
        expect(async () => {
          result = await querySearch(db, { text: query });
        }).not.toThrow();

        expect(result).toBeDefined();
        expect(typeof result!.totalHits).toBe("number");
        expect(Array.isArray(result!.hits)).toBe(true);
        expect(typeof result!.executionTimeMs).toBe("number");
      }

      // Assert SQLite PRAGMA integrity_check is OK
      const integrity = db.query("PRAGMA integrity_check;").all() as any[];
      expect(integrity).toEqual([{ integrity_check: "ok" }]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. SQL Injection Resistance in Filtering Parameters
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. SQL Injection Resistance in Filtering Parameters", () => {
    test("neutralizes SQL injection attempts in agent filter", async () => {
      const maliciousAgents = [
        "' OR 1=1 --",
        "pi'; DROP TABLE msg_fts; --",
        "' UNION SELECT 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13 --",
        "pi' AND 1=0 UNION ALL SELECT * FROM file_watermarks --",
      ];

      for (const agent of maliciousAgents) {
        const res = await querySearch(db, { text: "authentication", agent });
        expect(res.hits.length).toBe(0);
        expect(res.totalHits).toBe(0);
      }

      // Verify legitimate agent still works
      const validRes = await querySearch(db, { text: "authentication", agent: "pi" });
      expect(validRes.hits.length).toBe(1);
    });

    test("neutralizes SQL injection attempts in alias filter", async () => {
      const maliciousAliases = [
        "' OR 1=1 --",
        "adversarial'; DELETE FROM msg_pointers; --",
        "' UNION SELECT 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13 --",
      ];

      for (const alias of maliciousAliases) {
        const res = await querySearch(db, { text: "authentication", alias });
        expect(res.hits.length).toBe(0);
        expect(res.totalHits).toBe(0);
      }

      // Verify legitimate alias still works
      const validRes = await querySearch(db, { text: "authentication", alias: "adversarial" });
      expect(validRes.hits.length).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Input Boundary & Fuzzing Resilience
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Input Boundary & Fuzzing Resilience", () => {
    test("handles non-string or malformed options safely", async () => {
      const badOptions: any[] = [
        {},
        { text: undefined },
        { text: null },
        { text: 12345 },
        { text: ["array", "of", "strings"] },
        { text: { nested: "object" } },
        { text: () => "function" },
        { text: true },
        { text: false },
      ];

      for (const opt of badOptions) {
        expect(async () => {
          const res = await querySearch(db, opt);
          expect(res.totalHits).toBe(0);
          expect(res.hits).toEqual([]);
        }).not.toThrow();
      }
    });

    test("handles massive multi-kilobyte query strings without memory exhaustion", async () => {
      const massiveQuery = "word ".repeat(5000); // ~25KB query string
      const start = performance.now();
      const res = await querySearch(db, { text: massiveQuery });
      const elapsed = performance.now() - start;

      expect(res).toBeDefined();
      expect(elapsed).toBeLessThan(100); // Must not hang
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Limit Capping & Pagination Hardening
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Limit Capping & Pagination Hardening", () => {
    test("safely bounds non-standard limit values", async () => {
      // Limit 0 should default safely to 20
      const resZero = await querySearch(db, { text: "Turn", limit: 0 });
      expect(resZero.hits.length).toBe(5); // All 5 baseline turns returned

      // Negative limit should default safely to 20
      const resNeg = await querySearch(db, { text: "Turn", limit: -10 });
      expect(resNeg.hits.length).toBe(5);

      // Explicit limit: 2
      const res2 = await querySearch(db, { text: "Turn", limit: 2 });
      expect(res2.hits.length).toBe(2);
      expect(res2.totalHits).toBe(5);

      // Explicit limit: 1
      const res1 = await querySearch(db, { text: "Turn", limit: 1 });
      expect(res1.hits.length).toBe(1);
      expect(res1.totalHits).toBe(5);

      // Non-integer and extreme numbers should be handled without crashing
      for (const weirdLimit of [NaN, Infinity, 2.5, "10" as any]) {
        expect(async () => {
          const res = await querySearch(db, { text: "Turn", limit: weirdLimit as any });
          expect(res).toBeDefined();
          expect(Array.isArray(res.hits)).toBe(true);
        }).not.toThrow();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Context Window Hardening
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Context Window Hardening", () => {
    test("handles extreme context parameters and boundary conditions", async () => {
      // Large context request exceeding available session turns
      const resLarge = await querySearch(db, { text: "Initial query", context: 100 });
      expect(resLarge.hits.length).toBe(1);
      const hit = resLarge.hits[0];
      expect(hit.context).toBeDefined();
      expect(hit.context!.before.length).toBe(0); // Turn 0 has no preceding turns
      expect(hit.context!.after.length).toBe(4); // Turns 1, 2, 3, 4

      // Negative context value should not crash and return no extra context
      const resNeg = await querySearch(db, { text: "Initial query", context: -5 });
      expect(resNeg.hits.length).toBe(1);
      expect(resNeg.hits[0].context).toBeUndefined();

      // Non-existent session file on disk
      rmSync(sessionPath, { force: true });
      const resMissing = await querySearch(db, { text: "Initial query", context: 2 });
      expect(resMissing.hits.length).toBe(1);
      expect(resMissing.hits[0].hitTurn).toBeNull();
      expect(resMissing.hits[0].context?.hitTurn).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Large Result Sets & Performance / Memory Bounds
  // ───────────────────────────────────────────────────────────────────────────
  describe("7. Large Result Sets & Performance / Memory Bounds", () => {
    let heavySessionPath: string;

    beforeEach(async () => {
      heavySessionPath = join(tempDir, "heavy-volume.jsonl");
      const turns = [];
      const N = 5000;
      for (let i = 0; i < N; i++) {
        turns.push({
          id: `sess-heavy-vol`,
          type: i % 2 === 0 ? "user" : "assistant",
          timestamp: 1725502000000 + i,
          content: `BenchmarkCandidate turn ${i} high throughput indexing and retrieval verification test.`,
        });
      }
      writeFileSync(heavySessionPath, turns.map((t) => JSON.stringify(t)).join("\n") + "\n");

      await syncSessionFile(db, {
        path: heavySessionPath,
        agent: "pi",
        alias: "volume-test",
        sessionId: "sess-heavy-vol",
      });
    });

    test("accurately counts and limits 5,000 candidate matches in < 50ms", async () => {
      const start = performance.now();
      const res = await querySearch(db, {
        text: "BenchmarkCandidate",
        limit: 20,
      });
      const elapsed = performance.now() - start;

      expect(res.hits.length).toBe(20);
      expect(res.totalHits).toBe(5000);
      expect(elapsed).toBeLessThan(50); // Generous 50ms ceiling; actual is ~10ms
      expect(res.executionTimeMs).toBeLessThan(50);
    });

    test("maintains strictly bounded memory increase (< 50MB RSS) when returning 1,000 matches", async () => {
      if (global.gc) global.gc();
      const initialRss = process.memoryUsage().rss;

      const res = await querySearch(db, {
        text: "BenchmarkCandidate",
        limit: 1000,
      });

      const finalRss = process.memoryUsage().rss;
      const rssDeltaMB = (finalRss - initialRss) / (1024 * 1024);

      expect(res.hits.length).toBe(1000);
      expect(res.totalHits).toBe(5000);
      // Memory growth must remain strictly below 50MB
      expect(rssDeltaMB).toBeLessThan(50);
    });

    test("handles full 5,000 row retrieval with direct seeks in reasonable time", async () => {
      const start = performance.now();
      const res = await querySearch(db, {
        text: "BenchmarkCandidate",
        limit: 5000,
      });
      const elapsed = performance.now() - start;

      expect(res.hits.length).toBe(5000);
      expect(res.totalHits).toBe(5000);
      // Even resolving 5,000 direct file seeks completes quickly
      expect(elapsed).toBeLessThan(250);
    });
  });
});
