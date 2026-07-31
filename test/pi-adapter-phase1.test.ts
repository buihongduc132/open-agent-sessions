/**
 * Pi Adapter — Phase 1 Parity (RED PHASE)
 *
 * Failing tests for the 10 gaps identified in the adapter parity matrix.
 * Reference: src/adapters/zcode.ts (gold standard, ~95% parity).
 *
 * These tests MUST fail against the current src/adapters/pi.ts. The GREEN
 * phase will make them pass by implementing the missing methods and options
 * handling, mirroring zcode's shape.
 *
 * Pi JSONL event shape (from src/adapters/pi.ts):
 *   { type:"message", id, parentId, timestamp,
 *     message:{ role, content (array|string), provider, model,
 *               usage:{input,output,totalTokens}, errorMessage } }
 *   content array parts: {type:"text",text} | {type:"tool",tool,state} | {type:"reasoning",text}
 *
 * updated_at is derived from the max record.timestamp across all events in
 * the session directory.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPiAdapter } from "../src/adapters/pi";
import type {
  Adapter,
  SessionSummary,
} from "../src/core/types";

type PiEntry = { agent: "pi"; alias: string; enabled: boolean };

// Fixed ISO timestamps + their ms-epoch values for deterministic time-range tests.
const ISO_A = "2024-01-01T00:00:00.000Z"; // earliest
const ISO_B = "2024-01-02T00:00:00.000Z";
const ISO_C = "2024-01-03T00:00:00.000Z"; // latest
const MS_A = Date.parse(ISO_A);
const MS_B = Date.parse(ISO_B);
const MS_C = Date.parse(ISO_C);

const TMP = join(process.cwd(), ".tmp-pi-phase1-test");

function makeAdapter(): Adapter {
  return createPiAdapter(
    { agent: "pi", alias: "pi-phase1", enabled: true } satisfies PiEntry,
    { defaultPath: TMP }
  );
}

/** Write one session dir with a single user message event at the given timestamp. */
function seedSession(sessionId: string, timestamp: string, userText: string): void {
  const dir = join(TMP, sessionId);
  mkdirSync(dir, { recursive: true });
  const event = {
    type: "message",
    id: `msg-${sessionId}`,
    timestamp,
    message: { role: "user", content: userText },
  };
  writeFileSync(join(dir, "events.jsonl"), JSON.stringify(event) + "\n");
}

/** Write one session dir from a list of raw event objects (preserves order). */
function seedEvents(sessionId: string, events: Array<Record<string, unknown>>): void {
  const dir = join(TMP, sessionId);
  mkdirSync(dir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, "events.jsonl"), body);
}

