/**
 * REQ-SIM-04 — SimilarityConfig: configuration parsing & DB initialization
 *
 * GREEN phase: real implementation driven by tests.
 */

import type { Database } from "bun:sqlite";

export type EmbeddingProvider = "local" | "api";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
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

// ─── env helpers ──────────────────────────────────────────────────────────────

function envBool(key: string): boolean | undefined {
  const val = Bun.env[key];
  if (val === undefined) return undefined;
  return val === "true" || val === "1";
}

function envString(key: string): string | undefined {
  return Bun.env[key];
}

function envInt(key: string): number | undefined {
  const val = Bun.env[key];
  if (val === undefined) return undefined;
  const n = Number(val);
  return Number.isInteger(n) ? n : undefined;
}

// ─── parseSimilarityConfig ────────────────────────────────────────────────────

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
export function parseSimilarityConfig(raw: RawSimilarityConfig): SimilarityConfig {
  const rawSim: unknown = raw["similarity"];

  // YAML null → treat as absent
  if (rawSim === null || rawSim === undefined) {
    return buildConfig({}, {});
  }

  if (typeof rawSim !== "object") {
    // e.g. a scalar — treat as absent
    return buildConfig({}, {});
  }

  const fileSim = rawSim as Record<string, unknown>;
  return buildConfig(fileSim, {});
}

type FileSim = Record<string, unknown>;

function buildConfig(file: FileSim, _env: Record<string, unknown>): SimilarityConfig {
  // ── enabled ──────────────────────────────────────────────────────────────────
  const enabled = envBool("SIMILARITY_ENABLED") ?? toBool(file["enabled"]) ?? false;

  // ── embeddingProvider ────────────────────────────────────────────────────────
  const rawProvider =
    envString("SIMILARITY_EMBEDDING_PROVIDER") ?? toStr(file["embeddingProvider"]);
  const provider = normaliseProvider(rawProvider);

  // ── topK ─────────────────────────────────────────────────────────────────────
  // NOTE: topK from file is _not_ coerced from string (string = validation error).
  // topK from env IS coerced via envInt() which accepts "20" → 20.
  const topK = validateTopK(envInt("SIMILARITY_TOPK") ?? file["topK"]);

  // ── vectorDimension ─────────────────────────────────────────────────────────
  // Pass raw value so validateVectorDimension can reject strings explicitly.
  const vectorDimension = validateVectorDimension(file["vectorDimension"]);

  // ── apiEndpoint ─────────────────────────────────────────────────────────────
  const apiEndpoint =
    envString("SIMILARITY_API_ENDPOINT") ?? toStr(file["apiEndpoint"]);

  return {
    enabled,
    embeddingProvider: provider,
    topK,
    ...(vectorDimension !== undefined ? { vectorDimension } : {}),
    ...(apiEndpoint !== undefined ? { apiEndpoint } : {}),
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function toBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

function toStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  return undefined;
}

/** Coerce to number. Returns undefined for non-number types (strings etc.). */
function toNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function normaliseProvider(raw: string | undefined): EmbeddingProvider {
  if (raw === undefined || raw === "") return "local";
  if (raw === "local" || raw === "api") return raw;
  throw new ConfigValidationError(
    `embeddingProvider must be "local" or "api"; got "${raw}"`
  );
}

/**
 * Validate topK value.
 * Accepts a raw value which may be: number (from envInt coercion) or any file value.
 * Rejects: undefined (→ defaults to 5), non-integers, out-of-range, strings.
 */
function validateTopK(raw: unknown): number {
  if (raw === undefined) return 5;
  if (typeof raw === "string") {
    // String from file config is a validation error (env strings are pre-coerced).
    throw new ConfigValidationError(
      `topK must be a positive integer between 1 and 1000; got ${JSON.stringify(raw)}`
    );
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 1000) {
    throw new ConfigValidationError(
      `topK must be a positive integer between 1 and 1000; got ${raw}`
    );
  }
  return raw;
}

function validateVectorDimension(
  raw: unknown
): 384 | 768 | 1536 | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") {
    throw new ConfigValidationError(
      `vectorDimension must be 384, 768, or 1536; got ${JSON.stringify(raw)}`
    );
  }
  if (typeof raw === "number") {
    if (raw === 384 || raw === 768 || raw === 1536) return raw as 384 | 768 | 1536;
    throw new ConfigValidationError(
      `vectorDimension must be 384, 768, or 1536; got ${raw}`
    );
  }
  throw new ConfigValidationError(
    `vectorDimension must be 384, 768, or 1536; got ${raw}`
  );
}

// ─── initializeSimilarity ───────────────────────────────────────────────────

/**
 * Initialise the similarity subsystem:
 *   - If `cfg.enabled === false` → no-op (return early)
 *   - Idempotent: creates `session_vec` and `session_fts` virtual tables
 *   - `session_vec` uses sqlite-vec (vec0); if the extension is not available,
 *     falls back to a regular shadow table so tests run in environments without vec.
 *   - `session_fts` uses SQLite FTS5; also falls back gracefully if unavailable.
 */
export function initializeSimilarity(db: Database, cfg: SimilarityConfig): void {
  if (!cfg.enabled) return;

  const dim = cfg.vectorDimension ?? 384;

  // ── session_vec ──────────────────────────────────────────────────────────────
  // Try sqlite-vec virtual table first; fall back to a regular shadow table.
  // Both paths are wrapped in try/catch so this function is safe for read-only DBs.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_vec USING vec0(
        embedding float[${dim}],
        session_id TEXT,
        message_id TEXT,
        chunk_text TEXT
      )
    `);
  } catch (_err) {
    // sqlite-vec not available OR DB is read-only — try shadow table
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_vec (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          embedding   TEXT,
          session_id  TEXT,
          message_id  TEXT,
          chunk_text  TEXT
        )
      `);
    } catch {
      // DB is read-only and vec is unavailable — skip silently
    }
  }

  // ── session_fts ──────────────────────────────────────────────────────────────
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        session_id,
        message_id,
        chunk_text,
        tokenize='porter unicode61'
      )
    `);
  } catch (_err) {
    // FTS5 unavailable OR DB is read-only — try shadow table
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_fts (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id  TEXT,
          message_id  TEXT,
          chunk_text  TEXT
        )
      `);
    } catch {
      // DB is read-only and FTS5 unavailable — skip silently
    }
  }
}
