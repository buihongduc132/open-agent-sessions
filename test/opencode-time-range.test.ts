import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeAdapter } from "../src/adapters/opencode";
import { OpenCodeAgentEntry, OpenCodeStorageConfig } from "../src/config/types";

describe("OpenCode Adapter - Time-based Session Listing (oas-9rs)", () => {
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
    tempDir = join(tmpdir(), `opencode-time-test-${Date.now()}`);
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

  const writeJsonl = (sessions: Record<string, unknown>[]) => {
    const lines = sessions.map((s) => JSON.stringify(s)).join("\n");
    writeFileSync(jsonlPath, lines, "utf-8");
  };

  // ===========================================================================
  // AC1: Function accepts since, until, limit parameters
  // ===========================================================================

  describe("AC1: Function accepts since, until, limit parameters", () => {
    test("accepts all three parameters", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      // Should not throw
      const result = adapter.listSessionsByTimeRange!({
        since: 500,
        until: 3000,
        limit: 10,
      });

      expect(Array.isArray(result)).toBe(true);
    });

    test("works with only since parameter", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({ since: 500 });
      expect(Array.isArray(result)).toBe(true);
    });

    test("works with only until parameter", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({ until: 3000 });
      expect(Array.isArray(result)).toBe(true);
    });

    test("works with only limit parameter", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({ limit: 10 });
      expect(Array.isArray(result)).toBe(true);
    });

    test("works with no parameters (empty options)", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({});
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ===========================================================================
  // AC2: SQL query filters by time_created or time_updated
  // ===========================================================================

  describe("AC2: SQL query filters by time_created or time_updated", () => {
    test("filters by since (time_created >= since)", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      seedSession("ses-old", projectId, "Old", cwd, 1000, 1500);
      seedSession("ses-new1", projectId, "New 1", cwd, 2000, 2500);
      seedSession("ses-new2", projectId, "New 2", cwd, 3000, 3500);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({ since: 1500 });

      // Should only include sessions created at or after 1500
      expect(result.length).toBe(2);
      expect(result.map((s) => s.id).sort()).toEqual(["ses-new1", "ses-new2"]);
    });

    test("filters by until (time_updated <= until)", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      seedSession("ses-old1", projectId, "Old 1", cwd, 1000, 1500);
      seedSession("ses-old2", projectId, "Old 2", cwd, 2000, 2500);
      seedSession("ses-new", projectId, "New", cwd, 3000, 3500);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({ until: 2500 });

      // Should only include sessions updated at or before 2500
      expect(result.length).toBe(2);
      expect(result.map((s) => s.id).sort()).toEqual(["ses-old1", "ses-old2"]);
    });

    test("filters by both since and until", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      seedSession("ses-before", projectId, "Before", cwd, 500, 900);
      seedSession("ses-in1", projectId, "In Range 1", cwd, 1000, 1500);
      seedSession("ses-in2", projectId, "In Range 2", cwd, 2000, 2500);
      seedSession("ses-after", projectId, "After", cwd, 3000, 3500);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({
        since: 1000,
        until: 2500,
      });

      // Should only include sessions in the time range
      expect(result.length).toBe(2);
      expect(result.map((s) => s.id).sort()).toEqual(["ses-in1", "ses-in2"]);
    });

    test("includes session exactly at since boundary", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      seedSession("ses-exact", projectId, "Exact", cwd, 2000, 2500);
      seedSession("ses-after", projectId, "After", cwd, 3000, 3500);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({ since: 2000 });

      expect(result.length).toBe(2);
      expect(result.map((s) => s.id).sort()).toEqual(["ses-after", "ses-exact"]);
    });

    test("includes session exactly at until boundary", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      seedSession("ses-before", projectId, "Before", cwd, 1000, 1500);
      seedSession("ses-exact", projectId, "Exact", cwd, 2000, 2500);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({ until: 2500 });

      expect(result.length).toBe(2);
      expect(result.map((s) => s.id).sort()).toEqual(["ses-before", "ses-exact"]);
    });
  });

  // ===========================================================================
  // AC3: Results sorted by time_updated DESC
  // ===========================================================================

  describe("AC3: Results sorted by time_updated DESC", () => {
    test("sorts by time_updated in descending order", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      seedSession("ses-old", projectId, "Old", cwd, 1000, 2000);
      seedSession("ses-mid", projectId, "Mid", cwd, 2000, 4000);
      seedSession("ses-new", projectId, "New", cwd, 3000, 6000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({});

      expect(result.length).toBe(3);
      // Should be sorted by time_updated DESC
      expect(result[0].id).toBe("ses-new");
      expect(result[1].id).toBe("ses-mid");
      expect(result[2].id).toBe("ses-old");
    });

    test("maintains sort order with time filter", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      seedSession("ses-1", projectId, "Session 1", cwd, 1000, 5000);
      seedSession("ses-2", projectId, "Session 2", cwd, 2000, 3000);
      seedSession("ses-3", projectId, "Session 3", cwd, 3000, 4000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({ since: 500 });

      expect(result.length).toBe(3);
      // Should still be sorted by time_updated DESC
      expect(result[0].id).toBe("ses-1");
      expect(result[1].id).toBe("ses-3");
      expect(result[2].id).toBe("ses-2");
    });
  });

  // ===========================================================================
  // AC4: Limit parameter respected (default 50)
  // ===========================================================================

  describe("AC4: Limit parameter respected (default 50)", () => {
    test("defaults to limit of 50", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      // Create 60 sessions
      for (let i = 0; i < 60; i++) {
        seedSession(`ses-${i}`, projectId, `Session ${i}`, cwd, i * 100, i * 100 + 50);
      }

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({});

      expect(result.length).toBe(50);
    });

    test("respects custom limit", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      for (let i = 0; i < 20; i++) {
        seedSession(`ses-${i}`, projectId, `Session ${i}`, cwd, i * 100, i * 100 + 50);
      }

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({ limit: 10 });

      expect(result.length).toBe(10);
    });

    test("limit of 0 returns all sessions", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      for (let i = 0; i < 20; i++) {
        seedSession(`ses-${i}`, projectId, `Session ${i}`, cwd, i * 100, i * 100 + 50);
      }

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({ limit: 0 });

      expect(result.length).toBe(20);
    });

    test("limit with time filters", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      for (let i = 0; i < 30; i++) {
        seedSession(`ses-${i}`, projectId, `Session ${i}`, cwd, i * 100, i * 100 + 50);
      }

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({
        since: 500,
        until: 2500,
        limit: 5,
      });

      expect(result.length).toBe(5);
    });
  });

  // ===========================================================================
  // AC5: Returns SessionSummary array
  // ===========================================================================

  describe("AC5: Returns SessionSummary array", () => {
    test("returns properly formatted SessionSummary objects", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);
      seedSession("ses-1", projectId, "Test Session", cwd, 1000, 2000);

      const entry = makeEntry("my-alias", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({});

      expect(result.length).toBe(1);
      const summary = result[0];

      expect(summary.id).toBe("ses-1");
      expect(summary.agent).toBe("opencode");
      expect(summary.alias).toBe("my-alias");
      expect(summary.title).toBe("Test Session");
      expect(summary.created_at).toBe(new Date(1000).toISOString());
      expect(summary.updated_at).toBe(new Date(2000).toISOString());
      expect(summary.message_count).toBe(0);
      expect(summary.storage).toBe("db");
    });

    test("returns empty array when no sessions match", () => {
      const cwd = "/home/user/project";
      seedProject("proj-1", cwd);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({
        since: 10000,
        until: 20000,
      });

      expect(result).toEqual([]);
    });

    test("returns empty array when project not found", () => {
      const cwd = "/home/user/nonexistent";

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({});

      expect(result).toEqual([]);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe("Edge Cases", () => {
    test("no sessions in range returns empty array", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      seedSession("ses-1", projectId, "Test", cwd, 1000, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({
        since: 5000,
        until: 6000,
      });

      expect(result).toEqual([]);
    });

    test("handles future timestamps", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      const futureTime = Date.now() + 86400000; // 24 hours in the future
      seedSession("ses-future", projectId, "Future", cwd, futureTime, futureTime + 1000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({
        since: futureTime,
      });

      expect(result.length).toBe(1);
      expect(result[0].id).toBe("ses-future");
    });

    test("handles sessions with same time_updated", () => {
      const cwd = "/home/user/project";
      const projectId = "proj-1";
      seedProject(projectId, cwd);

      seedSession("ses-1", projectId, "Session 1", cwd, 1000, 2000);
      seedSession("ses-2", projectId, "Session 2", cwd, 1500, 2000);
      seedSession("ses-3", projectId, "Session 3", cwd, 1800, 2000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({});

      expect(result.length).toBe(3);
      // All have same time_updated, order may vary but should not throw
      expect(result.map((s) => s.id)).toContain("ses-1");
      expect(result.map((s) => s.id)).toContain("ses-2");
      expect(result.map((s) => s.id)).toContain("ses-3");
    });

    test("filters only sessions from current project", () => {
      const cwdA = "/home/user/project-a";
      const cwdB = "/home/user/project-b";
      const projectA = "proj-a";
      const projectB = "proj-b";

      seedProject(projectA, cwdA);
      seedProject(projectB, cwdB);

      seedSession("ses-a1", projectA, "A1", cwdA, 1000, 2000);
      seedSession("ses-a2", projectA, "A2", cwdA, 3000, 4000);
      seedSession("ses-b1", projectB, "B1", cwdB, 2000, 3000);

      const entry = makeEntry("main", { mode: "db", db_path: dbPath });
      const adapter = createOpenCodeAdapter(entry, { cwd: cwdA });

      const result = adapter.listSessionsByTimeRange!({
        since: 500,
        until: 4500,
      });

      // Should only include sessions from project A
      expect(result.length).toBe(2);
      expect(result.map((s) => s.id).sort()).toEqual(["ses-a1", "ses-a2"]);
    });
  });

  // ===========================================================================
  // JSONL Adapter Tests
  // ===========================================================================

  describe("JSONL Adapter", () => {
    test("filters JSONL sessions by time range", () => {
      const cwd = "/home/user/project";
      writeJsonl([
        {
          id: "ses-old",
          projectID: "proj-1",
          directory: cwd,
          title: "Old",
          timeCreated: 1000,
          timeUpdated: 1500,
        },
        {
          id: "ses-new1",
          projectID: "proj-1",
          directory: cwd,
          title: "New 1",
          timeCreated: 2000,
          timeUpdated: 2500,
        },
        {
          id: "ses-new2",
          projectID: "proj-1",
          directory: cwd,
          title: "New 2",
          timeCreated: 3000,
          timeUpdated: 3000,
        },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({
        since: 1500,
        until: 3000,
      });

      expect(result.length).toBe(2);
      expect(result.map((s) => s.id).sort()).toEqual(["ses-new1", "ses-new2"]);
    });

    test("respects limit in JSONL adapter", () => {
      const cwd = "/home/user/project";
      const sessions = [];
      for (let i = 0; i < 20; i++) {
        sessions.push({
          id: `ses-${i}`,
          projectID: "proj-1",
          directory: cwd,
          title: `Session ${i}`,
          timeCreated: i * 100,
          timeUpdated: i * 100 + 50,
        });
      }
      writeJsonl(sessions);

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({ limit: 10 });

      expect(result.length).toBe(10);
    });

    test("sorts JSONL sessions by time_updated DESC", () => {
      const cwd = "/home/user/project";
      writeJsonl([
        {
          id: "ses-old",
          projectID: "proj-1",
          directory: cwd,
          title: "Old",
          timeCreated: 1000,
          timeUpdated: 2000,
        },
        {
          id: "ses-new",
          projectID: "proj-1",
          directory: cwd,
          title: "New",
          timeCreated: 3000,
          timeUpdated: 6000,
        },
        {
          id: "ses-mid",
          projectID: "proj-1",
          directory: cwd,
          title: "Mid",
          timeCreated: 2000,
          timeUpdated: 4000,
        },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({});

      expect(result.length).toBe(3);
      expect(result[0].id).toBe("ses-new");
      expect(result[1].id).toBe("ses-mid");
      expect(result[2].id).toBe("ses-old");
    });

    test("returns properly formatted SessionSummary for JSONL", () => {
      const cwd = "/home/user/project";
      writeJsonl([
        {
          id: "ses-1",
          projectID: "proj-1",
          directory: cwd,
          title: "Test Session",
          timeCreated: 1000,
          timeUpdated: 2000,
        },
      ]);

      const entry = makeEntry("jsonl-alias", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd });

      const result = adapter.listSessionsByTimeRange!({});

      expect(result.length).toBe(1);
      const summary = result[0];

      expect(summary.id).toBe("ses-1");
      expect(summary.agent).toBe("opencode");
      expect(summary.alias).toBe("jsonl-alias");
      expect(summary.title).toBe("Test Session");
      expect(summary.created_at).toBe(new Date(1000).toISOString());
      expect(summary.updated_at).toBe(new Date(2000).toISOString());
      expect(summary.message_count).toBe(0);
      expect(summary.storage).toBe("jsonl");
    });

    test("filters JSONL by CWD", () => {
      const cwdA = "/home/user/project-a";
      const cwdB = "/home/user/project-b";

      writeJsonl([
        {
          id: "ses-a1",
          projectID: "proj-1",
          directory: cwdA,
          title: "A1",
          timeCreated: 1000,
          timeUpdated: 2000,
        },
        {
          id: "ses-b1",
          projectID: "proj-2",
          directory: cwdB,
          title: "B1",
          timeCreated: 3000,
          timeUpdated: 4000,
        },
      ]);

      const entry = makeEntry("main", { mode: "jsonl", jsonl_path: jsonlPath });
      const adapter = createOpenCodeAdapter(entry, { cwd: cwdA });

      const result = adapter.listSessionsByTimeRange!({});

      expect(result.length).toBe(1);
      expect(result[0].id).toBe("ses-a1");
    });
  });
});
