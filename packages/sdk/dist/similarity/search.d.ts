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
export interface SimilarSessionResult {
    sessionId: string;
    title: string;
    score: number;
    rank: number;
    matchType: "hybrid" | "vector-only" | "fts-only" | "none";
    matchedChunks: number;
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
/**
 * Find sessions ranked by hybrid similarity score.
 *
 * @param db          - SQLite Database (must already have session_vec + session_fts)
 * @param query       - Free-text search query
 * @param options     - Optional: topK, rrfK, vectorWeight, sessionTitles
 */
export declare function findSimilarSessions(db: Database, query: string, options?: SearchOptions): Promise<SimilarSessionResult[]>;
