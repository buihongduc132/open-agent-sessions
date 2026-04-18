/**
 * test/adapters/codex-gap-8.test.ts
 *
 * GAP 8 — RED tests: codex adapter must populate parentSessionId.
 *
 * Gap 7 documented that: SessionSummary has parentSessionId?: string, the CLI
 * filters on it, but ZERO adapters populate it.
 *
 * Codex stores sessions as JSONL files in ~/.codex/sessions/.
 * The current adapter (codex.ts:256-269) never attempts to read any parent
 * session information from the JSONL records.
 *
 * Open questions (from GAP 7 in _16apr_gaps.md):
 *   - Does Codex store parent session IDs anywhere in its JSONL schema?
 *   - What is the exact structure of ~/.codex/sessions/ directory?
 *   - Does Codex store parent info in a separate metadata file?
 *
 * These tests verify the current state (parentSessionId always undefined)
 * AND document what the expected behavior should be if/when parent info
 * becomes available in Codex storage.
 *
 * The tests use the EXISTING codex JSONL schema (from codex-adapter.test.ts)
 * and verify that parentSessionId is NOT populated from any available field.
 * Once the storage format is investigated and a source is found, these tests
 * should be updated to assert the correct parentSessionId value.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter } from "../../src/adapters/codex";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "oas-codex-gap8-"));
}

function writeSession(filePath: string, lines: unknown[]): void {
  const payload = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(filePath, payload, "utf8");
}

// ============================================================================
// GAP 8: Codex Adapter — parentSessionId
// ============================================================================

describe("GAP 8 — codex adapter must investigate and populate parentSessionId", () => {
  /**
   * WHY RED (investigation): The codex adapter returns sessions with
   * parentSessionId = undefined. We need to verify this is the CURRENT
   * (broken) state, and then investigate the Codex JSONL schema to find
   * where parent session information is stored.
   *
   * This test documents the current behavior: parentSessionId is never set.
   * Once GAP 8 investigation is complete, this test should be UPDATED to
   * assert the correct parentSessionId value based on the storage format.
   */
  test("listSessions_returns_parentSessionId_undefined_for_standard_schema", () => {
    const dir = tempDir();
    const filePath = join(dir, "session.jsonl");
    writeSession(filePath, [
      {
        timestamp: "2026-02-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "cx-root-001", timestamp: "2026-02-01T00:00:00Z", title: "Root session" },
      },
      {
        timestamp: "2026-02-01T01:00:00Z",
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "Hello" }] },
      },
      {
        timestamp: "2026-02-01T02:00:00Z",
        type: "response_item",
        payload: { role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
      },
    ]);

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
      path: dir, // path is the directory containing session files
    });
    const sessions = adapter.listSessions();

    const session = sessions.find((s) => s.id === "cx-root-001");
    expect(session).toBeDefined();
    // GAP 8: parentSessionId is currently undefined — this documents the broken state
    // When the source of truth is found in Codex storage, this test should be updated
    // to assert the correct parentSessionId value (e.g., from directory structure or metadata)
    expect(session!.parentSessionId).toBeUndefined();
  });

  /**
   * WHY RED (investigation): Codex may embed parent session information in
   * the session_meta payload. This test tries a plausible schema extension
   * (parent_id in session_meta payload) and verifies the adapter currently
   * ignores it.
   *
   * If Codex DOES use this schema, the adapter should read it.
   * If Codex uses a DIFFERENT schema, the adapter should be updated to match.
   *
   * This test will RED until the codex adapter is updated to look for
   * parent session information in the appropriate field.
   */
  test("listSessions_investigate_parent_id_in_session_meta_payload", () => {
    const dir = tempDir();
    const filePath = join(dir, "session.jsonl");

    // Write session with parent_id in session_meta payload
    // (plausible extension — may or may not match actual Codex format)
    writeSession(filePath, [
      {
        timestamp: "2026-02-01T00:00:00Z",
        type: "session_meta",
        payload: {
          id: "cx-child-001",
          timestamp: "2026-02-01T00:00:00Z",
          title: "Child session",
          // Plausible parent_id field in session_meta payload
          parent_id: "cx-root-001",
        },
      },
      {
        timestamp: "2026-02-01T01:00:00Z",
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "Hello" }] },
      },
    ]);

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
      path: dir,
    });
    const sessions = adapter.listSessions();

    const session = sessions.find((s) => s.id === "cx-child-001");
    expect(session).toBeDefined();
    // GAP 8: The adapter now correctly reads session_meta.payload.parent_id
    expect(session!.parentSessionId).toBe("cx-root-001");
  });

  /**
   * WHY RED: Same as above for a session WITHOUT parent_id in metadata.
   * The adapter should return parentSessionId = undefined.
   * This test passes even without the fix (proving the adapter doesn't crash
   * on sessions with parent info), but it establishes the correct behavior.
   */
  test("listSessions_parentSessionId_undefined_when_session_meta_has_no_parent_id", () => {
    const dir = tempDir();
    const filePath = join(dir, "session.jsonl");
    writeSession(filePath, [
      {
        timestamp: "2026-02-01T00:00:00Z",
        type: "session_meta",
        payload: {
          id: "cx-no-parent",
          timestamp: "2026-02-01T00:00:00Z",
          title: "No parent session",
        },
      },
      {
        timestamp: "2026-02-01T01:00:00Z",
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "Hello" }] },
      },
    ]);

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
      path: dir,
    });
    const sessions = adapter.listSessions();

    const session = sessions.find((s) => s.id === "cx-no-parent");
    expect(session).toBeDefined();
    expect(session!.parentSessionId).toBeUndefined();
  });
});