describe("Pi Adapter — Phase 1 Parity (RED)", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  // --- Gap 1: listSessionsByTimeRange -------------------------------------

  describe("listSessionsByTimeRange", () => {
    test("method exists on adapter", () => {
      const adapter = makeAdapter();
      expect(typeof adapter.listSessionsByTimeRange).toBe("function");
    });

    test("filters sessions by since/until window (inclusive)", () => {
      seedSession("sess-a", ISO_A, "A");
      seedSession("sess-b", ISO_B, "B");
      seedSession("sess-c", ISO_C, "C");
      const adapter = makeAdapter();

      // Window [B, C] inclusive → only B and C.
      const result = (adapter.listSessionsByTimeRange ?? (() => [] as SessionSummary[]))({
        since: MS_B,
        until: MS_C,
      });
      const ids = result.map((s) => s.id).sort();
      expect(ids).toEqual(["sess-b", "sess-c"]);
    });

    test("honours limit (returns most recent first)", () => {
      seedSession("sess-a", ISO_A, "A");
      seedSession("sess-b", ISO_B, "B");
      seedSession("sess-c", ISO_C, "C");
      const adapter = makeAdapter();

      const result = (adapter.listSessionsByTimeRange ?? (() => [] as SessionSummary[]))({
        limit: 1,
      });
      expect(result).toHaveLength(1);
      // Most recent first (zcode mirrors opencode: ORDER BY updated DESC).
      expect(result[0].id).toBe("sess-c");
    });

    test("honours skipSessionId (cursor pagination exclusion)", () => {
      seedSession("sess-a", ISO_A, "A");
      seedSession("sess-b", ISO_B, "B");
      seedSession("sess-c", ISO_C, "C");
      const adapter = makeAdapter();

      const result = (adapter.listSessionsByTimeRange ?? (() => [] as SessionSummary[]))({
        skipSessionId: "sess-c",
      });
      const ids = result.map((s) => s.id).sort();
      expect(ids).toEqual(["sess-a", "sess-b"]);
    });
  });

  // --- Gap 2: toolSearchSessions ------------------------------------------

  describe("toolSearchSessions", () => {
    test("method exists on adapter", () => {
      const adapter = makeAdapter();
      expect(typeof adapter.toolSearchSessions).toBe("function");
    });

    test("returns sessions whose message content contains a matching tool part", () => {
      // Session with an assistant message carrying a tool-call part.
      seedEvents("sess-with-tool", [
        {
          type: "message",
          id: "m1",
          timestamp: ISO_A,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "reading file" },
              { type: "tool", tool: "Read", state: { path: "/etc/hosts" } },
            ],
          },
        },
      ]);
      // Session with no tool calls.
      seedSession("sess-no-tool", ISO_B, "just text");

      const adapter = makeAdapter();
      const result =
        adapter.toolSearchSessions?.({ tool: "Read" }) ?? [];
      const ids = result.map((s) => s.id);
      expect(ids).toContain("sess-with-tool");
      expect(ids).not.toContain("sess-no-tool");
    });

    test("returns empty array when no session uses the tool", () => {
      seedSession("sess-plain", ISO_A, "hello");
      const adapter = makeAdapter();
      // Method must exist (RED: currently undefined) before we assert behaviour.
      expect(typeof adapter.toolSearchSessions).toBe("function");
      const result = adapter.toolSearchSessions!({ tool: "NonexistentTool" });
      expect(result).toEqual([]);
    });
  });

  // --- Gap 3: forkSession (stub-tolerant) ---------------------------------

  describe("forkSession", () => {
    test("method exists and returns a well-formed ForkResult", async () => {
      seedSession("sess-src", ISO_A, "source");
      const adapter = makeAdapter();

      expect(typeof adapter.forkSession).toBe("function");
      const result = await adapter.forkSession!("sess-src", "opencode", "oc-main");

      expect(result).toBeDefined();
      expect(result.parentSessionId).toBe("sess-src");
      expect(result.destAgent).toBe("opencode");
      expect(result.destAlias).toBe("oc-main");
      expect(typeof result.newSessionId).toBe("string");
      expect(result.newSessionId.length).toBeGreaterThan(0);
      // forkedAt must be a valid ISO-8601 string.
      expect(() => new Date(result.forkedAt).toISOString()).not.toThrow();
    });
  });

  // --- Gap 4: destroy -----------------------------------------------------

  describe("destroy", () => {
    test("method exists and does not throw", () => {
      const adapter = makeAdapter();
      expect(typeof adapter.destroy).toBe("function");
      expect(() => adapter.destroy!()).not.toThrow();
    });
  });

  // --- Gaps 5–9: getSessionDetail SessionReadOptions ----------------------

  describe("getSessionDetail — SessionReadOptions", () => {
    // Seed one session with 4 alternating messages (u/a/u/a).
    function seedAlternating(): void {
      seedEvents("sess-multi", [
        { type: "message", id: "m1", timestamp: ISO_A, message: { role: "user", content: "msg-1" } },
        { type: "message", id: "m2", timestamp: ISO_A, message: { role: "assistant", content: "msg-2" } },
        { type: "message", id: "m3", timestamp: ISO_A, message: { role: "user", content: "msg-3" } },
        { type: "message", id: "m4", timestamp: ISO_A, message: { role: "assistant", content: "msg-4" } },
      ]);
    }

    test("selection mode 'first' count=1 returns only the first message", async () => {
      seedAlternating();
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-multi", {
        selection: { mode: "first", count: 1 },
      });
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages![0].id).toBe("m1");
    });

    test("selection mode 'last' count=2 returns the last 2 messages", async () => {
      seedAlternating();
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-multi", {
        selection: { mode: "last", count: 2 },
      });
      expect(detail.messages).toHaveLength(2);
      expect(detail.messages!.map((m) => m.id)).toEqual(["m3", "m4"]);
    });

    test("selection mode 'range' start=2 end=3 returns messages 2–3 (1-indexed inclusive)", async () => {
      seedAlternating();
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-multi", {
        selection: { mode: "range", start: 2, end: 3 },
      });
      expect(detail.messages).toHaveLength(2);
      expect(detail.messages!.map((m) => m.id)).toEqual(["m2", "m3"]);
    });

    test("selection mode 'all' returns all messages", async () => {
      seedAlternating();
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-multi", {
        selection: { mode: "all" },
      });
      expect(detail.messages).toHaveLength(4);
    });

    test("role filter 'user' returns only user messages", async () => {
      seedAlternating();
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-multi", { role: "user" });
      expect(detail.messages!.every((m) => m.role === "user")).toBe(true);
      expect(detail.messages!.map((m) => m.id)).toEqual(["m1", "m3"]);
    });

    test("userOnly=true returns only user messages", async () => {
      seedAlternating();
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-multi", { userOnly: true });
      expect(detail.messages!.every((m) => m.role === "user")).toBe(true);
      expect(detail.messages!.map((m) => m.id)).toEqual(["m1", "m3"]);
    });

    test("userOnly=true with role='assistant' returns empty (additive contradiction)", async () => {
      seedAlternating();
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-multi", {
        userOnly: true,
        role: "assistant",
      });
      expect(detail.messages).toHaveLength(0);
    });
  });

  // --- Gap 10: message parsing — tool parts -------------------------------

  describe("message parsing — tool parts", () => {
    test("assistant message with a tool-call content part surfaces it as a tool part", async () => {
      seedEvents("sess-tool", [
        {
          type: "message",
          id: "m-tool",
          timestamp: ISO_A,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "let me read that" },
              { type: "tool", tool: "Read", state: { path: "/x" } },
            ],
          },
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail!("sess-tool", {});
      expect(detail.messages).toHaveLength(1);
      const parts = detail.messages![0].parts;
      expect(parts).toEqual(
        expect.arrayContaining([
          { type: "tool", tool: "Read", state: { path: "/x" } },
        ])
      );
    });
  });
});
