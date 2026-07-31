/**
 * Pi Adapter — Phase 2 Parity (RED PHASE)
 *
 * Failing tests for the 4 remaining gaps in the pi adapter parity matrix.
 * Reference: src/adapters/zcode.ts (gold standard, 95% parity).
 *
 * These tests MUST fail against main's src/adapters/pi.ts. The GREEN phase
 * will make them pass by populating the missing fields.
 *
 * Pi JSONL event shape (from src/adapters/pi.ts main):
 *   { type:"message", id, parentId, timestamp,
 *     message:{ role, content, provider, model,
 *               usage:{input,output,totalTokens}, errorMessage } }
 *   content array parts: {type:"text",text} | {type:"tool",tool,state} | {type:"reasoning",text}
 *
 * Phase 2 gaps:
 *   1. reasoning parts in message content array
 *   2. modelID (from record.message.model) on SessionMessage
 *   3. agent field on SessionMessage
 *   4. parentSessionId (from record.parentId) on SessionSummary
 *
 * NOTE: This worktree is off MAIN. Phase 1 features (tool parts, selection
 * options) are NOT present. These tests only assert Phase 2 fields.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPiAdapter } from "../src/adapters/pi";

type PiEntry = { agent: "pi"; alias: string; enabled: boolean };

const TMP = join(process.cwd(), ".tmp-pi-phase2-test");

function makeAdapter() {
  return createPiAdapter(
    { agent: "pi", alias: "pi-phase2", enabled: true } satisfies PiEntry,
    { defaultPath: TMP }
  );
}

/** Write one session dir from a list of raw event objects (preserves order). */
function seedEvents(
  sessionId: string,
  events: Array<Record<string, unknown>>
): void {
  const dir = join(TMP, sessionId);
  mkdirSync(dir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, "events.jsonl"), body);
}

const ISO_NOW = "2024-01-01T00:00:00.000Z";

describe("Pi Adapter — Phase 2 Parity (RED)", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  // --- Gap 1: reasoning parts ---------------------------------------------

  describe("message parsing — reasoning parts", () => {
    test("assistant message with a reasoning content part surfaces it as a reasoning part", async () => {
      seedEvents("sess-reasoning", [
        {
          type: "message",
          id: "m-reasoning",
          timestamp: ISO_NOW,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "thinking..." },
              { type: "reasoning", text: "internal reasoning" },
            ],
          },
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail("sess-reasoning", {});
      expect(detail.messages).toHaveLength(1);
      const parts = detail.messages![0].parts;
      // GREEN must emit the reasoning part verbatim.
      expect(parts).toEqual(
        expect.arrayContaining([
          { type: "reasoning", text: "internal reasoning" },
        ])
      );
    });
  });

  // --- Gap 2: modelID ------------------------------------------------------

  describe("message parsing — modelID", () => {
    test("assistant message with message.model populates SessionMessage.modelID", async () => {
      seedEvents("sess-model", [
        {
          type: "message",
          id: "m-model",
          timestamp: ISO_NOW,
          message: {
            role: "assistant",
            content: "hi",
            provider: "anthropic",
            model: "claude-3-5-sonnet",
          },
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail("sess-model", {});
      expect(detail.messages).toHaveLength(1);
      // GREEN must surface record.message.model as modelID (mirrors zcode).
      expect(detail.messages![0].modelID).toBe("claude-3-5-sonnet");
    });
  });

  // --- Gap 3: agent field --------------------------------------------------

  describe("message parsing — agent field", () => {
    test("assistant message with message.agent populates SessionMessage.agent", async () => {
      seedEvents("sess-agent", [
        {
          type: "message",
          id: "m-agent",
          timestamp: ISO_NOW,
          message: {
            role: "assistant",
            content: "hi",
            agent: "worker-a",
          },
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail("sess-agent", {});
      expect(detail.messages).toHaveLength(1);
      // GREEN must surface record.message.agent (mirrors zcode parsed.agent).
      expect(detail.messages![0].agent).toBe("worker-a");
    });
  });

  // --- Gap 4: parentSessionId ---------------------------------------------

  describe("parentSessionId extraction", () => {
    test("listSessions surfaces record.parentId as parentSessionId", () => {
      seedEvents("sess-child", [
        {
          type: "message",
          id: "m1",
          parentId: "parent-sess-123",
          timestamp: ISO_NOW,
          message: { role: "user", content: "child prompt" },
        },
      ]);
      const adapter = makeAdapter();
      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      // GREEN must extract parentId from any event into SessionSummary.parentSessionId
      // (mirrors claude.ts parent_session_id / zcode.ts session.parent_id).
      expect(sessions[0].parentSessionId).toBe("parent-sess-123");
    });

    test("getSessionDetail also surfaces parentSessionId on the summary", async () => {
      seedEvents("sess-child2", [
        {
          type: "message",
          id: "m1",
          parentId: "parent-sess-456",
          timestamp: ISO_NOW,
          message: { role: "user", content: "child prompt 2" },
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail("sess-child2", {});
      // SessionDetail extends SessionSummary, so parentSessionId must be present.
      expect(detail.parentSessionId).toBe("parent-sess-456");
    });

    test("session with no parentId has undefined parentSessionId", () => {
      seedEvents("sess-root", [
        {
          type: "message",
          id: "m1",
          timestamp: ISO_NOW,
          message: { role: "user", content: "root prompt" },
        },
      ]);
      const adapter = makeAdapter();
      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      // Root session: no parentId → parentSessionId undefined (not a string).
      expect(sessions[0].parentSessionId).toBeUndefined();
    });
  });
});
