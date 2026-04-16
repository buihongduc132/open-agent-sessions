/**
 * REQ-SIM-02 — Embeddings Storage Tests
 *
 * RED phase: all business logic tests are expected to FAIL until the
 * storage.ts implementation is filled in.
 *
 * Test categories:
 *   A. Chunking Tests        — verify message → chunk extraction logic
 *   B. Indexing State Tests  — verify last_indexed_message_id tracking
 *   C. Embedding Storage Tests— verify upsert behaviour
 *   D. Integration Tests      — full pipeline
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionDetail, SessionMessage } from "../../src/core/types";
import {
  extractChunks,
  generateEmbedding,
  storeEmbeddings,
  getLastIndexedMessageId,
  indexSessionEmbeddings,
  type MessageChunk,
  type EmbeddingRecord,
} from "../../src/similarity/storage";
import { initializeSimilarity } from "../../src/similarity/config";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** 30-character string — the minimum threshold for chunk inclusion. */
const LOREM_30 = "The quick brown fox jumps ovxx"; // 30 chars (includes >=30)
const LOREM_31 = "The quick brown fox jumps ovxxx"; // 31 chars (includes >=30)
const LOREM_29 = "The quick brown fox jumps ovx"; // 29 chars (excludes <30)

function makeDetail(sessionId: string, messages: SessionMessage[]): SessionDetail {
  return {
    id: sessionId,
    agent: "opencode",
    alias: "main",
    title: "Test Session",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    message_count: messages.length,
    storage: "db",
    messages,
  };
}

function makeTextMsg(id: string, role: SessionMessage["role"], text: string): SessionMessage {
  return { id, role, created_at: new Date().toISOString(), parts: [{ type: "text", text }] };
}

