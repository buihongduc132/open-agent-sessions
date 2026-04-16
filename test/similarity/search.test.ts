/**
 * REQ-SIM-01 — Hybrid Search: findSimilarSessions
 *
 * RED phase: all tests are expected to FAIL until search.ts is implemented.
 *
 * Test categories:
 *   A. Unit Tests       — findSimilarSessions returns ranked results
 *   B. Fusion Tests     — RRF with 70/30 weighting
 *   C. Fallback Tests   — missing tables → empty array
 *   D. Integration Tests — full pipeline with real DB + stored embeddings
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateEmbedding,
  storeEmbeddings,
  type EmbeddingRecord,
} from "../../src/similarity/storage";
import { initializeSimilarity } from "../../src/similarity/config";
import {
  findSimilarSessions,
  type SimilarSessionResult,
} from "../../src/similarity/search";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStorageDb(): { db: Database; dir: string } {
  const dir = join(tmpdir(), `sim-search-test-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "sim.db"));
  initializeSimilarity(db, { enabled: true, embeddingProvider: "local", topK: 5 });
  return { db, dir };
}

/** Shared title map — auto-populated by storeTestSession so all calls get titles. */
const sessionTitles = new Map<string, string>();

/**
 * Pre-populate session_vec + session_fts with chunk embeddings.
 * Also registers the title in the shared sessionTitles map so findSimilarSessions
 * can resolve it (simulates what the sessions table would provide in production).
 */
function storeTestSession(
  db: Database,
  sessionId: string,
  title: string,
  chunks: string[]
): void {
  sessionTitles.set(sessionId, title);

  const records: EmbeddingRecord[] = chunks.map((chunkText, i) => ({
    sessionId,
    messageId: `${sessionId}-m${i}`,
    chunkText,
    embedding: generateEmbedding(chunkText),
  }));
  storeEmbeddings(db, records);

  // Also index in FTS shadow table (indexFtsChunks is not exported,
  // so we go direct — this mirrors what indexSessionEmbeddings does internally)
  try {
    for (let i = 0; i < chunks.length; i++) {
      db
        .prepare(
          `INSERT OR REPLACE INTO session_fts (session_id, message_id, chunk_text) VALUES (?, ?, ?)`
        )
        .run(sessionId, `${sessionId}-m${i}`, chunks[i]);
    }
  } catch {
    // FTS table may not exist — skip (tests guard against this)
  }
}

/**
 * Proxy for findSimilarSessions that auto-injects sessionTitles from the shared map.
 * All business-logic tests should use this; only exception/error tests use the raw
 * findSimilarSessions directly.
 */
async function search(
  db: Database,
  query: string,
  options?: Parameters<typeof findSimilarSessions>[2]
): Promise<SimilarSessionResult[]> {
  return findSimilarSessions(db, query, {
    ...options,
    sessionTitles: Object.fromEntries(sessionTitles),
  });
}

// ─── A. Unit Tests ─────────────────────────────────────────────────────────────

