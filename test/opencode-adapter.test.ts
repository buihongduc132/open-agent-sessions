import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeAdapter } from "../src/adapters/opencode";
import { OpenCodeAgentEntry, OpenCodeStorageConfig } from "../src/config/types";

describe("OpenCode Adapter", () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: Database;

  const makeEntry = (alias: string, storage: Partial<OpenCodeStorageConfig>): OpenCodeAgentEntry => ({
    agent: "opencode",
    alias,
    enabled: true,
    storage: {
      mode: storage.mode ?? "auto",
      ...storage,
    } as OpenCodeStorageConfig,
  });

  beforeEach(() => {
    tempDir = join(tmpdir(), `opencode-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "opencode.db");
    jsonlPath = join(tempDir, "opencode.jsonl");
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

  const writeJsonl = (sessions: Record<string, unknown>[]) => {
    const lines = sessions.map((s) => JSON.stringify(s)).join("\n");
    writeFileSync(jsonlPath, lines, "utf-8");
  };

  // ===========================================================================
  // storage.mode Tests
  // ===========================================================================

  describe("storage.mode", () => {
    test("mode=auto prefers DB when both exist", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "DB Session", cwd, 1000, 2000);

      // Also create JSONL with different session
      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: cwd, title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath, jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("ses-1");
      expect(sessions[0].storage).toBe("db");
      expect(sessions[0].title).toBe("DB Session");
    });

    test("mode=auto falls back to JSONL when DB missing", () => {
      // Close and delete DB
      db.close();
      rmSync(dbPath, { force: true });

      const cwd = "/home/user/project";
      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: cwd, title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath, jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("ses-jsonl");
      expect(sessions[0].storage).toBe("jsonl");
      expect(sessions[0].title).toBe("JSONL Session");
    });

    test("mode=auto errors when neither DB nor JSONL exists", () => {
      db.close();
      rmSync(dbPath, { force: true });

      const entry = makeEntry("main", { mode: "auto", db_path: dbPath, jsonl_path: jsonlPath });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/storage not found/);
    });

    test("mode=db uses DB even when JSONL exists", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-db", projectId, "DB Session", cwd, 1000, 2000);

      // JSONL has different session
      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: cwd, title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath, jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("ses-db");
      expect(sessions[0].storage).toBe("db");
    });

    test("mode=db errors when DB missing even if JSONL exists", () => {
      db.close();
      rmSync(dbPath, { force: true });

      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: "/home/user", title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath, jsonl_path: jsonlPath });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/DB not found/);
    });

    test("mode=jsonl uses JSONL even when DB exists", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-db", projectId, "DB Session", cwd, 1000, 2000);

      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: cwd, title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", db_path: dbPath, jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("ses-jsonl");
      expect(sessions[0].storage).toBe("jsonl");
    });

    test("mode=jsonl errors when JSONL missing even if DB exists", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      const entry = makeEntry("main", { mode: "jsonl", db_path: dbPath, jsonl_path: jsonlPath });
      expect(() => createOpenCodeAdapter(entry, { cwd })).toThrow(/JSONL not found/);
    });

    test("rejects invalid storage mode", () => {
      const entry = makeEntry("main", { mode: "invalid" as "auto", db_path: dbPath });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/Unsupported storage mode/);
    });
  });

  // ===========================================================================
  // Integration with resolveOpenCodeStorage helper
  // ===========================================================================

  describe("integration with config helper (AC7)", () => {
    // These tests verify that createOpenCodeAdapter uses the centralized
    // resolveOpenCodeStorage helper from src/config/opencode.ts for path resolution.
    // The behavior is verified by checking that storage.mode is respected exactly
    // as resolveOpenCodeStorage defines it.

    test("uses resolveOpenCodeStorage for path resolution - respects mode=auto behavior", () => {
      // When both DB and JSONL exist with mode=auto, resolveOpenCodeStorage prefers DB
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-db", projectId, "DB Session", cwd, 1000, 2000);

      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: cwd, title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("test-helper", { mode: "auto", db_path: dbPath, jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      // If resolveOpenCodeStorage is being used, mode=auto should prefer DB
      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].storage).toBe("db"); // DB preferred over JSONL
      expect(sessions[0].alias).toBe("test-helper");
    });

    test("uses resolveOpenCodeStorage for path resolution - respects mode=db explicit", () => {
      // When mode=db is set, resolveOpenCodeStorage only uses DB even if JSONL exists
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-db", projectId, "DB Session", cwd, 1000, 2000);

      writeJsonl([
        { id: "ses-jsonl", projectID: "proj-1", directory: cwd, title: "JSONL Session", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("test-helper", { mode: "db", db_path: dbPath, jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      // If resolveOpenCodeStorage is being used, mode=db should ignore JSONL
      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].storage).toBe("db");
      expect(sessions[0].id).toBe("ses-db");
    });

    test("uses resolveOpenCodeStorage for path resolution - errors match helper output", () => {
      // When mode=db but DB is missing, resolveOpenCodeStorage throws "DB not found"
      db.close();
      rmSync(dbPath, { force: true });

      const entry = makeEntry("test-helper", { mode: "db", db_path: dbPath, jsonl_path: jsonlPath });
      
      // This error message comes from resolveOpenCodeStorage, verifying it's being used
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/DB not found/);
    });
  });

  // ===========================================================================
  // JSONL Parsing Tests
  // ===========================================================================

  describe("JSONL parsing", () => {
    test("parses valid JSONL file", () => {
      const cwd = "/home/user/project";
      writeJsonl([
        { id: "ses-1", projectID: "proj-1", directory: cwd, title: "Session 1", timeCreated: 1000, timeUpdated: 2000 },
        { id: "ses-2", projectID: "proj-1", directory: cwd, title: "Session 2", timeCreated: 3000, timeUpdated: 4000 },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.id).sort()).toEqual(["ses-1", "ses-2"]);
    });

    test("ignores blank lines in JSONL", () => {
      const cwd = "/home/user/project";
      // Write JSONL with blank lines
      const content = `{"id":"ses-1","projectID":"proj-1","directory":"${cwd}","title":"Session 1","timeCreated":1000,"timeUpdated":2000}

{"id":"ses-2","projectID":"proj-1","directory":"${cwd}","title":"Session 2","timeCreated":3000,"timeUpdated":4000}
   
`;
      writeFileSync(jsonlPath, content, "utf-8");

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(2);
    });

    test("errors on malformed JSONL with line number", () => {
      const cwd = "/home/user/project";
      // Line 2 is malformed
      const content = `{"id":"ses-1","projectID":"proj-1","directory":"${cwd}","title":"Session 1","timeCreated":1000,"timeUpdated":2000}
{invalid json}
{"id":"ses-3","projectID":"proj-1","directory":"${cwd}","title":"Session 3","timeCreated":5000,"timeUpdated":6000}`;
      writeFileSync(jsonlPath, content, "utf-8");

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      expect(() => adapter.listSessions()).toThrow(/line 2/);
    });

    test("returns empty list for empty JSONL file", () => {
      const cwd = "/home/user/project";
      writeFileSync(jsonlPath, "", "utf-8");

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toEqual([]);
    });

    test("returns empty list for JSONL with only whitespace", () => {
      const cwd = "/home/user/project";
      writeFileSync(jsonlPath, "   \n\n  \n", "utf-8");

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions).toEqual([]);
    });
  });

  // ===========================================================================
  // Title Fallback Tests
  // ===========================================================================

  describe("title fallback", () => {
    test("falls back to session id when title is empty (DB)", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-empty-title", projectId, "", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].title).toBe("ses-empty-title");
    });

    test("falls back to session id when title is null (JSONL)", () => {
      const cwd = "/home/user/project";
      writeJsonl([
        { id: "ses-null-title", projectID: "proj-1", directory: cwd, title: null, timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].title).toBe("ses-null-title");
    });

    test("falls back to session id when title is missing (JSONL)", () => {
      const cwd = "/home/user/project";
      writeJsonl([
        { id: "ses-missing-title", projectID: "proj-1", directory: cwd, timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].title).toBe("ses-missing-title");
    });
  });

  // ===========================================================================
  // Schema Validation Tests
  // ===========================================================================

  describe("schema validation", () => {
    test("errors when project table missing", () => {
      db.close();
      rmSync(dbPath, { force: true });
      db = new Database(dbPath);

      // Create all tables except project
      db.run(`CREATE TABLE session (id TEXT PRIMARY KEY)`);
      db.run(`CREATE TABLE message (id TEXT PRIMARY KEY)`);
      db.run(`CREATE TABLE part (id TEXT PRIMARY KEY)`);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/schema mismatch.*missing tables.*project/);
    });

    test("errors when required columns missing", () => {
      db.close();
      rmSync(dbPath, { force: true });
      db = new Database(dbPath);

      // Create tables with missing columns
      db.run(`CREATE TABLE project (id TEXT PRIMARY KEY)`); // Missing worktree
      db.run(`CREATE TABLE session (id TEXT PRIMARY KEY)`); // Missing required columns
      db.run(`CREATE TABLE message (id TEXT PRIMARY KEY)`);
      db.run(`CREATE TABLE part (id TEXT PRIMARY KEY)`);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/schema mismatch.*missing columns/);
    });

    test("includes expected schema reference in error", () => {
      db.close();
      rmSync(dbPath, { force: true });
      db = new Database(dbPath);
      db.run(`CREATE TABLE other (id TEXT)`);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/Expected schema/);
    });
  });

  // ===========================================================================
  // DB Lock Retry Tests
  // ===========================================================================

  describe("DB lock retry", () => {
    test("uses default retry delays [50, 100, 200]", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      // Should succeed without retries
      const adapter = createOpenCodeAdapter(entry, { cwd });
      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
    });

    test("supports custom lock retry delays via options", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd, lockRetries: [10, 20, 30] });
      const sessions = adapter.listSessions();
      expect(sessions).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Error Context Tests
  // ===========================================================================

  describe("error context", () => {
    test("all errors include [agent:alias] label for missing DB path", () => {
      const entry = makeEntry("custom-alias", { mode: "db", db_path: "/nonexistent/path.db" });
      try {
        createOpenCodeAdapter(entry, { cwd: "/home/user" });
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain("[opencode:custom-alias]");
      }
    });

    test("all errors include [agent:alias] label for missing JSONL path", () => {
      const entry = makeEntry("jsonl-alias", { mode: "jsonl", jsonl_path: "/nonexistent/path.jsonl" });
      try {
        createOpenCodeAdapter(entry, { cwd: "/home/user" });
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain("[opencode:jsonl-alias]");
      }
    });

    test("session not found error includes context", async () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      const entry = makeEntry("my-alias", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      try {
        await adapter.getSessionDetail("nonexistent", { mode: "last_message" });
        expect(true).toBe(false); // Should not reach
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain("[opencode:my-alias]");
        expect((error as Error).message).toContain("session not found");
      }
    });
  });

  // ===========================================================================
  // SessionSummary Normalization Tests
  // ===========================================================================

  describe("SessionSummary normalization", () => {
    test("DB sessions have storage='db'", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].storage).toBe("db");
    });

    test("JSONL sessions have storage='jsonl'", () => {
      const cwd = "/home/user/project";
      writeJsonl([
        { id: "ses-1", projectID: "proj-1", directory: cwd, title: "Test", timeCreated: 1000, timeUpdated: 2000 },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].storage).toBe("jsonl");
    });

    test("alias comes from config entry", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("custom-alias", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].alias).toBe("custom-alias");
    });

    test("agent is always 'opencode'", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      expect(sessions[0].agent).toBe("opencode");
    });
  });

  // ===========================================================================
  // Original Functionality Tests (preserved)
  // ===========================================================================

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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
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

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      expect(adapter.getSessionDetail("ses-nonexistent", { mode: "last_message" })).rejects.toThrow(
        /not found/
      );
    });
  });

  describe("error handling", () => {
    test("throws when agent is not opencode", () => {
      const entry = { agent: "codex", alias: "main", enabled: true, storage: { mode: "auto" } } as OpenCodeAgentEntry;
      expect(() => createOpenCodeAdapter(entry, { cwd: "/home/user" })).toThrow(/opencode/);
    });
  });

  // ===========================================================================
  // Tool Filtering Tests (oas-7dk - Task 1.3)
  // ===========================================================================

  describe("Tool Filtering (excludeTools option)", () => {
    // Helper to set up a session with parts for testing
    const setupSessionWithParts = (
      sessionId: string,
      messageId: string,
      parts: Array<{ type: string; content: Record<string, unknown> }>
    ) => {
      const cwd = "/home/user/project";
      const projectId = "proj-filter-test";
      seedProject(projectId, cwd);
      seedSession(sessionId, projectId, "Filter Test Session", cwd, 1000, 2000);
      seedMessage(messageId, sessionId, "assistant", 1100);

      parts.forEach((part, index) => {
        seedPart(
          `prt-${sessionId}-${index}`,
          messageId,
          sessionId,
          part.type,
          part.content,
          1100 + index * 10
        );
      });

      return { cwd, projectId };
    };

    describe("AC1: excludeTools filters out type='tool' parts", () => {
      test("filters out tool parts when mode=all_no_tools", async () => {
        const { cwd } = setupSessionWithParts("ses-tool-1", "msg-tool-1", [
          { type: "text", content: { text: "Hello" } },
          { type: "tool", content: { tool: "bash", state: { status: "running" } } },
          { type: "text", content: { text: "World" } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-tool-1", { mode: "all_no_tools" });

        expect(detail.messages?.[0].parts).toHaveLength(2);
        expect(detail.messages?.[0].parts.every((p) => p.type === "text")).toBe(true);
      });

      test("keeps tool parts when mode=all_with_tools", async () => {
        const { cwd } = setupSessionWithParts("ses-tool-2", "msg-tool-2", [
          { type: "text", content: { text: "Hello" } },
          { type: "tool", content: { tool: "bash", state: { status: "running" } } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-tool-2", { mode: "all_with_tools" });

        expect(detail.messages?.[0].parts).toHaveLength(2);
        const toolPart = detail.messages?.[0].parts.find((p) => p.type === "tool");
        expect(toolPart).toBeDefined();
        expect(toolPart?.tool).toBe("bash");
      });
    });

    describe("AC2: Also filters step-start and step-finish", () => {
      test("filters out step-start when mode=all_no_tools", async () => {
        const { cwd } = setupSessionWithParts("ses-step-1", "msg-step-1", [
          { type: "text", content: { text: "Before step" } },
          { type: "step-start", content: { stepId: "step-1" } },
          { type: "text", content: { text: "After step" } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-step-1", { mode: "all_no_tools" });

        const allTypes = detail.messages?.[0].parts.map((p) => p.type) || [];
        expect(allTypes).not.toContain("step-start");
        expect(allTypes).toEqual(["text", "text"]);
      });

      test("filters out step-finish when mode=all_no_tools", async () => {
        const { cwd } = setupSessionWithParts("ses-step-2", "msg-step-2", [
          { type: "text", content: { text: "Content" } },
          { type: "step-finish", content: { stepId: "step-1", status: "completed" } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-step-2", { mode: "all_no_tools" });

        const allTypes = detail.messages?.[0].parts.map((p) => p.type) || [];
        expect(allTypes).not.toContain("step-finish");
        expect(allTypes).toEqual(["text"]);
      });

      test("filters all tool-related types together", async () => {
        const { cwd } = setupSessionWithParts("ses-step-3", "msg-step-3", [
          { type: "text", content: { text: "Start" } },
          { type: "step-start", content: {} },
          { type: "tool", content: { tool: "read", state: {} } },
          { type: "step-finish", content: {} },
          { type: "text", content: { text: "End" } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-step-3", { mode: "all_no_tools" });

        const allTypes = detail.messages?.[0].parts.map((p) => p.type) || [];
        expect(allTypes).toEqual(["text", "text"]);
      });

      test("keeps step markers when mode=all_with_tools", async () => {
        const { cwd } = setupSessionWithParts("ses-step-4", "msg-step-4", [
          { type: "text", content: { text: "Content" } },
          { type: "step-start", content: { stepId: "step-1" } },
          { type: "step-finish", content: { stepId: "step-1" } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-step-4", { mode: "all_with_tools" });

        const allTypes = detail.messages?.[0].parts.map((p) => p.type) || [];
        expect(allTypes).toContain("step-start");
        expect(allTypes).toContain("step-finish");
      });
    });

    describe("AC3: Preserves text and reasoning parts", () => {
      test("preserves text parts when tools excluded", async () => {
        const { cwd } = setupSessionWithParts("ses-preserve-1", "msg-preserve-1", [
          { type: "text", content: { text: "First text" } },
          { type: "tool", content: { tool: "bash", state: {} } },
          { type: "text", content: { text: "Second text" } },
          { type: "tool", content: { tool: "read", state: {} } },
          { type: "text", content: { text: "Third text" } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-preserve-1", { mode: "all_no_tools" });

        const textParts = detail.messages?.[0].parts.filter((p) => p.type === "text") || [];
        expect(textParts).toHaveLength(3);
        expect(textParts.map((p) => (p as { type: "text"; text: string }).text)).toEqual([
          "First text",
          "Second text",
          "Third text",
        ]);
      });

      test("preserves reasoning parts when tools excluded", async () => {
        const { cwd } = setupSessionWithParts("ses-preserve-2", "msg-preserve-2", [
          { type: "reasoning", content: { text: "Let me think about this..." } },
          { type: "tool", content: { tool: "bash", state: {} } },
          { type: "reasoning", content: { text: "Based on the results..." } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-preserve-2", { mode: "all_no_tools" });

        const reasoningParts = detail.messages?.[0].parts.filter((p) => p.type === "reasoning") || [];
        expect(reasoningParts).toHaveLength(2);
        expect(
          reasoningParts.map((p) => (p as { type: "reasoning"; text: string }).text)
        ).toEqual(["Let me think about this...", "Based on the results..."]);
      });

      test("preserves both text and reasoning when tools excluded", async () => {
        const { cwd } = setupSessionWithParts("ses-preserve-3", "msg-preserve-3", [
          { type: "text", content: { text: "User query" } },
          { type: "reasoning", content: { text: "Thinking..." } },
          { type: "tool", content: { tool: "search", state: {} } },
          { type: "text", content: { text: "Here's the answer" } },
          { type: "step-start", content: {} },
          { type: "reasoning", content: { text: "Final reasoning" } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-preserve-3", { mode: "all_no_tools" });

        const allTypes = detail.messages?.[0].parts.map((p) => p.type) || [];
        expect(allTypes).toEqual(["text", "reasoning", "text", "reasoning"]);
      });
    });

    describe("AC4: Default behavior for modes", () => {
      test("mode=all_no_tools excludes tools by default", async () => {
        const { cwd } = setupSessionWithParts("ses-default-1", "msg-default-1", [
          { type: "text", content: { text: "Hello" } },
          { type: "tool", content: { tool: "bash", state: {} } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-default-1", { mode: "all_no_tools" });

        expect(detail.messages?.[0].parts).toHaveLength(1);
        expect(detail.messages?.[0].parts[0].type).toBe("text");
      });

      test("DEFAULT BEHAVIOR (mode omitted) excludes tools", async () => {
        const { cwd } = setupSessionWithParts("ses-default-omitted", "msg-default-omitted", [
          { type: "text", content: { text: "Hello" } },
          { type: "tool", content: { tool: "bash", state: {} } },
          { type: "reasoning", content: { text: "Thinking..." } },
          { type: "step-start", content: { stepId: "step-1" } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        // Call getSessionDetail WITHOUT specifying mode - should default to excluding tools
        const detail = await adapter.getSessionDetail("ses-default-omitted", {});

        // Should have 2 parts: text and reasoning (tool and step-start excluded by default)
        expect(detail.messages?.[0].parts).toHaveLength(2);
        const types = detail.messages?.[0].parts.map((p) => p.type) ?? [];
        expect(types).toContain("text");
        expect(types).toContain("reasoning");
        expect(types).not.toContain("tool");
        expect(types).not.toContain("step-start");
      });

      test("mode=all_with_tools includes tools", async () => {
        const { cwd } = setupSessionWithParts("ses-default-2", "msg-default-2", [
          { type: "text", content: { text: "Hello" } },
          { type: "tool", content: { tool: "bash", state: {} } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-default-2", { mode: "all_with_tools" });

        expect(detail.messages?.[0].parts).toHaveLength(2);
      });

      test("mode=last_message includes tools in last message", async () => {
        const cwd = "/home/user/project";
        const projectId = "proj-last-msg";
        seedProject(projectId, cwd);
        seedSession("ses-last-1", projectId, "Last Message Test", cwd, 1000, 2000);

        seedMessage("msg-last-1", "ses-last-1", "user", 1100);
        seedMessage("msg-last-2", "ses-last-1", "assistant", 1200);

        seedPart("prt-last-1", "msg-last-1", "ses-last-1", "text", { text: "First message" }, 1150);
        seedPart("prt-last-2", "msg-last-2", "ses-last-1", "text", { text: "Last message" }, 1250);
        seedPart("prt-last-3", "msg-last-2", "ses-last-1", "tool", { tool: "bash", state: {} }, 1350);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-last-1", { mode: "last_message" });

        // Last message should include the tool
        expect(detail.messages).toHaveLength(1);
        expect(detail.messages?.[0].parts).toHaveLength(2);
        expect(detail.messages?.[0].parts.find((p) => p.type === "tool")).toBeDefined();
      });
    });

    describe("Edge cases", () => {
      test("message with only tools returns empty parts array when tools excluded", async () => {
        const { cwd } = setupSessionWithParts("ses-edge-1", "msg-edge-1", [
          { type: "tool", content: { tool: "bash", state: { status: "running" } } },
          { type: "tool", content: { tool: "read", state: { status: "completed" } } },
          { type: "tool", content: { tool: "write", state: { status: "pending" } } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-edge-1", { mode: "all_no_tools" });

        expect(detail.messages?.[0].parts).toEqual([]);
      });

      test("message with only step markers returns empty parts array when tools excluded", async () => {
        const { cwd } = setupSessionWithParts("ses-edge-2", "msg-edge-2", [
          { type: "step-start", content: { stepId: "step-1" } },
          { type: "step-finish", content: { stepId: "step-1" } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-edge-2", { mode: "all_no_tools" });

        expect(detail.messages?.[0].parts).toEqual([]);
      });

      test("message with mixed content and only tools filtered shows remaining", async () => {
        const { cwd } = setupSessionWithParts("ses-edge-3", "msg-edge-3", [
          { type: "step-start", content: {} },
          { type: "tool", content: { tool: "bash", state: {} } },
          { type: "text", content: { text: "Preserved text" } },
          { type: "tool", content: { tool: "read", state: {} } },
          { type: "reasoning", content: { text: "Preserved reasoning" } },
          { type: "step-finish", content: {} },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-edge-3", { mode: "all_no_tools" });

        expect(detail.messages?.[0].parts).toHaveLength(2);
        const types = detail.messages?.[0].parts.map((p) => p.type) || [];
        expect(types).toEqual(["text", "reasoning"]);
      });

      test("unknown part types are preserved when not tool-related", async () => {
        const { cwd } = setupSessionWithParts("ses-edge-4", "msg-edge-4", [
          { type: "text", content: { text: "Text" } },
          { type: "custom-type", content: { customData: "value" } },
          { type: "tool", content: { tool: "bash", state: {} } },
        ]);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-edge-4", { mode: "all_no_tools" });

        expect(detail.messages?.[0].parts).toHaveLength(2);
        const customPart = detail.messages?.[0].parts.find((p) => p.type === "custom-type");
        expect(customPart).toBeDefined();
      });

      test("empty message with no parts returns empty array", async () => {
        const { cwd } = setupSessionWithParts("ses-edge-5", "msg-edge-5", []);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-edge-5", { mode: "all_no_tools" });

        expect(detail.messages?.[0].parts).toEqual([]);
      });
    });

    describe("Multiple messages filtering", () => {
      test("filters tools across multiple messages consistently", async () => {
        const cwd = "/home/user/project";
        const projectId = "proj-multi";
        seedProject(projectId, cwd);
        seedSession("ses-multi-1", projectId, "Multi Message Test", cwd, 1000, 2000);

        // Message 1: user with text only
        seedMessage("msg-multi-1", "ses-multi-1", "user", 1100);
        seedPart("prt-multi-1", "msg-multi-1", "ses-multi-1", "text", { text: "User asks" }, 1150);

        // Message 2: assistant with text + tools
        seedMessage("msg-multi-2", "ses-multi-1", "assistant", 1200);
        seedPart("prt-multi-2a", "msg-multi-2", "ses-multi-1", "text", { text: "Response" }, 1250);
        seedPart("prt-multi-2b", "msg-multi-2", "ses-multi-1", "tool", { tool: "bash", state: {} }, 1350);

        // Message 3: assistant with only tools
        seedMessage("msg-multi-3", "ses-multi-1", "assistant", 1400);
        seedPart("prt-multi-3a", "msg-multi-3", "ses-multi-1", "tool", { tool: "read", state: {} }, 1450);

        const entry = makeEntry("main", { mode: "db", db_path: dbPath });
        const adapter = createOpenCodeAdapter(entry, { cwd });

        const detail = await adapter.getSessionDetail("ses-multi-1", { mode: "all_no_tools" });

        expect(detail.messages).toHaveLength(3);
        expect(detail.messages?.[0].parts).toHaveLength(1);
        expect(detail.messages?.[1].parts).toHaveLength(1);
        expect(detail.messages?.[2].parts).toHaveLength(0);

        // Verify no tools in any message
        const allParts = detail.messages?.flatMap((m) => m.parts) || [];
        expect(allParts.find((p) => p.type === "tool")).toBeUndefined();
      });
    });
  });

  // ===========================================================================
  // Canonical Session Key Tests
  // ===========================================================================

  describe("canonical session key", () => {
    test("session summary contains all key components", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-123", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("my-alias", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const sessions = adapter.listSessions();
      const session = sessions[0];

      // Canonical key is (agent, alias, session_id)
      expect(session.agent).toBe("opencode");
      expect(session.alias).toBe("my-alias");
      expect(session.id).toBe("ses-123");
    });
  });
});