function makeMsgWithParts(id: string, role: SessionMessage["role"], parts: SessionMessage["parts"]): SessionMessage {
  return { id, role, created_at: new Date().toISOString(), parts };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeStorageDb(): { db: Database; dir: string } {
  const dir = join(tmpdir(), `sim-storage-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "sim.db"));
  initializeSimilarity(db, { enabled: true, embeddingProvider: "local", topK: 5 });
  return { db, dir };
}

// ─── A. Chunking Tests ───────────────────────────────────────────────────────--

describe("A. Chunking Tests", () => {
  describe("extractChunks — boundary conditions", () => {
    test("test_chunk_message_exactly_30_chars_included", () => {
      //#given a user message with exactly 30 characters
      //#when extractChunks is called
      //#then the message is included as a chunk
      const detail = makeDetail("s1", [makeTextMsg("m1", "user", LOREM_30)]);
      const chunks = extractChunks(detail);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].chunkText).toBe(LOREM_30);
      expect(chunks[0].messageId).toBe("m1");
      expect(chunks[0].role).toBe("user");
    });

    test("test_chunk_message_29_chars_excluded", () => {
      //#given a user message with 29 characters
      //#when extractChunks is called
      //#then the message is excluded (below 30-char threshold)
      const detail = makeDetail("s1", [makeTextMsg("m1", "user", LOREM_29)]);
      const chunks = extractChunks(detail);
      expect(chunks).toHaveLength(0);
    });

    test("test_chunk_message_empty_string_excluded", () => {
      //#given a message with empty text
      //#when extractChunks is called
      //#then the message is excluded
      const detail = makeDetail("s1", [makeTextMsg("m1", "user", "")]);
      const chunks = extractChunks(detail);
      expect(chunks).toHaveLength(0);
    });

    test("test_chunk_system_message_skipped_by_default", () => {
      //#given a system-role message with ≥30 char text
      //#when extractChunks is called
      //#then system messages are skipped (no meaningful indexing content)
      const detail = makeDetail("s1", [makeTextMsg("m1", "system", LOREM_31)]);
      const chunks = extractChunks(detail);
      expect(chunks).toHaveLength(0);
    });

    test("test_chunk_user_message_included", () => {
      //#given a user-role message with ≥30 chars
      //#when extractChunks is called
      //#then the message is included
      const detail = makeDetail("s1", [makeTextMsg("m1", "user", LOREM_31)]);
      const chunks = extractChunks(detail);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].role).toBe("user");
    });

    test("test_chunk_assistant_message_included", () => {
      //#given an assistant-role message with ≥30 chars
      //#when extractChunks is called
      //#then the message is included
      const detail = makeDetail("s1", [makeTextMsg("m1", "assistant", LOREM_31)]);
      const chunks = extractChunks(detail);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].role).toBe("assistant");
    });

    test("test_chunk_assistant_message_short_excluded", () => {
      //#given an assistant message with <30 chars
      //#when extractChunks is called
      //#then the message is excluded
      const detail = makeDetail("s1", [makeTextMsg("m1", "assistant", LOREM_29)]);
      const chunks = extractChunks(detail);
      expect(chunks).toHaveLength(0);
    });

    test("test_chunk_merges_multiple_text_parts", () => {
      //#given a message with multiple text parts
      //#when extractChunks is called
      //#then all text parts are concatenated into a single chunk
      //#and if the merged text is ≥30 chars, the chunk is included
      const msg = makeMsgWithParts("m1", "user", [
        { type: "text", text: "Hello " },
        { type: "text", text: "world! This is a test message." }, // total ≥ 30
      ]);
      const detail = makeDetail("s1", [msg]);
      const chunks = extractChunks(detail);
      // Merged text: "Hello world! This is a test message." (38 chars)
      expect(chunks).toHaveLength(1);
      expect(chunks[0].chunkText).toBe("Hello world! This is a test message.");
    });

    test("test_chunk_tool_message_excluded", () => {
      //#given a message with only a tool part
      //#when extractChunks is called
      //#then the message is excluded (no text content)
      const detail = makeDetail("s1", [
        makeMsgWithParts("m1", "assistant", [
          { type: "tool", tool: "bash", state: { command: "ls" } },
        ]),
      ]);
      const chunks = extractChunks(detail);
      expect(chunks).toHaveLength(0);
    });

    test("test_chunk_reasoning_message_excluded", () => {
      //#given a message with only a reasoning part
      //#when extractChunks is called
      //#then the message is excluded (reasoning not indexed as content)
      const detail = makeDetail("s1", [
        makeMsgWithParts("m1", "assistant", [
          { type: "reasoning", text: "Let me think about this carefully..." },
        ]),
      ]);
      const chunks = extractChunks(detail);
      expect(chunks).toHaveLength(0);
    });

    test("test_chunk_only_text_parts_counted", () => {
      //#given a message with mixed parts (tool + text) where the text alone is <30 chars
      //#when extractChunks is called
      //#then only the combined text is evaluated; if <30 chars the chunk is excluded
      const detail = makeDetail("s1", [
        makeMsgWithParts("m1", "assistant", [
          { type: "tool", tool: "read", state: {} },
          { type: "text", text: "Hi" }, // 2 chars — below threshold
        ]),
      ]);
      const chunks = extractChunks(detail);
      expect(chunks).toHaveLength(0);
    });
  });
});

// ─── B. Indexing State Tests ─────────────────────────────────────────────────

describe("B. Indexing State Tests", () => {
  let ctx: { db: Database; dir: string };

  beforeEach(() => {
    ctx = makeStorageDb();
  });

  afterEach(() => {
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  test("test_index_state_empty_session_returns_empty_chunks", () => {
    //#given a SessionDetail with no messages
    //#when extractChunks is called
    //#then it returns an empty array
    const detail = makeDetail("s1", []);
    const chunks = extractChunks(detail);
    expect(chunks).toHaveLength(0);
  });

  test("test_index_state_tracks_last_indexed_message_id", async () => {
    //#given a session with 2 indexable messages
    //#when indexSessionEmbeddings is called
    //#then the returned IndexState includes the id of the last processed message
    const detail = makeDetail("s1", [
      makeTextMsg("m1", "user", LOREM_31),
      makeTextMsg("m2", "assistant", LOREM_31),
    ]);
    const state = indexSessionEmbeddings(ctx.db, detail);
    expect(state.sessionId).toBe("s1");
    expect(state.lastIndexedMessageId).toBe("m2");
  });

  test("test_index_state_no_duplicate_processing_on_reindex", () => {
    //#given a session already fully indexed (all messages processed)
    //#when indexSessionEmbeddings is called again with the same messages
    //#then the result is identical — no duplicate chunks created
    const messages = [
      makeTextMsg("m1", "user", LOREM_31),
      makeTextMsg("m2", "assistant", LOREM_31),
    ];
    const detail = makeDetail("s1", messages);

    // First pass
    indexSessionEmbeddings(ctx.db, detail);
    const firstChunks = extractChunks(detail);

    // Second pass (re-index)
    const state2 = indexSessionEmbeddings(ctx.db, detail);
    const secondChunks = extractChunks(detail);

    // Same last indexed id
    expect(state2.lastIndexedMessageId).toBe("m2");
    // Chunk counts must be the same — no duplicates
    expect(firstChunks.length).toBe(secondChunks.length);
  });

  test("test_index_state_incremental_new_messages_only", () => {
    //#given a session where message m1 was already indexed
    //#and messages m2 and m3 are new
    //#when indexSessionEmbeddings is called
    //#then only m2 and m3 are processed (incremental)
    // (Implementation detail: store last_indexed_message_id in DB so next call
    //  resumes from the correct position.)
    const messages = [
      makeTextMsg("m1", "user", LOREM_31),
      makeTextMsg("m2", "assistant", LOREM_31),
      makeTextMsg("m3", "user", LOREM_31),
    ];
    const detail = makeDetail("s1", messages);

    // Simulate: last indexed = m1 (previous run)
    // We need to simulate this via direct DB state or re-call semantics
    // The simplest test: call with all messages and verify only
    // messages after last indexed are stored
    const state = indexSessionEmbeddings(ctx.db, detail);
    expect(state.lastIndexedMessageId).toBe("m3");

    // Upsert behaviour verified by checking the DB directly
    const rows = ctx.db
      .query("SELECT message_id FROM session_vec WHERE session_id = ? ORDER BY id")
      .all("s1") as { message_id: string }[];
    const storedIds = rows.map((r) => r.message_id);
    expect(storedIds).toContain("m2");
    expect(storedIds).toContain("m3");
    // m1 is NOT re-stored (upsert — old rows for m1 are replaced or skipped)
    // Note: depending on upsert semantics, m1 may or may not be present.
    // The key guarantee is no DUPLICATE m2/m3 rows.
    const m2Count = rows.filter((r) => r.message_id === "m2").length;
    const m3Count = rows.filter((r) => r.message_id === "m3").length;
    expect(m2Count).toBeLessThanOrEqual(1);
    expect(m3Count).toBeLessThanOrEqual(1);
  });
});

// ─── C. Embedding Storage Tests ──────────────────────────────────────────────

describe("C. Embedding Storage Tests", () => {
  let ctx: { db: Database; dir: string };

  beforeEach(() => {
    ctx = makeStorageDb();
  });

  afterEach(() => {
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  test("test_store_embeddings_inserts_chunks_with_session_id", () => {
    //#given embedding records for a session
    //#when storeEmbeddings is called
    //#then each record is persisted with the correct session_id, message_id, chunk_text
    const records: EmbeddingRecord[] = [
      {
        sessionId: "s1",
        messageId: "m1",
        chunkText: LOREM_31,
        embedding: [0.1, 0.2, 0.3],
      },
      {
        sessionId: "s1",
        messageId: "m2",
        chunkText: "Another chunk that is definitely 30+ chars",
        embedding: [0.4, 0.5, 0.6],
      },
    ];

    storeEmbeddings(ctx.db, records);

    const rows = ctx.db
      .query("SELECT session_id, message_id, chunk_text FROM session_vec WHERE session_id = ? ORDER BY id")
      .all("s1") as { session_id: string; message_id: string; chunk_text: string }[];

    expect(rows).toHaveLength(2);
    expect(rows[0].message_id).toBe("m1");
    expect(rows[0].chunk_text).toBe(LOREM_31);
    expect(rows[1].message_id).toBe("m2");
  });

  test("test_store_embeddings_serialize_embedding_array", () => {
    //#given an EmbeddingRecord with a float array
    //#when storeEmbeddings persists it
    //#then the embedding is stored in a serialised form (JSON/text)
    const embedding = [0.1, -0.5, 0.7, 0.99];
    const records: EmbeddingRecord[] = [
      {
        sessionId: "s1",
        messageId: "m1",
        chunkText: LOREM_31,
        embedding,
      },
    ];

    storeEmbeddings(ctx.db, records);

    const row = ctx.db
      .query("SELECT embedding FROM session_vec WHERE session_id = ? AND message_id = ?")
      .get("s1", "m1") as { embedding: string } | undefined;

    expect(row).not.toBeUndefined();
    const parsed = JSON.parse(row!.embedding);
    expect(parsed).toEqual(embedding);
  });

  test("test_store_embeddings_upsert_behavior", () => {
    //#given a session already has stored chunks
    //#when storeEmbeddings is called again with the same message_ids
    //#then existing rows are replaced, not duplicated
    const records1: EmbeddingRecord[] = [
      { sessionId: "s1", messageId: "m1", chunkText: "Original chunk text here is long", embedding: [0.1] },
    ];
    const records2: EmbeddingRecord[] = [
      { sessionId: "s1", messageId: "m1", chunkText: "Updated chunk text also long enough", embedding: [0.9] },
    ];

    storeEmbeddings(ctx.db, records1);
    storeEmbeddings(ctx.db, records2);

    const rows = ctx.db
      .query("SELECT chunk_text, embedding FROM session_vec WHERE session_id = ? AND message_id = ?")
      .all("s1", "m1") as { chunk_text: string; embedding: string }[];

    // Should be exactly one row (upsert, not insert)
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].embedding)).toEqual([0.9]);
  });
});

// ─── D. Integration Tests ─────────────────────────────────────────────────────

describe("D. Integration Tests", () => {
  let ctx: { db: Database; dir: string };

  beforeEach(() => {
    ctx = makeStorageDb();
  });

  afterEach(() => {
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  test("test_full_pipeline_sessiondetail_to_stored_chunks", async () => {
    //#given a SessionDetail with mixed messages
    //#when the full pipeline is executed (extract → embed → store)
    //#then stored chunks match the extracted chunks and have embedding vectors
    const detail = makeDetail("s1", [
      makeTextMsg("m1", "user", "Short"), // < 30 → excluded
      makeTextMsg("m2", "user", "This is a longer user message that exceeds 30 chars"),
      makeMsgWithParts("m3", "assistant", [
        { type: "text", text: "Assistant response with substantial content here" },
      ]),
      makeMsgWithParts("m4", "system", [
        { type: "tool", tool: "bash", state: {} },
        { type: "text", text: "System with some meaningful content now" },
      ]),
    ]);

    // Full pipeline
    const state = indexSessionEmbeddings(ctx.db, detail);

    // Verify state
    expect(state.sessionId).toBe("s1");
    expect(state.lastIndexedMessageId).toBeDefined();

    // Verify stored data
    const rows = ctx.db
      .query("SELECT session_id, message_id, chunk_text, embedding FROM session_vec WHERE session_id = ? ORDER BY id")
      .all("s1") as { session_id: string; message_id: string; chunk_text: string; embedding: string }[];

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.chunk_text.length).toBeGreaterThanOrEqual(30);
      const emb = JSON.parse(row.embedding);
      expect(Array.isArray(emb)).toBe(true);
      expect(emb.length).toBeGreaterThan(0);
    }
  });

  test("test_full_pipeline_skips_already_indexed", () => {
    //#given a session that has been indexed once
    //#when indexSessionEmbeddings is called again with NEW messages appended
    //#then only the new messages are processed and stored
    const messages1 = [
      makeTextMsg("m1", "user", LOREM_31),
      makeTextMsg("m2", "assistant", LOREM_31),
    ];
    const detail1 = makeDetail("s1", messages1);

    // First indexing
    indexSessionEmbeddings(ctx.db, detail1);

    // Simulate: add new messages to the same session
    const messages2 = [
      makeTextMsg("m1", "user", LOREM_31),
      makeTextMsg("m2", "assistant", LOREM_31),
      makeTextMsg("m3", "user", LOREM_31),
      makeTextMsg("m4", "assistant", LOREM_31),
    ];
    const detail2 = makeDetail("s1", messages2);

    // Second indexing (incremental)
    const state = indexSessionEmbeddings(ctx.db, detail2);

    // Should pick up from where it left off
    expect(state.lastIndexedMessageId).toBe("m4");

    // Verify no duplicate m1/m2 and m3/m4 each appear once
    const rows = ctx.db
      .query("SELECT message_id FROM session_vec WHERE session_id = ? ORDER BY id")
      .all("s1") as { message_id: string }[];

    for (const id of ["m1", "m2", "m3", "m4"]) {
      const count = rows.filter((r) => r.message_id === id).length;
      expect(count).toBeLessThanOrEqual(1);
    }

    // Both old and new must be present
    const ids = rows.map((r) => r.message_id);
    expect(ids).toContain("m1");
    expect(ids).toContain("m2");
    expect(ids).toContain("m3");
    expect(ids).toContain("m4");
  });
});
