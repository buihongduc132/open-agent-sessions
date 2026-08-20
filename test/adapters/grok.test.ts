/**
 * Grok Adapter Tests — RED PHASE
 *
 * These tests describe the contract the GREEN-phase grok adapter must satisfy.
 * Against the current stub (createGrokAdapter throws "not implemented (RED)"),
 * every test FAILS — that is intentional.
 *
 * The fixture layout mirrors live ~/.grok/sessions:
 *   <root>/<url-encoded-cwd>/<uuid>/{summary.json,chat_history.jsonl}
 *
 * message_count is the number of SessionMessages getSessionDetail would return
 * for default options `{}`. For the full chat fixture that is 3: system + user
 * + assistant (reasoning is a part, tool_result is attached to the tool part).
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrokAdapter } from "../../src/adapters/grok";
import type { SessionDetail, SessionPart } from "../../src/core/types";

// ---------------------------------------------------------------------------
// Distinctive strings the GREEN parser MUST surface
// ---------------------------------------------------------------------------

const USER_QUERY = "search remotely for the way grok cli session structured";
const ASSISTANT_REPLY = "I'll start by researching Grok CLI session structure";
const REASONING_TEXT = "The user wants me to complete a comprehensive goal";
const TOOL_RESULT_TEXT = "Todos updated";
const TOOL_CALL_ID = "call-todo-1";
const TOOL_ARGUMENTS = JSON.stringify({
  todos: [{ id: "1", content: "research grok sessions", status: "in_progress" }],
});

const ENCODED_CWD = encodeURIComponent("/home/proj");

const OLDER_ID = "0198f000-0000-7000-8000-000000000001";
const NEWER_ID = "01a01eee-e88c-7382-a502-ef19db9f1ee2";
const ORPHAN_DIR_ID = "0198dead-0000-7000-8000-00000000dead";

const OLDER_CREATED = "2026-08-20T11:29:28.000Z";
const OLDER_UPDATED = "2026-08-20T11:30:00.000Z";
const NEWER_CREATED = "2026-08-20T11:29:28.783183108Z"; // nanosecond fractional seconds
const NEWER_UPDATED = "2026-08-20T11:40:52.000Z";

const OLDER_MS = Date.parse(OLDER_UPDATED);
const NEWER_MS = Date.parse(NEWER_UPDATED);

const OLDER_TITLE = "Older grok session";
const NEWER_TITLE = "Grok CLI session structure";

type TestEntry = { agent: "grok"; alias: string; enabled: boolean; path?: string };

type SeedOpts = {
  encodedCwd: string;
  id: string;
  title?: string;
  sessionSummary?: string;
  createdAt: string;
  updatedAt: string;
  parentSessionId?: string;
  chatLines?: unknown[];
  numMessages?: number;
  numChatMessages?: number;
};

function seedGrokSession(root: string, opts: SeedOpts): string {
  const dir = join(root, opts.encodedCwd, opts.id);
  mkdirSync(dir, { recursive: true });

  const chatLines = opts.chatLines ?? [];
  const summary = {
    info: { id: opts.id, cwd: "/home/proj" },
    session_summary: opts.sessionSummary ?? opts.title ?? "",
    created_at: opts.createdAt,
    updated_at: opts.updatedAt,
    num_messages: opts.numMessages ?? chatLines.length,
    num_chat_messages: opts.numChatMessages ?? chatLines.length,
    current_model_id: "grok-4.6",
    generated_title: opts.title ?? "",
    ...(opts.parentSessionId ? { parent_session_id: opts.parentSessionId } : {}),
  };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  const payload = chatLines.map((line) => JSON.stringify(line)).join("\n");
  writeFileSync(join(dir, "chat_history.jsonl"), payload ? `${payload}\n` : "");
  return dir;
}

function fullChatLines(): unknown[] {
  return [
    { type: "system", content: "You are Grok, a coding agent running in the Codex CLI." },
    {
      type: "user",
      content: [{ type: "text", text: USER_QUERY }],
    },
    {
      type: "reasoning",
      id: "rs_test_1",
      summary: [{ type: "summary_text", text: REASONING_TEXT }],
      status: "completed",
    },
    {
      type: "assistant",
      content: ASSISTANT_REPLY,
      tool_calls: [
        {
          id: TOOL_CALL_ID,
          name: "todo_write",
          arguments: TOOL_ARGUMENTS,
        },
      ],
      model_id: "grok-4.6",
    },
    {
      type: "tool_result",
      tool_call_id: TOOL_CALL_ID,
      content: TOOL_RESULT_TEXT,
    },
  ];
}

function seedTwoSessions(root: string): void {
  seedGrokSession(root, {
    encodedCwd: ENCODED_CWD,
    id: OLDER_ID,
    title: OLDER_TITLE,
    createdAt: OLDER_CREATED,
    updatedAt: OLDER_UPDATED,
    chatLines: [
      {
        type: "user",
        content: [{ type: "text", text: "hello from the older grok session" }],
      },
    ],
    numChatMessages: 1,
  });

  seedGrokSession(root, {
    encodedCwd: ENCODED_CWD,
    id: NEWER_ID,
    title: NEWER_TITLE,
    createdAt: NEWER_CREATED,
    updatedAt: NEWER_UPDATED,
    parentSessionId: OLDER_ID,
    chatLines: fullChatLines(),
    numMessages: 5,
    numChatMessages: 3,
  });
}

function seedNoise(root: string): void {
  const group = join(root, ENCODED_CWD);
  mkdirSync(group, { recursive: true });
  writeFileSync(join(group, "prompt_history.jsonl"), `${JSON.stringify({ prompt: "not a session" })}\n`);
  writeFileSync(join(group, "session.lock"), "lock");
  const orphan = join(group, ORPHAN_DIR_ID);
  mkdirSync(orphan, { recursive: true });
  writeFileSync(
    join(orphan, "chat_history.jsonl"),
    `${JSON.stringify({ type: "user", content: [{ type: "text", text: "orphan without summary" }] })}\n`
  );
}

function makeAdapter(root: string) {
  return createGrokAdapter(
    { agent: "grok", alias: "test", enabled: true } as TestEntry,
    { sessionsDir: root }
  );
}

function expectValidIso(value: string): void {
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  const parseable = value.replace(/(\.\d{3})\d+/, "$1");
  expect(Number.isNaN(Date.parse(parseable))).toBe(false);
}

function allParts(detail: SessionDetail): SessionPart[] {
  return (detail.messages ?? []).flatMap((m) => m.parts);
}

describe("grok adapter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "oas-grok-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Failure paths FIRST (worst-first testing)
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("does not throw at construction when sessions path is missing (OT4); listSessions throws /not found/i", () => {
      const missing = join(tmpDir, "does-not-exist");
      let adapter: ReturnType<typeof createGrokAdapter> | undefined;
      expect(() => {
        adapter = createGrokAdapter(
          { agent: "grok", alias: "test", enabled: true } as TestEntry,
          { sessionsDir: missing }
        );
      }).not.toThrow();
      expect(() => adapter!.listSessions()).toThrow(/not found/i);
    });

    it("does not throw at construction when path is a file, not a directory (OT4)", () => {
      const filePath = join(tmpDir, "not-a-dir");
      writeFileSync(filePath, "I am a file");
      let adapter: ReturnType<typeof createGrokAdapter> | undefined;
      expect(() => {
        adapter = createGrokAdapter(
          { agent: "grok", alias: "test", enabled: true } as TestEntry,
          { sessionsDir: filePath }
        );
      }).not.toThrow();
      expect(() => adapter!.listSessions()).toThrow(/not a directory|not found|ENOTDIR|is a file/i);
    });

    it("getSessionDetail unknown id rejects with /session not found/i", async () => {
      seedTwoSessions(tmpDir);
      await expect(
        makeAdapter(tmpDir).getSessionDetail!("does-not-exist", {})
      ).rejects.toThrow(/session not found/i);
    });

    it("throws /requires agent \"grok\"/ when entry.agent is not grok", () => {
      expect(() => {
        const adapter = createGrokAdapter(
          { agent: "claude", alias: "test", enabled: true } as unknown as TestEntry
        );
        adapter.listSessions();
      }).toThrow(/requires agent "grok"/);
    });
  });

  // -------------------------------------------------------------------------
  // listSessions
  // -------------------------------------------------------------------------

  describe("listSessions", () => {
    it("returns two seeded sessions, newest first", () => {
      seedTwoSessions(tmpDir);
      const sessions = makeAdapter(tmpDir).listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe(NEWER_ID);
      expect(sessions[1].id).toBe(OLDER_ID);
    });

    it("maps summary fields (agent, alias, generated_title, ISO times, message_count, jsonl)", () => {
      seedTwoSessions(tmpDir);
      const sessions = makeAdapter(tmpDir).listSessions();
      const newer = sessions[0];
      const older = sessions[1];

      expect(newer.agent).toBe("grok");
      expect(newer.alias).toBe("test");
      expect(newer.title).toBe(NEWER_TITLE);
      expect(newer.storage).toBe("jsonl");
      expectValidIso(newer.created_at);
      expectValidIso(newer.updated_at);
      // Nanosecond created_at from summary.json must be accepted (raw or truncated).
      expect(newer.created_at.startsWith("2026-08-20T11:29:28")).toBe(true);
      expect(newer.message_count).toBe(3);

      expect(older.id).toBe(OLDER_ID);
      expect(older.agent).toBe("grok");
      expect(older.alias).toBe("test");
      expect(older.title).toBe(OLDER_TITLE);
      expect(older.storage).toBe("jsonl");
      expectValidIso(older.created_at);
      expectValidIso(older.updated_at);
      expect(older.message_count).toBe(1);
    });

    it("ignores prompt_history.jsonl at the cwd-group level", () => {
      seedTwoSessions(tmpDir);
      seedNoise(tmpDir);
      const sessions = makeAdapter(tmpDir).listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.id).sort()).toEqual([NEWER_ID, OLDER_ID].sort());
    });

    it("ignores dirs without summary.json", () => {
      seedTwoSessions(tmpDir);
      seedNoise(tmpDir);
      const sessions = makeAdapter(tmpDir).listSessions();
      expect(sessions.map((s) => s.id)).not.toContain(ORPHAN_DIR_ID);
    });

    it("populates parentSessionId when summary.json has parent_session_id", () => {
      seedTwoSessions(tmpDir);
      const sessions = makeAdapter(tmpDir).listSessions();
      const newer = sessions.find((s) => s.id === NEWER_ID)!;
      const older = sessions.find((s) => s.id === OLDER_ID)!;
      expect(newer.parentSessionId).toBe(OLDER_ID);
      expect(older.parentSessionId).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // listSessionsByTimeRange
  // -------------------------------------------------------------------------

  describe("listSessionsByTimeRange", () => {
    it("filters on updated_at with since/until inclusive", () => {
      seedTwoSessions(tmpDir);
      const adapter = makeAdapter(tmpDir);

      const onlyOlder = adapter.listSessionsByTimeRange!({
        since: OLDER_MS,
        until: OLDER_MS,
      });
      expect(onlyOlder).toHaveLength(1);
      expect(onlyOlder[0].id).toBe(OLDER_ID);

      const onlyNewer = adapter.listSessionsByTimeRange!({
        since: NEWER_MS,
        until: NEWER_MS,
      });
      expect(onlyNewer).toHaveLength(1);
      expect(onlyNewer[0].id).toBe(NEWER_ID);

      const both = adapter.listSessionsByTimeRange!({
        since: OLDER_MS,
        until: NEWER_MS,
      });
      expect(both).toHaveLength(2);
      expect(both[0].id).toBe(NEWER_ID);
      expect(both[1].id).toBe(OLDER_ID);
    });

    it("honours limit, newest first", () => {
      seedTwoSessions(tmpDir);
      const limited = makeAdapter(tmpDir).listSessionsByTimeRange!({
        since: OLDER_MS,
        until: NEWER_MS,
        limit: 1,
      });
      expect(limited).toHaveLength(1);
      expect(limited[0].id).toBe(NEWER_ID);
    });

    it("honours skipSessionId", () => {
      seedTwoSessions(tmpDir);
      const skipped = makeAdapter(tmpDir).listSessionsByTimeRange!({
        since: OLDER_MS,
        until: NEWER_MS,
        skipSessionId: NEWER_ID,
      });
      expect(skipped).toHaveLength(1);
      expect(skipped[0].id).toBe(OLDER_ID);
    });
  });

  // -------------------------------------------------------------------------
  // getSessionDetail
  // -------------------------------------------------------------------------

  describe("getSessionDetail", () => {
    it("parses chat_history into system/user/reasoning/tool messages", async () => {
      seedTwoSessions(tmpDir);
      const detail = await makeAdapter(tmpDir).getSessionDetail!(NEWER_ID, {
        mode: "all_with_tools",
      });

      const blob = JSON.stringify(detail.messages);
      expect(blob).toContain(USER_QUERY);
      expect(blob).toContain(ASSISTANT_REPLY);

      const system = detail.messages!.find((m) => m.role === "system");
      expect(system).toBeDefined();
      const systemText = system!.parts.find((p) => p.type === "text") as { type: "text"; text: string };
      expect(systemText?.text).toMatch(/You are Grok/i);

      const user = detail.messages!.find((m) => m.role === "user");
      expect(user).toBeDefined();
      const userText = user!.parts.find((p) => p.type === "text") as { type: "text"; text: string };
      expect(userText?.text).toContain(USER_QUERY);

      const parts = allParts(detail);
      const reasoning = parts.find((p) => p.type === "reasoning") as { type: "reasoning"; text: string };
      expect(reasoning).toBeDefined();
      expect(reasoning.text).toContain(REASONING_TEXT);

      const toolPart = parts.find((p) => p.type === "tool") as {
        type: "tool";
        tool: string;
        state: Record<string, unknown>;
      };
      expect(toolPart).toBeDefined();
      expect(toolPart.tool).toBe("todo_write");
      expect(toolPart.state.arguments).toBeDefined();
      expect(JSON.stringify(toolPart.state)).toContain(TOOL_RESULT_TEXT);

      const assistant = detail.messages!.find(
        (m) => m.role === "assistant" && m.parts.some((p) => p.type === "text")
      );
      expect(assistant).toBeDefined();
      const assistantText = assistant!.parts.find((p) => p.type === "text") as {
        type: "text";
        text: string;
      };
      expect(assistantText?.text).toContain(ASSISTANT_REPLY);
    });

    it("mode last_message returns only the last SessionMessage", async () => {
      seedTwoSessions(tmpDir);
      const detail = await makeAdapter(tmpDir).getSessionDetail!(NEWER_ID, {
        mode: "last_message",
      });
      expect(detail.messages).toHaveLength(1);
      expect(JSON.stringify(detail.messages)).toContain(ASSISTANT_REPLY);
    });

    it("mode all_no_tools strips tool parts but keeps text/reasoning", async () => {
      seedTwoSessions(tmpDir);
      const detail = await makeAdapter(tmpDir).getSessionDetail!(NEWER_ID, {
        mode: "all_no_tools",
      });
      const parts = allParts(detail);
      expect(parts.some((p) => p.type === "tool")).toBe(false);
      expect(parts.some((p) => p.type === "text")).toBe(true);
      expect(parts.some((p) => p.type === "reasoning")).toBe(true);
      expect(JSON.stringify(detail.messages)).toContain(USER_QUERY);
      expect(JSON.stringify(detail.messages)).toContain(ASSISTANT_REPLY);
      expect(JSON.stringify(detail.messages)).toContain(REASONING_TEXT);
    });

    it("role: \"user\" filters to user messages", async () => {
      seedTwoSessions(tmpDir);
      const detail = await makeAdapter(tmpDir).getSessionDetail!(NEWER_ID, {
        role: "user",
      });
      expect(detail.messages!.length).toBeGreaterThan(0);
      expect(detail.messages!.every((m) => m.role === "user")).toBe(true);
      expect(JSON.stringify(detail.messages)).toContain(USER_QUERY);
    });

    it("userOnly filters to user messages", async () => {
      seedTwoSessions(tmpDir);
      const detail = await makeAdapter(tmpDir).getSessionDetail!(NEWER_ID, {
        userOnly: true,
      });
      expect(detail.messages!.length).toBeGreaterThan(0);
      expect(detail.messages!.every((m) => m.role === "user")).toBe(true);
      expect(JSON.stringify(detail.messages)).toContain(USER_QUERY);
    });
  });

  // -------------------------------------------------------------------------
  // searchSessions
  // -------------------------------------------------------------------------

  describe("searchSessions", () => {
    it("matches title case-insensitively", () => {
      seedTwoSessions(tmpDir);
      const results = makeAdapter(tmpDir).searchSessions!({ text: "CLI SESSION STRUCTURE" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(NEWER_ID);
    });

    it("matches chat_history user text", () => {
      seedTwoSessions(tmpDir);
      const results = makeAdapter(tmpDir).searchSessions!({ text: "search remotely" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(NEWER_ID);
    });

    it("returns [] when nothing matches", () => {
      seedTwoSessions(tmpDir);
      const results = makeAdapter(tmpDir).searchSessions!({ text: "zzzz-no-such-grok-text" });
      expect(results).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // toolSearchSessions
  // -------------------------------------------------------------------------

  describe("toolSearchSessions", () => {
    it("matches assistant.tool_calls[].name case-insensitively", () => {
      seedTwoSessions(tmpDir);
      const results = makeAdapter(tmpDir).toolSearchSessions!({ tool: "TODO_WRITE" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(NEWER_ID);
    });

    it("returns [] when no tool matches", () => {
      seedTwoSessions(tmpDir);
      const results = makeAdapter(tmpDir).toolSearchSessions!({ tool: "definitely_not_a_tool" });
      expect(results).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // forkSession
  // -------------------------------------------------------------------------

  describe("forkSession", () => {
    it("returns a well-formed ForkResult with parentSessionId = source id", async () => {
      seedTwoSessions(tmpDir);
      const result = await makeAdapter(tmpDir).forkSession!(NEWER_ID, "grok", "test");
      expect(result.parentSessionId).toBe(NEWER_ID);
      expect(result.newSessionId).toMatch(/^grok-fork-\d+$/);
      expect(result.destAgent).toBe("grok");
      expect(result.destAlias).toBe("test");
      expectValidIso(result.forkedAt);
    });
  });
});
