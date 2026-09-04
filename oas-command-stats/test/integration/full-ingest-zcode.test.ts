/**
 * Integration — happy path full ingest cycle for zcode.
 *
 * zcode event_id = tool_usage.id (SQLite primary key, stable).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractEvents } from "../../src/extract/registry";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb } from "../../src/storage/duckdb";
import type { SessionDetail } from "@open-agent-sessions/sdk";

const DB_PATH = join(tmpdir(), `oas-cs-zc-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("full ingest cycle — zcode (happy path)", () => {
  it("three_tool_usages_three_outbox_three_events", async () => {
    // zcode SessionDetail — tool calls have stable tool_usage.id.
    const detail: SessionDetail = {
      id: "sess_zcode_test",
      agent: "zcode",
      alias: "default",
      title: "zc happy",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:02Z",
      message_count: 3,
      storage: "db",
      messages: [
        { id: "m1", role: "assistant", created_at: "2026-01-01T00:00:00Z",
          parts: [{ type: "tool", tool: "bash",
            state: { id: "tu-001", command: "echo a", cwd: "/tmp" } } as any] },
        { id: "m2", role: "assistant", created_at: "2026-01-01T00:00:01Z",
          parts: [{ type: "tool", tool: "bash",
            state: { id: "tu-002", command: "echo b", cwd: "/tmp" } } as any] },
        { id: "m3", role: "assistant", created_at: "2026-01-01T00:00:02Z",
          parts: [{ type: "tool", tool: "bash",
            state: { id: "tu-003", command: "ls", cwd: "/tmp" } } as any] },
      ],
    };

    const events = extractEvents(detail, { session_db_path: "/home/x/.zcode/cli/db/db.sqlite" });
    expect(events.length).toBe(3);
    // event_id derivation: zcode = tool_usage.id (stable).
    expect(events.map(e => e.event_id).sort()).toEqual(["tu-001", "tu-002", "tu-003"]);

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
