/**
 * REQ-SIM-02 — Embeddings Storage
 *
 * Responsibilities:
 *   - Extract message chunks from SessionDetail (≥30 char text parts only)
 *   - Track last_indexed_message_id to avoid re-processing
 *   - Store embedding records in the DB
 */

import type { Database } from "bun:sqlite";
import type { SessionDetail } from "../core/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MessageChunk {
  sessionId: string;
  messageId: string;
  chunkText: string;
  role: string;
}

export interface EmbeddingRecord {
  sessionId: string;
  messageId: string;
  chunkText: string;
  embedding: number[];
}

export interface IndexState {
  sessionId: string;
  lastIndexedMessageId: string | null;
}

// ─── Chunk extraction ─────────────────────────────────────────────────────────

/**
 * Extract text chunks from a SessionDetail.
 *
 * Rules:
 *   - Only "text" parts are considered; tool/reasoning parts are skipped.
 *   - Empty text → excluded.
 *   - Text must be ≥ 30 characters (excludes 0–29; 30+ included).
 *   - System-role messages are excluded by default.
 */
export function extractChunks(detail: SessionDetail): MessageChunk[] {
  const chunks: MessageChunk[] = [];
  const messages = detail.messages ?? [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    const textParts = msg.parts?.filter((p) => p.type === "text") ?? [];
    if (textParts.length === 0) continue;

    // Join without extra spaces — concatenate parts as-is
    const combinedText = textParts
      .map((p) => (p as { text: string }).text)
      .join("")
      .trim();

    // Include only chunks with 30+ characters (0-29 excluded, 30+ included)
    if (combinedText.length <= 29) continue;

    chunks.push({
      sessionId: detail.id,
      messageId: msg.id,
      chunkText: combinedText,
      role: msg.role,
    });
  }

  return chunks;
}

// ─── Mock embedding (GREEN phase — no ML dependency) ─────────────────────────

const EMBEDDING_DIM = 384;

/**
 * Deterministic mock embedding: produces a stable float[384] vector from text.
 * Tests can replace this via module mocking (bun:mocks).
 * Production (REQ-SIM-04) will delegate to the configured provider.
 */
export function generateEmbedding(text: string): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const charCode = text.charCodeAt(i % text.length) || 0;
    embedding.push(Math.sin(charCode + i) * 0.5 + 0.5);
  }
  return embedding;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/**
 * Store (or upsert) embedding records into the session_vec shadow table.
 *
 * Uses INSERT OR REPLACE with a unique index on (session_id, message_id)
 * so that re-indexing the same message replaces the existing row — no duplicates.
 *
 * The session_vec table is created by initializeSimilarity (REQ-SIM-04):
 *   - With sqlite-vec: virtual table (handles its own upsert)
 *   - Shadow fallback: regular table (relies on our unique index)
 */
export function storeEmbeddings(db: Database, records: EmbeddingRecord[]): void {
  // Ensure unique index exists for correct upsert semantics
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vec_session_msg
      ON session_vec (session_id, message_id)
    `);
  } catch {
    // Index may already exist or vec virtual table handles it — ignore
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO session_vec (embedding, session_id, message_id, chunk_text)
    VALUES (?, ?, ?, ?)
  `);

  for (const record of records) {
    stmt.run(
      JSON.stringify(record.embedding),
      record.sessionId,
      record.messageId,
      record.chunkText
    );
  }
}

/**
 * Retrieve the last indexed message ID for a session.
 * Returns null if no indexing has been done yet.
 */
export function getLastIndexedMessageId(
  db: Database,
  sessionId: string
): string | null {
  const stmt = db.prepare(`
    SELECT message_id
    FROM session_vec
    WHERE session_id = ?
    ORDER BY rowid DESC
    LIMIT 1
  `);
  const row = stmt.get(sessionId) as { message_id: string } | undefined;
  return row?.message_id ?? null;
}

// ─── FTS helper ───────────────────────────────────────────────────────────────

/**
 * Index chunks into session_fts for keyword search (REQ-SIM-01).
 * Silently skips if the table does not exist (e.g., FTS5 unavailable).
 */
function indexFtsChunks(db: Database, chunks: MessageChunk[]): void {
  if (chunks.length === 0) return;
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fts_session_msg
      ON session_fts (session_id, message_id)
    `);
  } catch {
    // Ignore
  }
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO session_fts (session_id, message_id, chunk_text)
      VALUES (?, ?, ?)
    `);
    for (const chunk of chunks) {
      stmt.run(chunk.sessionId, chunk.messageId, chunk.chunkText);
    }
  } catch {
    // Table may not exist — skip silently
  }
}

// ─── Orchestration ────────────────────────────────────────────────────────────

/**
 * Full pipeline: extract chunks → filter already-indexed → embed → store.
 *
 * Incremental: uses getLastIndexedMessageId to skip messages that were already
 * indexed in a previous call. New messages appended to the session are processed;
 * already-stored messages are replaced (upsert, no duplicates).
 *
 * Returns IndexState with the updated lastIndexedMessageId.
 */
export function indexSessionEmbeddings(
  db: Database,
  detail: SessionDetail
): IndexState {
  const lastIndexed = getLastIndexedMessageId(db, detail.id);

  const allChunks = extractChunks(detail);

  // Filter to only NEW chunks — those at or after the last indexed message
  let foundLastIndexed = lastIndexed === null;
  const newChunks = allChunks.filter((chunk) => {
    if (foundLastIndexed) return true;
    if (chunk.messageId === lastIndexed) {
      foundLastIndexed = true;
      return true;
    }
    return false;
  });

  if (newChunks.length === 0) {
    return { sessionId: detail.id, lastIndexedMessageId: lastIndexed };
  }

  // Generate embeddings and store (sync — generateEmbedding is synchronous)
  const records: EmbeddingRecord[] = newChunks.map((chunk) => ({
    sessionId: chunk.sessionId,
    messageId: chunk.messageId,
    chunkText: chunk.chunkText,
    embedding: generateEmbedding(chunk.chunkText),
  }));

  storeEmbeddings(db, records);
  indexFtsChunks(db, newChunks);

  return {
    sessionId: detail.id,
    lastIndexedMessageId: newChunks[newChunks.length - 1]?.messageId ?? lastIndexed,
  };
}
