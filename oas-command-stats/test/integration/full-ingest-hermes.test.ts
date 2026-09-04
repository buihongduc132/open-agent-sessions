/**
 * Integration — happy path full ingest cycle for hermes.
 *
 * hermes event_id = synthetic (hash of message_id + tool_call_idx + session_id).
 * Stable across re-ingest as long as message_id + tool_call_idx unchanged.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractEvents } from "../../src/extract/registry";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb } from "../../src/storage/duckdb";
import type { SessionDetail } from "@open-agent-sessions/sdk";

const DB_PATH = join(tmpdir(), `oas-cs-hermes-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("full ingest cycle — hermes (happy path)", () => {
  it("three_tool_calls_three_outbox_three_events_synthetic_id", async () => {
    const detail: SessionDetail = {
      id: "hermes-sess-uuid",
      agent: "hermes",
      alias: "default",
      title: "hermes happy",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:02Z",
      message_count: 1,
      storage: "db",
      messages: [
        // One message with 3 tool calls — synthetic id must distinguish them.
        { id: "msg-uuid-001", role: "assistant", created_at: "2026-01-01T00:00:00Z",
          parts: [
            { type: "tool", tool: "bash",
              state: { command: "echo a", cwd: "/tmp" } } as any,
            { type: "tool", tool: "bash",
              state: { command: "echo b", cwd: "/tmp" } } as any,
            { type: "tool", tool: "bash",
              state: { command: "echo c", cwd: "/tmp" } } as any,
          ],
        },
      ],
    };

    const events = extractEvents(detail, { session_db_path: "/home/x/.hermes/state.db" });
    expect(events.length).toBe(3);
    // All 3 event_ids must be DISTINCT (synthetic derivation includes tool_call_idx).
    const ids = events.map(e => e.event_id);
    expect(new Set(ids).size).toBe(3);
    // Stable across re-extract.
    const events2 = extractEvents(detail, { session_db_path: "/home/x/.hermes/state.db" });
    expect(events2.map(e => e.event_id)).toEqual(ids);

    const db = await openDb(DB_PATH);
    const r = await ingestBatch(db, events);
    expect(r.committed).toBe(3);
    const ob = await db.all("SELECT COUNT(*) AS n FROM outbox");
    const ce = await db.all("SELECT COUNT(*) AS n FROM cmd_events");
    expect(ob[0].n).toBe(3);
    expect(ce[0].n).toBe(3);
    await db.close();
  });
});
