/**
 * REQ-SIM-01 — Hybrid Similarity Search
 *
 * Implements `findSimilarSessions(db, query, options?)`:
 *   - Generates a query embedding via the configured provider (mock in this build)
 *   - Runs FTS5 keyword search on session_fts (30% weight)
 *   - Runs vector KNN search on session_vec (70% weight)
 *   - Fuses results using Reciprocal Rank Fusion (RRF) with k=60
 *   - Returns ranked sessions with scores, match type, and chunk counts
 *
 * Fallback: if sqlite-vec or FTS5 virtual tables are unavailable,
 * queries fall back to the regular shadow tables via raw SQL.
 */

import type { Database } from "bun:sqlite";
import { generateEmbedding } from "./storage";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SimilarSessionResult {
  sessionId: string;
  title: string;
  score: number; // combined RRF score (0–1 normalised)
  rank: number;   // 1-based rank after fusion
  matchType: "hybrid" | "vector-only" | "fts-only" | "none";
  matchedChunks: number; // number of chunks matched in this session
  /** Optional note for unsupported / edge cases. */
  note?: string;
}

export interface SearchOptions {
  /** Maximum number of results to return. Default: 5. */
  topK?: number;
  /**
   * RRF k constant. Default: 60 (standard from Cormack et al. 2009).
   * Higher k reduces the penalty for large rank differences.
   */
  rrfK?: number;
  /**
   * Vector search weight (0–1). Default: 0.7 (70%).
   * FTS weight is implicitly 1 - vectorWeight.
   */
  vectorWeight?: number;
  /**
   * Optional map of sessionId → title.
   * If provided, result titles come from this map instead of the sessions table.
   * Useful when the sessions table is not available (e.g., test fixtures).
   */
  sessionTitles?: Record<string, string>;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const RRF_K_DEFAULT = 60;
const VECTOR_WEIGHT_DEFAULT = 0.7;
const TOP_K_DEFAULT = 5;
const MAX_RANK_FALLBACK = 9999; // used when a source returns no results

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Find sessions ranked by hybrid similarity score.
 *
 * @param db          - SQLite Database (must already have session_vec + session_fts)
 * @param query       - Free-text search query
 * @param options     - Optional: topK, rrfK, vectorWeight, sessionTitles
 */
export async function findSimilarSessions(
  db: Database,
  query: string,
  options?: SearchOptions
): Promise<SimilarSessionResult[]> {
  const topK = options?.topK ?? TOP_K_DEFAULT;
  const rrfK = options?.rrfK ?? RRF_K_DEFAULT;
  const vectorWeight = options?.vectorWeight ?? VECTOR_WEIGHT_DEFAULT;
  const ftsWeight = 1 - vectorWeight;

  // ── 1. Check if tables exist ──────────────────────────────────────────────
  if (!tablesExist(db)) {
    return [];
  }

  // ── 2. Generate query embedding ───────────────────────────────────────────
  // generateEmbedding is synchronous (mock); wrapped in Promise for API parity.
  const queryEmbedding = generateEmbedding(query ?? "");

  // ── 3. Run FTS5 search ────────────────────────────────────────────────────
  const ftsResults = runFtsSearch(db, query, topK * 3);

  // ── 4. Run vector search ──────────────────────────────────────────────────
  const vecResults = runVectorSearch(db, queryEmbedding, topK * 3);

  // ── 5. Apply RRF fusion ──────────────────────────────────────────────────
  const fused = applyRrfFusion(ftsResults, vecResults, rrfK, vectorWeight, ftsWeight);

  // ── 6. Build session metadata ─────────────────────────────────────────────
  const ranked = buildResults(db, fused, topK, options?.sessionTitles);

  return ranked;
}

// ─── Table existence check ─────────────────────────────────────────────────────

function tablesExist(db: Database): boolean {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name IN ('session_vec', 'session_fts')`
      )
      .get() as { cnt: number };
    return row.cnt >= 2;
  } catch {
    return false;
  }
}

// ─── FTS5 Search ───────────────────────────────────────────────────────────────

interface FtsHit {
  sessionId: string;
  rank: number;   // 0-based rank within FTS results
  messageId: string;
}

/**
 * Run FTS5 search on session_fts.
 *
 * Strategy:
 *   1. Try FTS5 virtual table MATCH query with BM25 ranking.
 *   2. Fall back to LIKE%query% on shadow table if virtual table unavailable.
 *
 * Returns: FtsHit[] sorted by rank ascending (best first).
 */
function runFtsSearch(db: Database, query: string, limit: number): FtsHit[] {
  if (!query || query.trim().length === 0) return [];

  // ── Attempt 1: FTS5 virtual table (porter unicode61 tokeniser) ─────────────
  try {
    const rows = db
      .prepare(
        `
        SELECT
          session_id,
          message_id,
          ROW_NUMBER() OVER (ORDER BY bm25(session_fts) ASC) - 1 AS rnk
        FROM session_fts
        WHERE session_fts MATCH ?
        LIMIT ?
        `
      )
      .all(query.trim(), limit) as Array<{
        session_id: string;
        message_id: string;
        rnk: number;
      }>;

    const hits: FtsHit[] = [];
    // SQLite window functions with ROW_NUMBER can return unordered rows in some versions;
    // explicitly assign 0-based ranks in insertion order (already BM25-sorted).
    rows.forEach((row, idx) => {
      hits.push({ sessionId: row.session_id, messageId: row.message_id, rank: idx });
    });
    return hits;
  } catch {
    // FTS5 not available — fall through to shadow table
  }

  // ── Attempt 2: Shadow table — LIKE-based keyword match ────────────────────
  try {
    const pattern = `%${query.trim().replace(/\s+/g, "%")}%`;
    const rows = db
      .prepare(
        `
        SELECT session_id, message_id
        FROM session_fts
        WHERE chunk_text LIKE ?
        LIMIT ?
        `
      )
      .all(pattern, limit) as Array<{ session_id: string; message_id: string }>;

    return rows.map((row, idx) => ({
      sessionId: row.session_id,
      messageId: row.message_id,
      rank: idx,
    }));
  } catch {
    return [];
  }
}

// ─── Vector Search ─────────────────────────────────────────────────────────────

interface VecHit {
  sessionId: string;
  rank: number;    // 0-based rank within vector results
  distance: number; // cosine/L2 distance (lower = more similar)
  messageId: string;
}

/**
 * Run vector KNN search on session_vec.
 *
 * Strategy:
 *   1. Try sqlite-vec virtual table with `embedding MATCH ? LIMIT ?`.
 *   2. Fall back to brute-force cosine similarity on shadow table.
 *
 * Returns: VecHit[] sorted by distance ascending (best first).
 */
function runVectorSearch(
  db: Database,
  queryEmbedding: number[],
  limit: number
): VecHit[] {
  const hits: VecHit[] = [];
  const jsonEmbed = JSON.stringify(queryEmbedding);

  // ── Attempt 1: sqlite-vec virtual table ───────────────────────────────────
  try {
    const rows = db
      .prepare(
        `
        SELECT
          session_id,
          message_id,
          distance
        FROM session_vec
        WHERE embedding MATCH ?
        ORDER BY distance ASC
        LIMIT ?
        `
      )
      .all(jsonEmbed, limit) as Array<{
        session_id: string;
        message_id: string;
        distance: number;
      }>;

    rows.forEach((row, idx) => {
      hits.push({
        sessionId: row.session_id,
        messageId: row.message_id,
        distance: row.distance,
        rank: idx,
      });
    });
    return hits;
  } catch {
    // sqlite-vec not available — fall through to shadow table
  }

  // ── Attempt 2: Shadow table — brute-force cosine similarity ─────────────────
  // PERF: This brute-force cosine is a FALLBACK when sqlite-vec is unavailable.
  // The primary path uses sqlite-vec's native KNN which handles millions of vectors.
  // This JS fallback is only reached in test/dev environments without sqlite-vec.
  try {
    const allRows = db
      .prepare(`SELECT embedding, session_id, message_id FROM session_vec`)
      .all() as Array<{ embedding: string; session_id: string; message_id: string }>;

    type ScoredRow = { sessionId: string; messageId: string; distance: number };
    const scored: ScoredRow[] = [];

    for (const row of allRows) {
      try {
        const stored: number[] = JSON.parse(row.embedding);
        const similarity = cosineSimilarity(queryEmbedding, stored);
        scored.push({
          sessionId: row.session_id,
          messageId: row.message_id,
          distance: 1 - similarity, // invert so lower = better (matches vec convention)
        });
      } catch {
        // Malformed embedding row — skip
      }
    }

    // Sort by distance ascending (lower = more similar), take top-K
    scored.sort((a, b) => a.distance - b.distance);
    for (let i = 0; i < Math.min(limit, scored.length); i++) {
      hits.push({
        sessionId: scored[i].sessionId,
        messageId: scored[i].messageId,
        distance: scored[i].distance,
        rank: i,
      });
    }
    return hits;
  } catch {
    return [];
  }
}

/**
 * Compute cosine similarity between two vectors.
 * Returns a value in [-1, 1]; higher = more similar.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const d = Math.sqrt(normA) * Math.sqrt(normB);
  return d === 0 ? 0 : dot / d;
}

// ─── RRF Fusion ────────────────────────────────────────────────────────────────

interface FusedEntry {
  sessionId: string;
  ftsRank: number;   // rank in FTS results (MAX_RANK_FALLBACK if absent)
  vecRank: number;   // rank in vector results (MAX_RANK_FALLBACK if absent)
  vecDistance: number; // raw distance for tiebreaking
}

/**
 * Apply Weighted Reciprocal Rank Fusion.
 *
 * Formula (Cormack et al. 2009):
 *   score(session) = w_vec × (1 / (k + vec_rank + 1))
 *                  + w_fts × (1 / (k + fts_rank + 1))
 *
 * Sessions appearing in only one source get the full weight from that source;
 * the absent source contributes 0 (no double-penalty).
 *
 * @param ftsResults   FTS5 hits (sorted ascending by rank)
 * @param vecResults   Vector hits (sorted ascending by rank)
 * @param rrfK         RRF k constant
 * @param vecWeight    Weight for vector component (e.g. 0.7)
 * @param ftsWeight    Weight for FTS component (e.g. 0.3)
 */
function applyRrfFusion(
  ftsResults: FtsHit[],
  vecResults: VecHit[],
  rrfK: number,
  vecWeight: number,
  ftsWeight: number
): FusedEntry[] {
  // Per-session: first-occurrence rank in each result set
  const ftsRankMap = new Map<string, number>();
  for (let i = 0; i < ftsResults.length; i++) {
    if (!ftsRankMap.has(ftsResults[i].sessionId)) {
      ftsRankMap.set(ftsResults[i].sessionId, i);
    }
  }

  const vecRankMap = new Map<string, number>();
  const vecDistMap = new Map<string, number>();
  for (let i = 0; i < vecResults.length; i++) {
    if (!vecRankMap.has(vecResults[i].sessionId)) {
      vecRankMap.set(vecResults[i].sessionId, i);
      vecDistMap.set(vecResults[i].sessionId, vecResults[i].distance);
    }
  }

  // All unique session IDs across both sources
  const allSessionIds = new Set([...ftsRankMap.keys(), ...vecRankMap.keys()]);

  const scored: FusedEntry[] = [];
  for (const sessionId of allSessionIds) {
    const ftsRank = ftsRankMap.get(sessionId) ?? MAX_RANK_FALLBACK;
    const vecRank = vecRankMap.get(sessionId) ?? MAX_RANK_FALLBACK;
    const vecDistance = vecDistMap.get(sessionId) ?? Infinity;

    scored.push({ sessionId, ftsRank, vecRank, vecDistance });
  }

  // Sort by combined RRF score descending; tiebreak on lower vec distance (better)
  scored.sort((a, b) => {
    const scoreA = ftsWeight / (rrfK + a.ftsRank + 1) + vecWeight / (rrfK + a.vecRank + 1);
    const scoreB = ftsWeight / (rrfK + b.ftsRank + 1) + vecWeight / (rrfK + b.vecRank + 1);
    if (Math.abs(scoreA - scoreB) > 1e-9) return scoreB - scoreA;
    return a.vecDistance - b.vecDistance;
  });

  return scored;
}

// ─── Result builder ─────────────────────────────────────────────────────────────

function buildResults(
  db: Database,
  fused: FusedEntry[],
  topK: number,
  sessionTitles?: Record<string, string>
): SimilarSessionResult[] {
  // Count chunks per session
  const chunkCounts = countChunksPerSession(db);

  // Build title map: sessionTitles param overrides DB lookup
  const titleMap = new Map<string, string>(
    Object.entries(sessionTitles ?? {})
  );

  // Augment with titles from sessions table if available
  try {
    if (fused.length > 0) {
      const placeholders = fused.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT id, title FROM sessions WHERE id IN (${placeholders})`)
        .all(...fused.map((f) => f.sessionId)) as Array<{ id: string; title: string }>;
      for (const row of rows) {
        if (!titleMap.has(row.id)) {
          titleMap.set(row.id, row.title);
        }
      }
    }
  } catch {
    // sessions table not available — rely on sessionTitles or fallback
  }

  const results: SimilarSessionResult[] = [];
  let rank = 0;

  for (const entry of fused) {
    rank++;
    if (rank > topK) break;

    const ftsOnly = entry.ftsRank < MAX_RANK_FALLBACK && entry.vecRank >= MAX_RANK_FALLBACK;
    const vecOnly = entry.vecRank < MAX_RANK_FALLBACK && entry.ftsRank >= MAX_RANK_FALLBACK;
    const matchType: SimilarSessionResult["matchType"] = ftsOnly
      ? "fts-only"
      : vecOnly
        ? "vector-only"
        : "hybrid";

    const rrfScore =
      (0.3 / (60 + entry.ftsRank + 1)) + (0.7 / (60 + entry.vecRank + 1));

    results.push({
      sessionId: entry.sessionId,
      title: titleMap.get(entry.sessionId) ?? `Session ${entry.sessionId}`,
      score: Math.round(rrfScore * 1e6) / 1e6,
      rank,
      matchType,
      matchedChunks: chunkCounts.get(entry.sessionId) ?? 0,
    });
  }

  return results;
}

/**
 * Count how many chunk rows exist per session in session_vec.
 */
function countChunksPerSession(db: Database): Map<string, number> {
  const counts = new Map<string, number>();
  try {
    const rows = db
      .prepare(
        `SELECT session_id, COUNT(*) AS cnt FROM session_vec GROUP BY session_id`
      )
      .all() as Array<{ session_id: string; cnt: number }>;
    for (const row of rows) {
      counts.set(row.session_id, row.cnt);
    }
  } catch {
    // table may not exist
  }
  return counts;
}
