/**
 * REQ-SIM-04 — SimilarityConfig: configuration parsing & DB initialization
 *
 * GREEN phase: real implementation driven by tests.
 */
import type { Database } from "bun:sqlite";
export type EmbeddingProvider = "local" | "api";
export declare class ConfigValidationError extends Error {
    constructor(message: string);
}
/** Raw parsed YAML map passed to parseSimilarityConfig */
export type RawSimilarityConfig = Record<string, unknown>;
export interface SimilarityConfig {
    enabled: boolean;
    embeddingProvider: EmbeddingProvider;
    topK: number;
    vectorDimension?: 384 | 768 | 1536;
    apiEndpoint?: string;
}
/**
 * Parse raw YAML config → typed SimilarityConfig.
 *
 * Priority (highest first):
 *   1. SIMILARITY_ENABLED / SIMILARITY_EMBEDDING_PROVIDER / SIMILARITY_TOPK env vars
 *   2. File config (raw.similarity)
 *   3. Sensible defaults
 *
 * Validation:
 *   - embeddingProvider: "local" | "api" (empty/undefined → "local")
 *   - topK: integer, 1 ≤ topK ≤ 1000  (string values are rejected with ConfigValidationError)
 *   - vectorDimension: 384 | 768 | 1536 (optional; string values are rejected)
 *   - Unknown fields are silently ignored
 *   - YAML null (similarity: ~) → treated as absent (all defaults)
 */
export declare function parseSimilarityConfig(raw: RawSimilarityConfig): SimilarityConfig;
/**
 * Initialise the similarity subsystem:
 *   - If `cfg.enabled === false` → no-op (return early)
 *   - Idempotent: creates `session_vec` and `session_fts` virtual tables
 *   - `session_vec` uses sqlite-vec (vec0); if the extension is not available,
 *     falls back to a regular shadow table so tests run in environments without vec.
 *   - `session_fts` uses SQLite FTS5; also falls back gracefully if unavailable.
 */
export declare function initializeSimilarity(db: Database, cfg: SimilarityConfig): void;
