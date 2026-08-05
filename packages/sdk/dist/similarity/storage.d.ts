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
/**
 * Extract text chunks from a SessionDetail.
 *
 * Rules:
 *   - Only "text" parts are considered; tool/reasoning parts are skipped.
 *   - Empty text → excluded.
 *   - Text must be ≥ 30 characters (excludes 0–29; 30+ included).
 *   - System-role messages are excluded by default.
 */
export declare function extractChunks(detail: SessionDetail): MessageChunk[];
/**
 * Deterministic mock embedding: produces a stable float[384] vector from text.
 * Tests can replace this via module mocking (bun:mocks).
 * Production (REQ-SIM-04) will delegate to the configured provider.
 */
export declare function generateEmbedding(text: string): number[];
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
export declare function storeEmbeddings(db: Database, records: EmbeddingRecord[]): void;
/**
 * Retrieve the last indexed message ID for a session.
 * Returns null if no indexing has been done yet.
 */
export declare function getLastIndexedMessageId(db: Database, sessionId: string): string | null;
/**
 * Full pipeline: extract chunks → filter already-indexed → embed → store.
 *
 * Incremental: uses getLastIndexedMessageId to skip messages that were already
 * indexed in a previous call. New messages appended to the session are processed;
 * already-stored messages are replaced (upsert, no duplicates).
 *
 * Returns IndexState with the updated lastIndexedMessageId.
 */
export declare function indexSessionEmbeddings(db: Database, detail: SessionDetail): IndexState;
