/**
 * REQ-SIM-02 — Embeddings Storage
 *
 * RED phase: types + stub implementations that throw "not implemented".
 *
 * Responsibilities:
 *   - Extract message chunks from SessionDetail (≥30 char text parts only)
 *   - Track last_indexed_message_id to avoid re-processing
 *   - Store embedding records in the DB
 */

import type { Database } from "bun:sqlite";
import type { SessionDetail, SessionMessage } from "../core/types";

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
 *   - Text must be ≥ 30 characters.
 *   - System-role messages are excluded unless they contain meaningful content
 *     (i.e. ≥ 30 chars, which is already enforced by the min-length rule).
 */
export function extractChunks(detail: SessionDetail): MessageChunk[] {
  throw new Error("not implemented");
}

// ─── Embedding generation ─────────────────────────────────────────────────────

/**
 * Generate an embedding vector for the given text.
 * Provider is determined by the similarity config (local / api).
 */
export function generateEmbedding(text: string): Promise<number[]> {
  throw new Error("not implemented");
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/**
 * Store (or upsert) embedding records into the session_vec table.
 * Re-indexing the same session replaces existing chunks (no duplicates).
 */
export function storeEmbeddings(db: Database, records: EmbeddingRecord[]): void {
  throw new Error("not implemented");
}

/**
 * Retrieve the last indexed message ID for a session.
 * Returns null if no indexing has been done yet.
 */
export function getLastIndexedMessageId(
  db: Database,
  sessionId: string
): string | null {
  throw new Error("not implemented");
}

// ─── Orchestration ────────────────────────────────────────────────────────────

/**
 * Full pipeline: extract chunks → generate embeddings → store.
 * Uses getLastIndexedMessageId to skip already-indexed messages (incremental).
 *
 * Returns IndexState with the new lastIndexedMessageId.
 */
export function indexSessionEmbeddings(
  db: Database,
  detail: SessionDetail
): IndexState {
  throw new Error("not implemented");
}