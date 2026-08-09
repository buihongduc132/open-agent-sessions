/**
 * Antigravity (agy) Adapter — Phase 5 Parity (RED PHASE)
 *
 * Failing tests for the 9 gaps in the agy adapter parity matrix.
 * Reference: src/adapters/zcode.ts (gold standard, ~95% parity) and
 * src/adapters/pi.ts (JSONL adapter, parity-complete after Phase 1+2).
 *
 * These tests MUST fail against the current src/adapters/antigravity.ts.
 * The GREEN phase will make them pass by implementing the missing methods
 * and options handling, mirroring zcode/pi shape.
 *
 * Antigravity log entry shape (from src/adapters/antigravity.ts):
 *   { step_index, source:"USER_EXPLICIT"|"MODEL"|"SYSTEM",
 *     type:"USER_INPUT"|"PLANNER_RESPONSE"|..., status, created_at (ISO),
 *     content?, tool_calls?:[{name,args}] }
 *
 * NEW fields designed here for the GREEN phase to add to AntigravityLogEntry:
 *   - reasoning?: string        → surfaces as a reasoning SessionPart
 *   - model?: string            → message.modelID
 *   - agent?: string            → message.agent
 *   - parent_session_id?: string → SessionSummary.parentSessionId
 *
 * updated_at is derived from the max logEntry.created_at in the session log.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAntigravityAdapter } from "../src/adapters/antigravity";
import type {
  Adapter,
  SessionSummary,
} from "../src/core/types";

type AgyEntry = { agent: "antigravity"; alias: string; enabled: boolean };

// Fixed ISO timestamps + their ms-epoch values for deterministic time-range tests.
const ISO_A = "2024-01-01T00:00:00.000Z"; // earliest
const ISO_B = "2024-01-02T00:00:00.000Z";
const ISO_C = "2024-01-03T00:00:00.000Z"; // latest
const MS_A = Date.parse(ISO_A);
const MS_B = Date.parse(ISO_B);
const MS_C = Date.parse(ISO_C);

// Valid UUIDs required by the adapter's UUID_REGEX filter on brain/<uuid>/.
const UUID_A = "11111111-aaaa-aaaa-aaaa-111111111111";
const UUID_B = "22222222-bbbb-bbbb-bbbb-222222222222";
const UUID_C = "33333333-cccc-cccc-cccc-333333333333";

const TMP = join(tmpdir(), "oas-agy-phase5-test");

function makeAdapter(): Adapter {
  return createAntigravityAdapter(
    { agent: "antigravity", alias: "agy-phase5", enabled: true, path: TMP } satisfies AgyEntry,
    {}
  );
}

/** Write one session's overview.txt log with a single USER_INPUT entry at the given timestamp. */
function seedSession(uuid: string, timestamp: string, userText: string): void {
  seedLogEntries(uuid, [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: timestamp,
      content: userText,
    },
  ]);
}

