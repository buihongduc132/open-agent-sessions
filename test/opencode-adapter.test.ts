import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeAdapter } from "../src/adapters/opencode";
import { OpenCodeAgentEntry } from "../src/config/types";

describe("OpenCode Adapter", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;

  const makeEntry = (alias: string, storage: Record<string, unknown>): OpenCodeAgentEntry => ({
    agent: "opencode",
    alias,
    enabled: true,
    storage: storage as OpenCodeAgentEntry["storage"],
  });

  beforeEach(() => {
    tempDir = join(tmpdir(), `opencode-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "opencode.db");
    db = new Database(dbPath);

    db.run(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL,
        vcs TEXT,
        name TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const seedProject = (id: string, worktree: string) => {
    db.run(`INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)`, [
      id,
      worktree,
      Date.now(),
      Date.now(),
    ]);
  };

  const seedSession = (
    id: string,
    projectId: string,
    title: string,
    directory: string,
    timeCreated: number,
    timeUpdated: number
  ) => {
    db.run(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, projectId, id.slice(0, 8), directory, title, "v1", timeCreated, timeUpdated]
    );
  };

  const seedMessage = (id: string, sessionId: string, role: string, timeCreated: number) => {
    const data = JSON.stringify({ role, time: { created: timeCreated } });
    db.run(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
      [id, sessionId, timeCreated, timeCreated, data]
    );
  };

  const seedPart = (
    id: string,
    messageId: string,
    sessionId: string,
    type: string,
    content: Record<string, unknown>,
    timeCreated: number
  ) => {
    const data = JSON.stringify({ type, ...content });
    db.run(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, messageId, sessionId, timeCreated, timeCreated, data]
    );
  };

  describe("listSessions", () => {
    test("lists sessions for current CWD only", () => {
      const cwd = "/home/user/project-a";
      const projectA = "proj-a-123";
      const projectB = "proj-b-456";

      seedProject(projectA, cwd);
      seedProject(projectB, "/home/user/project-b");

      seedSession("ses-1", projectA, "Fix bug in module A", cwd, 1000, 2000);
      seedSession("ses-2", projectA, "Add feature X", cwd, 3000, 4000);
      seedSession("ses-3", projectB, "Unrelated session", "/home/user/project-b", 5000, 6000);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.id).sort()).toEqual(["ses-1", "ses-2"]);
      expect(sessions[0].agent).toBe("opencode");
      expect(sessions[0].alias).toBe("main");
      expect(sessions[0].storage).toBe("db");
    });

    test("returns empty array when no sessions for CWD", () => {
      const cwd = "/home/user/empty-project";
      seedProject("proj-other", "/home/user/other");

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toEqual([]);
    });

    test("orders sessions by updated_at descending", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-old", projectId, "Old session", cwd, 1000, 2000);
      seedSession("ses-new", projectId, "New session", cwd, 3000, 5000);
      seedSession("ses-mid", projectId, "Mid session", cwd, 2000, 4000);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();

      expect(sessions[0].id).toBe("ses-new");
      expect(sessions[1].id).toBe("ses-mid");
      expect(sessions[2].id).toBe("ses-old");
    });

    test("counts messages from message table", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      seedMessage("msg-1", "ses-1", "user", 1100);
      seedMessage("msg-2", "ses-1", "assistant", 1200);
      seedMessage("msg-3", "ses-1", "user", 1300);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();

      expect(sessions[0].message_count).toBe(3);
    });
  });

  describe("searchSessions", () => {
    test("searches by title with fuzzy match", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Fix critical bug in auth", cwd, 1000, 2000);
      seedSession("ses-2", projectId, "Add new feature", cwd, 3000, 4000);
      seedSession("ses-3", projectId, "Authentication refactor", cwd, 5000, 6000);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const results = adapter.searchSessions({ text: "auth", cwd });

      expect(results).toHaveLength(2);
      expect(results.map((s) => s.id).sort()).toEqual(["ses-1", "ses-3"]);
    });

    test("searches by content in parts", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Generic title", cwd, 1000, 2000);
      seedSession("ses-2", projectId, "Another session", cwd, 3000, 4000);

      seedMessage("msg-1", "ses-1", "user", 1100);
      seedMessage("msg-2", "ses-2", "user", 3100);

      seedPart("prt-1", "msg-1", "ses-1", "text", { text: "How do I implement OAuth?" }, 1150);
      seedPart("prt-2", "msg-2", "ses-2", "text", { text: "Hello world" }, 3150);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const results = adapter.searchSessions({ text: "oauth", cwd });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("ses-1");
    });

    test("returns empty when no matches", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Fix bug", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const results = adapter.searchSessions({ text: "nonexistent", cwd });

      expect(results).toEqual([]);
    });

    test("filters results by CWD (excludes other projects)", () => {
      const cwdA = "/home/user/project-a";
      const cwdB = "/home/user/project-b";
      const projectA = "proj-a";
      const projectB = "proj-b";

      seedProject(projectA, cwdA);
      seedProject(projectB, cwdB);

      seedSession("ses-a1", projectA, "Fix authentication bug", cwdA, 1000, 2000);
      seedSession("ses-a2", projectA, "Auth refactor", cwdA, 3000, 4000);
      seedSession("ses-b1", projectB, "Authentication service", cwdB, 5000, 6000);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd: cwdA });

      const results = adapter.searchSessions({ text: "auth", cwd: cwdA });

      expect(results).toHaveLength(2);
      expect(results.map((s) => s.id).sort()).toEqual(["ses-a1", "ses-a2"]);
      expect(results.find((s) => s.id === "ses-b1")).toBeUndefined();
    });

    test("matches with partial text and spacing differences", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Fix critical bug in auth module", cwd, 1000, 2000);
      seedSession("ses-2", projectId, "Implement user authentication", cwd, 3000, 4000);
      seedSession("ses-3", projectId, "Database connection fix", cwd, 5000, 6000);

      seedMessage("msg-1", "ses-3", "user", 5100);
      seedPart("prt-1", "msg-1", "ses-3", "text", { text: "How to fix  database   connection issues?" }, 5150);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const results = adapter.searchSessions({ text: "databas", cwd });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("ses-3");
    });
  });

  describe("getSessionDetail", () => {
    test("returns last message only with mode=last_message", async () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test session", cwd, 1000, 5000);

      seedMessage("msg-1", "ses-1", "user", 1100);
      seedMessage("msg-2", "ses-1", "assistant", 1200);
      seedMessage("msg-3", "ses-1", "user", 1300);

      seedPart("prt-1", "msg-1", "ses-1", "text", { text: "First message" }, 1150);
      seedPart("prt-2", "msg-2", "ses-1", "text", { text: "Response" }, 1250);
      seedPart("prt-3", "msg-3", "ses-1", "text", { text: "Last message" }, 1350);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const detail = await adapter.getSessionDetail("ses-1", { mode: "last_message" });

      expect(detail.id).toBe("ses-1");
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages?.[0].parts[0].text).toBe("Last message");
    });

    test("returns all messages without tool parts with mode=all_no_tools", async () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test session", cwd, 1000, 5000);

      seedMessage("msg-1", "ses-1", "user", 1100);
      seedMessage("msg-2", "ses-1", "assistant", 1200);

      seedPart("prt-1", "msg-1", "ses-1", "text", { text: "User question" }, 1150);
      seedPart("prt-2", "msg-2", "ses-1", "text", { text: "Response text" }, 1250);
      seedPart("prt-3", "msg-2", "ses-1", "tool", { tool: "bash", state: { status: "completed" } }, 1350);
      seedPart("prt-4", "msg-2", "ses-1", "step-start", {}, 1400);
      seedPart("prt-5", "msg-2", "ses-1", "step-finish", {}, 1450);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const detail = await adapter.getSessionDetail("ses-1", { mode: "all_no_tools" });

      expect(detail.messages).toHaveLength(2);
      expect(detail.messages?.[0].parts).toHaveLength(1);
      expect(detail.messages?.[1].parts).toHaveLength(1);
      expect(detail.messages?.[1].parts[0].type).toBe("text");

      const allParts = detail.messages?.flatMap((m) => m.parts) || [];
      expect(allParts.find((p) => p.type === "tool")).toBeUndefined();
      expect(allParts.find((p) => p.type === "step-start")).toBeUndefined();
      expect(allParts.find((p) => p.type === "step-finish")).toBeUndefined();
    });

    test("returns all messages with tools with mode=all_with_tools", async () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test session", cwd, 1000, 5000);

      seedMessage("msg-1", "ses-1", "user", 1100);
      seedMessage("msg-2", "ses-1", "assistant", 1200);

      seedPart("prt-1", "msg-1", "ses-1", "text", { text: "User question" }, 1150);
      seedPart("prt-2", "msg-2", "ses-1", "text", { text: "Response" }, 1250);
      seedPart("prt-3", "msg-2", "ses-1", "tool", { tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "file1\nfile2" } }, 1350);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const detail = await adapter.getSessionDetail("ses-1", { mode: "all_with_tools" });

      expect(detail.messages).toHaveLength(2);
      expect(detail.messages?.[1].parts).toHaveLength(2);

      const toolPart = detail.messages?.[1].parts.find((p) => p.type === "tool");
      expect(toolPart).toBeDefined();
      expect(toolPart?.tool).toBe("bash");
      expect(toolPart?.state?.input?.command).toBe("ls");
      expect(toolPart?.state?.output).toBe("file1\nfile2");
    });

    test("includes session metadata", async () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";

      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test session", cwd, 1000, 5000);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const detail = await adapter.getSessionDetail("ses-1", { mode: "last_message" });

      expect(detail.id).toBe("ses-1");
      expect(detail.title).toBe("Test session");
      expect(detail.agent).toBe("opencode");
      expect(detail.alias).toBe("main");
      expect(detail.storage).toBe("db");
    });

    test("throws when session not found", async () => {
      const cwd = "/home/user/project";
      seedProject("proj-1", cwd);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      expect(adapter.getSessionDetail("ses-nonexistent", { mode: "last_message" })).rejects.toThrow(
        /not found/
      );
    });
  });

  describe("error handling", () => {
    test("throws when db path does not exist", () => {
      const entry = makeEntry("main", { mode: "auto", db_path: "/nonexistent/path.db" });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/not found/);
    });

    test("throws when agent is not opencode", () => {
      const entry = { agent: "codex", alias: "main", enabled: true } as OpenCodeAgentEntry;
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/opencode/);
    });
  });
});