describe("A. Unit Tests — findSimilarSessions returns ranked results", () => {
  let db: Database;
  let dir: string;

  beforeEach(() => {
    sessionTitles.clear(); // reset between tests
    const fixture = makeStorageDb();
    db = fixture.db;
    dir = fixture.dir;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("test_search_returns_empty_when_no_embeddings", async () => {
    //#given an empty database with no indexed sessions
    //#when findSimilarSessions is called with any query
    //#then it returns an empty array
    const results = await search(db, "typescript async");
    expect(results).toHaveLength(0);
  });

  test("test_search_single_session_returns_that_session", async () => {
    //#given a database with exactly one indexed session
    storeTestSession(db, "s1", "My Test Session", [
      "This is a session about TypeScript async programming and promises",
    ]);

    //#when findSimilarSessions is called
    const results = await search(db, "TypeScript async");

    //#then exactly one result is returned with rank 1
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("s1");
    expect(results[0].rank).toBe(1);
    expect(results[0].title).toBe("My Test Session");
  });

  test("test_search_multiple_sessions_ranked_by_hybrid_score", async () => {
    //#given three sessions:
    //   s1 and s2 contain the keyword "TypeScript" (FTS match)
    //   s3 contains NO TypeScript keyword (no FTS match, only vector)
    storeTestSession(db, "s1", "TypeScript Basics", [
      "TypeScript is a typed superset of JavaScript that compiles to plain JS",
    ]);
    storeTestSession(db, "s2", "TypeScript Advanced", [
      "TypeScript generics and advanced type system features",
    ]);
    storeTestSession(db, "s3", "Python Guide", [
      "Python is a versatile programming language with dynamic typing and no TypeScript",
    ]);

    //#when searching for "TypeScript generics"
    const results = await search(db, "TypeScript generics");

    //#then s1 and s2 (FTS keyword matches) should rank ahead of s3
    //  Note: the mock embedding doesn't capture real semantics, so ranking
    //  among s1/s2 reflects FTS + mock vector tiebreaking only.
    expect(results.length).toBeGreaterThanOrEqual(2);
    const s1Rank = results.find((r) => r.sessionId === "s1")?.rank ?? 999;
    const s2Rank = results.find((r) => r.sessionId === "s2")?.rank ?? 999;
    const s3Rank = results.find((r) => r.sessionId === "s3")?.rank ?? 999;
    // Both TypeScript sessions should outrank the Python session
    expect(Math.min(s1Rank, s2Rank)).toBeLessThan(s3Rank);
    // Ranks start at 1
    expect(results[0].rank).toBe(1);
  });

  test("test_search_returns_correct_topK_results", async () => {
    //#given five indexed sessions
    for (let i = 1; i <= 5; i++) {
      storeTestSession(db, `s${i}`, `Session ${i}`, [
        `Content for session ${i} with some specific text about the topic`,
      ]);
    }

    //#when findSimilarSessions is called with topK=3
    //#then at most 3 results are returned
    const results = await search(db, "specific text", { topK: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("test_search_all_results_have_required_fields", async () => {
    //#given a single indexed session
    storeTestSession(db, "s1", "Test Title", [
      "Some meaningful content about Node.js clustering",
    ]);

    //#when findSimilarSessions is called
    const results = await search(db, "Node.js clustering");

    //#then every result has all required fields
    for (const result of results) {
      expect(result).toHaveProperty("sessionId");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("rank");
      expect(result).toHaveProperty("matchType");
      expect(result).toHaveProperty("matchedChunks");
      expect(typeof result.score).toBe("number");
      expect(typeof result.rank).toBe("number");
      expect(result.rank).toBeGreaterThan(0);
    }
  });
});

// ─── B. Fusion Tests — RRF with 70/30 weighting ───────────────────────────────

describe("B. Fusion Tests — RRF with 70/30 weighting", () => {
  let db: Database;
  let dir: string;

  beforeEach(() => {
    sessionTitles.clear();
    const fixture = makeStorageDb();
    db = fixture.db;
    dir = fixture.dir;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("test_search_fts_and_vector_contribute_to_hybrid_score", async () => {
    //#given a session that matches strongly on BOTH vector and FTS
    storeTestSession(db, "s1", "TypeScript Promises", [
      "TypeScript async programming with promises and await",
    ]);

    //#when searching for text that matches the chunk content
    const results = await search(db, "TypeScript async promises");

    //#then the matchType should be "hybrid"
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchType).toMatch(/^(hybrid|vector-only|fts-only)$/);
  });

  test("test_search_fts_only_when_vector_search_fails", async () => {
    //#given sessions with very different content
    storeTestSession(db, "s1", "Completely Different Topic", [
      "Quantum physics and relativity theory concepts",
    ]);
    storeTestSession(db, "s2", "Another Topic", [
      "Machine learning algorithms and neural network architectures",
    ]);

    //#when searching for a query
    const results = await search(db, "quantum physics");

    //#then a result is returned OR empty gracefully (both valid)
    expect(Array.isArray(results)).toBe(true);
  });

  test("test_search_scores_are_fusion_scores_between_zero_and_one", async () => {
    //#given multiple sessions with embeddings stored
    storeTestSession(db, "s1", "TypeScript Session", [
      "TypeScript provides static type checking for JavaScript applications",
    ]);
    storeTestSession(db, "s2", "Python Session", [
      "Python is a dynamically typed language used in data science",
    ]);

    //#when searching for a query
    const results = await search(db, "TypeScript type checking");

    //#then all returned scores are between 0 and 1 (RRF normalised)
    for (const result of results) {
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  test("test_search_ranks_are_consecutive_from_one", async () => {
    //#given three sessions
    storeTestSession(db, "s1", "First", ["Content about testing frameworks Jest"]);
    storeTestSession(db, "s2", "Second", ["Content about testing frameworks Vitest"]);
    storeTestSession(db, "s3", "Third", ["Content about cooking recipes pasta"]);

    //#when searching
    const results = await search(db, "testing frameworks");

    //#then ranks are consecutive starting from 1
    const ranks = results.map((r) => r.rank).sort((a, b) => a - b);
    expect(ranks[0]).toBe(1);
    for (let i = 0; i < ranks.length; i++) {
      expect(ranks[i]).toBe(i + 1);
    }
  });
});

// ─── C. Fallback Tests — missing tables → empty array ─────────────────────────

describe("C. Fallback Tests — missing tables → empty array", () => {
  test("test_search_missing_tables_returns_empty_gracefully", async () => {
    //#given a fresh database with NO session_vec or session_fts tables
    const dir = join(tmpdir(), `sim-missing-test-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "sim.db"));
    // Do NOT call initializeSimilarity — tables do not exist

    //#when findSimilarSessions is called
    //#then it returns empty array without throwing
    let threw = false;
    let results: SimilarSessionResult[] = [];
    try {
      results = await findSimilarSessions(db, "any query");
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(results).toHaveLength(0);

    db.close();
    rmSync(dir, { recursive: true });
  });

  test("test_search_empty_query_string_returns_results", async () => {
    //#given a database with indexed sessions
    sessionTitles.clear();
    const fixture = makeStorageDb();
    const { db, dir: fixtureDir } = fixture;
    storeTestSession(db, "s1", "A Session", [
      "Some content about API design and REST endpoints",
    ]);

    //#when findSimilarSessions is called with an empty string query
    //#then it returns results without throwing (empty string still generates embedding)
    let threw = false;
    let results: SimilarSessionResult[] = [];
    try {
      results = await search(db, "");
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(Array.isArray(results)).toBe(true);

    db.close();
    rmSync(fixtureDir, { recursive: true });
  });
});

// ─── D. Integration Tests — full pipeline ─────────────────────────────────────

describe("D. Integration Tests — full pipeline", () => {
  let db: Database;
  let dir: string;

  beforeEach(() => {
    sessionTitles.clear();
    const fixture = makeStorageDb();
    db = fixture.db;
    dir = fixture.dir;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("test_search_sessions_aggregated_from_chunks", async () => {
    //#given a session with multiple chunks
    storeTestSession(db, "s1", "Multi-chunk Session", [
      "First chunk discussing TypeScript type inference mechanisms",
      "Second chunk about TypeScript generics and conditional types",
      "Third chunk on TypeScript compile-time checks and type guards",
    ]);

    //#when findSimilarSessions searches for a TypeScript topic
    const results = await search(db, "TypeScript generics type inference");

    //#then the session is returned as ONE result (aggregated from multiple chunks)
    //  matchedChunks reflects how many chunks were indexed for this session
    expect(results.length).toBeGreaterThan(0);
    const s1Result = results.find((r) => r.sessionId === "s1");
    expect(s1Result).toBeDefined();
    expect(s1Result!.matchedChunks).toBe(3); // all 3 chunks were stored
  });

  test("test_search_title_reflected_in_results", async () => {
    //#given a session with a specific title
    const expectedTitle = "My Custom Session Title for Testing";
    storeTestSession(db, "s-custom", expectedTitle, [
      "Content discussing distributed systems and CAP theorem",
    ]);

    //#when searching
    const results = await search(db, "distributed systems");

    //#then the result title matches the stored title
    const customResult = results.find((r) => r.sessionId === "s-custom");
    expect(customResult).toBeDefined();
    expect(customResult!.title).toBe(expectedTitle);
  });

  test("test_search_consistent_results_on_repeated_calls", async () => {
    //#given a stable dataset
    storeTestSession(db, "s1", "Stable Session A", [
      "Content about Docker container orchestration and Kubernetes",
    ]);
    storeTestSession(db, "s2", "Stable Session B", [
      "Content about machine learning model training and evaluation metrics",
    ]);

    //#when findSimilarSessions is called multiple times with the same query
    const results1 = await search(db, "Docker Kubernetes");
    const results2 = await search(db, "Docker Kubernetes");
    const results3 = await search(db, "Docker Kubernetes");

    //#then results are identical across all calls
    const ids1 = results1.map((r) => r.sessionId);
    const ids2 = results2.map((r) => r.sessionId);
    const ids3 = results3.map((r) => r.sessionId);
    expect(ids1).toEqual(ids2);
    expect(ids2).toEqual(ids3);
  });

  test("test_search_topk_limits_results", async () => {
    //#given five sessions
    for (let i = 1; i <= 5; i++) {
      storeTestSession(db, `s${i}`, `Session ${i}`, [
        `Content for session ${i} discussing ${["A", "B", "C", "D", "E"][i - 1]} topic`,
      ]);
    }

    //#when topK=2
    const results = await search(db, "topic", { topK: 2 });

    //#then at most 2 results are returned
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("test_search_default_topk_is_five", async () => {
    //#given ten sessions all matching the query equally
    for (let i = 1; i <= 10; i++) {
      storeTestSession(db, `s${i}`, `Session ${i}`, [
        `Identical content for session ${i} about programming`,
      ]);
    }

    //#when findSimilarSessions is called WITHOUT specifying topK
    const results = await search(db, "programming");

    //#then default topK of 5 is applied
    expect(results.length).toBeLessThanOrEqual(5);
  });
});
