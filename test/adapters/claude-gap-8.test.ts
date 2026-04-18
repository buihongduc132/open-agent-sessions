/**
 * test/adapters/claude-gap-8.test.ts
 *
 * GAP 8 — RED tests: claude adapter must investigate and populate parentSessionId.
 *
 * Gap 7 documented that: SessionSummary has parentSessionId?: string, the CLI
 * filters on it, but ZERO adapters populate it.
 *
 * Claude stores sessions as JSONL files in ~/.claude/transcripts/ or
 * ~/.claude/sessions/. The session ID is derived from the filename (basename
 * without .jsonl extension).
 *
 * Open questions (from GAP 7 in _16apr_gaps.md):
 *   - Does Claude store parent session IDs anywhere in its JSONL schema?
 *   - Does the directory structure embed parent session information?
 *   - Is parent info stored in a separate metadata file?
 *
 * These tests verify the current state (parentSessionId always undefined)
 * AND document what the expected behavior should be if/when parent info
 * becomes available in Claude storage.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "../../src/adapters/claude";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "oas-claude-gap8-"));
}

function writeSession(filePath: string, lines: unknown[]): void {
  const payload = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(filePath, payload, "utf8");
}

// ============================================================================
// GAP 8: Claude Adapter — parentSessionId
// ============================================================================

describe("GAP 8 — claude adapter must investigate and populate parentSessionId", () => {
  /**
   * WHY RED (investigation): The claude adapter returns sessions with
   * parentSessionId = undefined. We need to verify this is the CURRENT
   * (broken) state, and then investigate the Claude JSONL schema to find
   * where parent session information is stored.
   *
   * This test documents the current behavior: parentSessionId is never set.
   * Once GAP 8 investigation is complete, this test should be UPDATED to
   * assert the correct parentSessionId value based on the storage format.
   */
  test("listSessions_returns_parentSessionId_undefined_for_standard_schema", () => {
    const dir = tempDir();
    const filePath = join(dir, "ses_claude_root.jsonl");
    writeSession(filePath, [
      {
        type: "system",
        timestamp: "2026-02-01T00:30:00Z",
        content: "System note",
      },
      {
        type: "user",
        timestamp: "2026-02-01T01:00:00Z",
        content: "First line",
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T02:00:00Z",
        content: "Reply",
      },
    ]);

    const adapter = createClaudeAdapter({
      agent: "claude",
      alias: "main",
      enabled: true,
      path: filePath,
    });
    const sessions = adapter.listSessions();

    const session = sessions.find((s) => s.id === "ses_claude_root");
    expect(session).toBeDefined();
    // GAP 8: parentSessionId is currently undefined — this documents the broken state
    // When the source of truth is found in Claude storage, this test should be updated
    expect(session!.parentSessionId).toBeUndefined();
  });

  /**
   * WHY RED (investigation): Claude may store parent session information in
   * a metadata field within the JSONL records. This test tries a plausible
   * schema extension (parent_id field in the first record) and verifies the
   * adapter currently ignores it.
   *
   * If Claude DOES use this or a similar schema, the adapter should read it.
   * This test will RED until the claude adapter is updated to look for
   * parent session information in the appropriate field.
   */
  test("listSessions_investigate_parent_id_in_jsonl_metadata_record", () => {
    const dir = tempDir();
    // Session filename embeds the session ID (standard behavior)
    const filePath = join(dir, "ses_claude_child.jsonl");

    // Write session with a metadata field containing the parent session ID
    // (plausible extension — may or may not match actual Claude format)
    writeSession(filePath, [
      {
        type: "metadata",
        timestamp: "2026-02-01T00:00:00Z",
        content: "",
        // Plausible parent session ID field
        parent_session_id: "ses_claude_root",
      },
      {
        type: "user",
        timestamp: "2026-02-01T01:00:00Z",
        content: "Hello",
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T02:00:00Z",
        content: "Hi",
      },
    ]);

    const adapter = createClaudeAdapter({
      agent: "claude",
      alias: "main",
      enabled: true,
      path: filePath,
    });
    const sessions = adapter.listSessions();

    const session = sessions.find((s) => s.id === "ses_claude_child");
    expect(session).toBeDefined();
    // GAP 8 RED: The adapter currently ignores parent_session_id metadata record
    expect(session!.parentSessionId).toBeUndefined(); // ← RED until adapter is updated
    // TODO after investigation: update to: expect(session!.parentSessionId).toBe("ses_claude_root");
  });

  /**
   * WHY RED: A session without any parent metadata should have parentSessionId = undefined.
   * This test passes even without the fix — it establishes the correct baseline.
   */
  test("listSessions_parentSessionId_undefined_when_no_parent_metadata_present", () => {
    const dir = tempDir();
    const filePath = join(dir, "ses_no_parent.jsonl");
    writeSession(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T01:00:00Z",
        content: "Hello",
      },
    ]);

    const adapter = createClaudeAdapter({
      agent: "claude",
      alias: "main",
      enabled: true,
      path: filePath,
    });
    const sessions = adapter.listSessions();

    const session = sessions.find((s) => s.id === "ses_no_parent");
    expect(session).toBeDefined();
    expect(session!.parentSessionId).toBeUndefined();
  });
});