/** Write one session's overview.txt log from a list of raw log-entry objects (preserves order). */
function seedLogEntries(uuid: string, entries: Array<Record<string, unknown>>): void {
  const logDir = join(TMP, "brain", uuid, ".system_generated", "logs");
  mkdirSync(logDir, { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(logDir, "overview.txt"), body);
}

describe("Antigravity Adapter — Phase 5 Parity (RED)", () => {
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
      seedSession(UUID_A, ISO_A, "A");
      seedSession(UUID_B, ISO_B, "B");
      seedSession(UUID_C, ISO_C, "C");
      const adapter = makeAdapter();

      // Window [B, C] inclusive → only B and C.
      const result = (adapter.listSessionsByTimeRange ?? (() => [] as SessionSummary[]))({
        since: MS_B,
        until: MS_C,
      });
      const ids = result.map((s) => s.id).sort();
      expect(ids).toEqual([UUID_B, UUID_C].sort());
    });

    test("honours limit (returns most recent first)", () => {
      seedSession(UUID_A, ISO_A, "A");
      seedSession(UUID_B, ISO_B, "B");
      seedSession(UUID_C, ISO_C, "C");
      const adapter = makeAdapter();

      const result = (adapter.listSessionsByTimeRange ?? (() => [] as SessionSummary[]))({
        limit: 1,
      });
      expect(result).toHaveLength(1);
      // Most recent first (mirror zcode: sort by updated_at DESC).
      expect(result[0].id).toBe(UUID_C);
    });

    test("honours skipSessionId (cursor pagination exclusion)", () => {
      seedSession(UUID_A, ISO_A, "A");
      seedSession(UUID_B, ISO_B, "B");
      seedSession(UUID_C, ISO_C, "C");
      const adapter = makeAdapter();

      const result = (adapter.listSessionsByTimeRange ?? (() => [] as SessionSummary[]))({
        skipSessionId: UUID_C,
      });
      const ids = result.map((s) => s.id).sort();
      expect(ids).toEqual([UUID_A, UUID_B].sort());
    });
  });

  // --- Gap 2: toolSearchSessions ------------------------------------------

  describe("toolSearchSessions", () => {
    test("method exists on adapter", () => {
      const adapter = makeAdapter();
      expect(typeof adapter.toolSearchSessions).toBe("function");
    });

    test("returns sessions whose assistant log entry contains a matching tool_call name", () => {
      // Session with a PLANNER_RESPONSE entry carrying tool_calls.
      seedLogEntries(UUID_A, [
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          created_at: ISO_A,
          content: "read the file",
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: ISO_A,
          content: "calling Read",
          tool_calls: [{ name: "Read", args: { path: "/etc/hosts" } }],
        },
      ]);
      // Session with no tool calls.
      seedSession(UUID_B, ISO_B, "just text");

      const adapter = makeAdapter();
      const result = adapter.toolSearchSessions?.({ tool: "Read" }) ?? [];
      const ids = result.map((s) => s.id);
      expect(ids).toContain(UUID_A);
      expect(ids).not.toContain(UUID_B);
    });

    test("returns empty array when no session uses the tool", () => {
      seedSession(UUID_A, ISO_A, "hello");
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
      seedSession(UUID_A, ISO_A, "source");
      const adapter = makeAdapter();

      expect(typeof adapter.forkSession).toBe("function");
      const result = await adapter.forkSession!(UUID_A, "opencode", "oc-main");

      expect(result).toBeDefined();
      expect(result.parentSessionId).toBe(UUID_A);
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

  // --- Gap 5: message parsing — reasoning parts --------------------------

  describe("message parsing — reasoning parts", () => {
    test("assistant PLANNER_RESPONSE entry with a reasoning field surfaces it as a reasoning part", async () => {
      // Field design: logEntry.reasoning (string) → { type:"reasoning", text }.
      // The GREEN phase must add `reasoning?: string` to AntigravityLogEntry.
      seedLogEntries(UUID_A, [
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          created_at: ISO_A,
          content: "why?",
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: ISO_A,
          content: "answer",
          reasoning: "internal chain of thought about why",
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail(UUID_A, {});
      expect(detail.messages).toHaveLength(2);
      const assistantParts = detail.messages![1].parts;
      expect(assistantParts).toEqual(
        expect.arrayContaining([
          { type: "reasoning", text: "internal chain of thought about why" },
        ])
      );
    });
  });

  // --- Gap 6: message parsing — modelID -----------------------------------

  describe("message parsing — modelID", () => {
    test("assistant message carries modelID from logEntry.model", async () => {
      // Field design: logEntry.model (string) → message.modelID.
      // The GREEN phase must add `model?: string` to AntigravityLogEntry.
      seedLogEntries(UUID_A, [
        {
          step_index: 0,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: ISO_A,
          content: "hi",
          model: "gemini-2.5-pro",
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail(UUID_A, {});
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages![0].modelID).toBe("gemini-2.5-pro");
    });
  });

  // --- Gap 7: message parsing — agent field -------------------------------

  describe("message parsing — agent field", () => {
    test("assistant message carries agent from logEntry.agent", async () => {
      // Field design: logEntry.agent (string) → message.agent.
      // The GREEN phase must add `agent?: string` to AntigravityLogEntry.
      seedLogEntries(UUID_A, [
        {
          step_index: 0,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: ISO_A,
          content: "hi",
          agent: "planner",
        },
      ]);
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail(UUID_A, {});
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages![0].agent).toBe("planner");
    });
  });

  // --- Gap 8: parentSessionId extraction ----------------------------------

  describe("parentSessionId extraction", () => {
    test("SessionSummary.parentSessionId is populated from any log entry's parent_session_id", () => {
      // Field design: logEntry.parent_session_id (string) → SessionSummary.parentSessionId.
      // The GREEN phase must add `parent_session_id?: string` to AntigravityLogEntry
      // and extract it first-write-wins across all entries in overview.txt.
      seedLogEntries(UUID_A, [
        {
          step_index: 0,
          source: "SYSTEM",
          type: "START",
          status: "DONE",
          created_at: ISO_A,
          parent_session_id: "parent-of-agy",
        },
        {
          step_index: 1,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          created_at: ISO_A,
          content: "hello",
        },
      ]);
      const adapter = makeAdapter();
      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].parentSessionId).toBe("parent-of-agy");
    });
  });

  // --- Gap 9: getSessionDetail — role filter ------------------------------

  describe("getSessionDetail — role filter", () => {
    // Seed one session with 4 alternating messages (u/a/u/a).
    function seedAlternating(): void {
      seedLogEntries(UUID_A, [
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          created_at: ISO_A,
          content: "msg-1",
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: ISO_A,
          content: "msg-2",
        },
        {
          step_index: 2,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          created_at: ISO_A,
          content: "msg-3",
        },
        {
          step_index: 3,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: ISO_A,
          content: "msg-4",
        },
      ]);
    }

    test("role filter 'user' returns only user messages", async () => {
      seedAlternating();
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail(UUID_A, { role: "user" });
      expect(detail.messages!.every((m) => m.role === "user")).toBe(true);
      expect(detail.messages!.map((m) => m.id)).toEqual(["step-0-0", "step-2-2"]);
    });

    test("role filter 'assistant' returns only assistant messages", async () => {
      seedAlternating();
      const adapter = makeAdapter();
      const detail = await adapter.getSessionDetail(UUID_A, { role: "assistant" });
      expect(detail.messages!.every((m) => m.role === "assistant")).toBe(true);
      expect(detail.messages!.map((m) => m.id)).toEqual(["step-1-1", "step-3-3"]);
    });
  });
});
