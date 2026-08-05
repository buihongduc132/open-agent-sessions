/**
 * Zone 1 (empty/nil) — missing cwd field defaults to NULL, no crash.
 *
 * CLI agent JSONL may omit cwd from some events (older format, partial write).
 * Extractor must coerce undefined → NULL in cwd_hint column, not throw.
 */
import { describe, it, expect } from "bun:test";
import { extractEvents } from "../../src/extract/registry";
import type { SessionDetail } from "@open-agent-sessions/sdk";

describe("extract missing cwd (Zone 1)", () => {
  it("tool_call_without_cwd_yields_event_with_null_cwd_hint", () => {
    const detail: SessionDetail = {
      id: "no-cwd",
      agent: "pi",
      alias: "test",
      title: "x",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      message_count: 1,
      storage: "jsonl",
      messages: [
        {
          id: "m1", role: "assistant", created_at: "2026-01-01T00:00:00Z",
          // NOTE: tool part has no cwd field
          parts: [
            { type: "tool", tool: "bash", state: { command: "echo hi" } } as any,
          ],
        },
      ],
    };

    const events = extractEvents(detail, { session_file_path: "/tmp/x.jsonl" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) {
      // cwd_hint may be null when cwd absent — must not throw on ingest
      expect(e.cwd_hint === null || typeof e.cwd_hint === "string").toBe(true);
    }
  });
});
