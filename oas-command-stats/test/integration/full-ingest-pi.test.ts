/**
 * Integration — happy path full ingest cycle for pi.
 *
 * End-to-end: SessionDetail (pi) → extractEvents → ingestBatch →
 * outbox + cmd_events both populated, all parse_status='ok'.
 *
 * NOTE: happy path is written LAST per worst-first-testing skill.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractEvents } from "../../src/extract/registry";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb } from "../../src/storage/duckdb";
import type { SessionDetail } from "@open-agent-sessions/sdk";

const DB_PATH = join(tmpdir(), `oas-cs-pi-${process.pid}-${Date.now()}.duckdb`);
const SESSION_DIR = mkdtempSync(join(tmpdir(), "oas-cs-pi-sess-"));
const SESSION_FILE = join(SESSION_DIR, "2026-01-01_test.jsonl");

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("full ingest cycle — pi (happy path)", () => {
  it("three_bash_calls_three_outbox_three_events_all_ok", async () => {
    // Write a tiny pi-style JSONL with 3 bash tool calls.
    const records = [
      { type: "message", message: {
        role: "assistant", created_at: "2026-01-01T00:00:00Z",
        content: [{ type: "tool_use", name: "bash",
          input: { command: "git status", cwd: "/tmp/proj" } }],
      }},
      { type: "message", message: {
        role: "assistant", created_at: "2026-01-01T00:00:01Z",
        content: [{ type: "tool_use", name: "bash",
          input: { command: "ls -la", cwd: "/tmp/proj" } }],
      }},
      { type: "message", message: {
        role: "assistant", created_at: "2026-01-01T00:00:02Z",
        content: [{ type: "tool_use", name: "bash",
          input: { command: "rg function src/", cwd: "/tmp/proj" } }],
      }},
    ];
    writeFileSync(SESSION_FILE, records.map(r => JSON.stringify(r)).join("\n") + "\n");

    // Build a SessionDetail that points at the JSONL file path.
    const detail: SessionDetail = {
      id: "test-pi-sess",
      agent: "pi",
      alias: "test",
      title: "happy path",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:02Z",
      message_count: 3,
      storage: "jsonl",
      messages: records.map((r, i) => ({
        id: `m-${i}`,
        role: r.message.role as any,
        created_at: r.message.created_at,
        parts: r.message.content as any,
      })),
    };

    const events = extractEvents(detail, { session_file_path: SESSION_FILE });
    expect(events.length).toBe(3);

    const db = await openDb(DB_PATH);
    const result = await ingestBatch(db, events);
    expect(result.committed).toBe(3);
    expect(result.failed).toBe(0);

    const ob = await db.all("SELECT COUNT(*) AS n FROM outbox");
    const ce = await db.all("SELECT COUNT(*) AS n FROM cmd_events");
    expect(ob[0].n).toBe(3);
    expect(ce[0].n).toBe(3);

    const statuses = await db.all("SELECT DISTINCT parse_status FROM cmd_events");
    expect(statuses.map(s => s.parse_status)).toEqual(["ok"]);

    const q = await db.all("SELECT COUNT(*) AS n FROM cmd_quarantine");
    expect(q[0].n).toBe(0);

    await db.close();
  });
});
