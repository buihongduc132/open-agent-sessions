/**
 * Claude Adapter — Phase 4 Parity (RED PHASE)
 *
 * Tests for the 4 remaining gaps in the claude adapter parity matrix.
 * Reference: src/adapters/zcode.ts (gold standard, ~95% parity).
 *
 * Phase 4 gaps:
 *   1. Message parsing: reasoning parts (thinking block → reasoning part)
 *   2. Message parsing: modelID (from record.model)
 *   3. Message parsing: agent field (from record.agent)
 *   4. Version from package.json (replace hardcoded "1.0.0")
 *
 * Claude JSONL transcript shape (from src/adapters/claude.ts):
 *   Files: <rootPath>/<sessionId>.jsonl (one file per session)
 *   Records: { type, id, timestamp, content, model?, agent?, parent_session_id }
 *   Content blocks: {type:"text",text} | {type:"tool_use",id,name,input} |
 *                   {type:"thinking",thinking} | {type:"tool_result",...}
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeAdapter } from "../src/adapters/claude";

type ClaudeEntry = { agent: "claude"; alias: string; enabled: boolean };

const TMP = join(process.cwd(), ".tmp-claude-phase4-test");
const ISO_NOW = "2024-01-01T00:00:00.000Z";

function makeAdapter() {
  return createClaudeAdapter(
    { agent: "claude", alias: "claude-phase4", enabled: true } satisfies ClaudeEntry,
    { defaultPath: TMP }
  );
}

/** Write one session transcript file from a list of raw record objects. */
function seedTranscript(sessionId: string, records: Array<Record<string, unknown>>): void {
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(TMP, `${sessionId}.jsonl`), body);
}

describe("Claude Adapter — Phase 4 Parity (RED)", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  // --- Gap 1: reasoning parts ---------------------------------------------

  describe("message parsing — reasoning parts", () => {
    test("assistant message with a thinking block surfaces it as a reasoning part", async () => {
      seedTranscript("sess-reasoning", [
        {
          type: "assistant",
          id: "m-reasoning",
          timestamp: ISO_NOW,
          content: [
            { type: "text", text: "thinking..." },
            { type: "thinking", thinking: "internal reasoning" },
          ],
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-reasoning", {});
      expect(detail.messages).toHaveLength(1);
      const parts = detail.messages![0].parts;
      // GREEN must emit the reasoning part from the thinking block.
      expect(parts).toEqual(
        expect.arrayContaining([
          { type: "reasoning", text: "internal reasoning" },
        ])
      );
    });
  });

  // --- Gap 2: modelID -----------------------------------------------------

  describe("message parsing — modelID", () => {
    test("assistant message with a model field populates message.modelID", async () => {
      seedTranscript("sess-model", [
        {
          type: "assistant",
          id: "m-model",
          timestamp: ISO_NOW,
          model: "claude-3-5-sonnet-20241022",
          content: "hi",
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-model", {});
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages![0].modelID).toBe("claude-3-5-sonnet-20241022");
    });

    test("message without a model field has no modelID", async () => {
      seedTranscript("sess-no-model", [
        {
          type: "assistant",
          id: "m-no-model",
          timestamp: ISO_NOW,
          content: "hi",
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-no-model", {});
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages![0].modelID).toBeUndefined();
    });
  });

  // --- Gap 3: agent field -------------------------------------------------

  describe("message parsing — agent field", () => {
    test("assistant message with an agent field populates message.agent", async () => {
      seedTranscript("sess-agent", [
        {
          type: "assistant",
          id: "m-agent",
          timestamp: ISO_NOW,
          agent: "worker-1",
          content: "hi",
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-agent", {});
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages![0].agent).toBe("worker-1");
    });

    test("message without an agent field has no agent", async () => {
      seedTranscript("sess-no-agent", [
        {
          type: "assistant",
          id: "m-no-agent",
          timestamp: ISO_NOW,
          content: "hi",
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-no-agent", {});
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages![0].agent).toBeUndefined();
    });
  });

  // --- Gap 4: version from package.json -----------------------------------

  describe("adapter version", () => {
    test("version is NOT the hardcoded placeholder '1.0.0'", () => {
      const adapter = makeAdapter();
      expect(adapter.version).not.toBe("1.0.0");
    });

    test("version matches package.json version field", () => {
      const adapter = makeAdapter();
      const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
      expect(adapter.version).toBe(pkg.version);
    });
  });
});
