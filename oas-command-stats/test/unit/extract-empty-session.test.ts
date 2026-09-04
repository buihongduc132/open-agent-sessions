/**
 * Zone 1 (empty/nil) — empty SessionDetail yields zero outbox rows.
 *
 * A SessionDetail with no messages / no tool calls must NOT crash extraction
 * and must produce exactly 0 outbox rows.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractEvents } from "../../src/extract/registry";
import { openDb } from "../../src/storage/duckdb";
import type { SessionDetail } from "@open-agent-sessions/sdk";

const DB_PATH = join(tmpdir(), `oas-cs-empty-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("extract empty session (Zone 1)", () => {
  it("session_with_no_messages_yields_zero_events", async () => {
    const emptyDetail: SessionDetail = {
      id: "empty-sess",
      agent: "pi",
      alias: "test",
      title: "empty",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      message_count: 0,
      storage: "jsonl",
      messages: [],
    };

    const events = extractEvents(emptyDetail, { session_file_path: "/tmp/empty.jsonl" });
    expect(events).toEqual([]);
  });

  it("session_with_messages_but_no_tool_calls_yields_zero_events", () => {
    const detail: SessionDetail = {
      id: "no-tools",
      agent: "pi",
      alias: "test",
      title: "chat only",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      message_count: 2,
      storage: "jsonl",
      messages: [
        { id: "m1", role: "user", created_at: "2026-01-01T00:00:00Z",
          parts: [{ type: "text", text: "hi" }] },
        { id: "m2", role: "assistant", created_at: "2026-01-01T00:00:01Z",
          parts: [{ type: "text", text: "hello" }] },
      ],
    };
    expect(extractEvents(detail, { session_file_path: "/tmp/x.jsonl" })).toEqual([]);
  });
});
