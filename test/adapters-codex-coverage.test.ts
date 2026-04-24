import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter } from "../src/adapters/codex";

describe("src/adapters/codex.ts coverage", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `codex-cov-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "state_5.sqlite");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setupMockDb() {
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        title TEXT NOT NULL,
        model TEXT,
        cwd TEXT NOT NULL,
        rollout_path TEXT
      )
    `);
    
    // Add some rows
    const now = Math.floor(Date.now() / 1000);
    db.run(`INSERT INTO threads (id, updated_at, created_at, title, cwd) VALUES (?, ?, ?, ?, ?)`, 
      ["s1", now, now - 3600, "Thread 1", tempDir]);
    db.run(`INSERT INTO threads (id, updated_at, created_at, title, cwd) VALUES (?, ?, ?, ?, ?)`, 
      ["s2", now - 1800, now - 7200, "Thread 2", tempDir]);
    
    db.close();
  }

  test("SQLite listSessionsByTimeRange", () => {
    setupMockDb();
    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "mock",
      enabled: true,
      path: dbPath
    });

    const results = adapter.listSessionsByTimeRange!({ since: 0, limit: 10 });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("s1");
    expect(results[1].id).toBe("s2");
  });

  test("SQLite getSessionDetail", async () => {
    setupMockDb();
    const rolloutPath = join(tempDir, "rollout.jsonl");
    writeFileSync(rolloutPath, JSON.stringify({
      timestamp: "2024-01-01T00:00:00Z",
      type: "response_item",
      payload: { role: "user", content: [{ type: "input_text", text: "Hello from rollout" }] }
    }) + "\n");

    const db = new Database(dbPath);
    db.run("UPDATE threads SET rollout_path = ? WHERE id = ?", [rolloutPath, "s1"]);
    db.close();

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "mock",
      enabled: true,
      path: dbPath
    });

    const detail = await adapter.getSessionDetail!("s1", {});
    expect(detail.id).toBe("s1");
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages![0].parts[0].text).toBe("Hello from rollout");
  });

  test("searchSessions matches content in JSONL", () => {
    const jsonlPath = join(tempDir, "search.jsonl");
    writeFileSync(jsonlPath, JSON.stringify({
      timestamp: "2024-01-01T00:00:00Z",
      type: "session_meta",
      payload: { id: "s-search", timestamp: "2024-01-01T00:00:00Z", title: "Search Me" }
    }) + "\n" + JSON.stringify({
      timestamp: "2024-01-01T00:01:00Z",
      type: "response_item",
      payload: { role: "user", content: [{ type: "input_text", text: "secret needle" }] }
    }) + "\n");

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "mock",
      enabled: true,
      path: tempDir
    });

    const results = adapter.searchSessions!({ text: "needle" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s-search");
  });

  test("parseCodexSession handles corrupt JSONL line", () => {
    const jsonlPath = join(tempDir, "corrupt.jsonl");
    writeFileSync(jsonlPath, "invalid json\n" + JSON.stringify({
      timestamp: "2024-01-01T00:00:00Z",
      type: "session_meta",
      payload: { id: "s-corrupt", timestamp: "2024-01-01T00:00:00Z" }
    }) + "\n");

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "mock",
      enabled: true,
      path: tempDir
    });

    // parseCodexSession is called by listSessions. 
    // It should skip files with JSON parse errors if we are listing a directory.
    const results = adapter.listSessions();
    // In parseCodexSession, if JSON.parse fails, it throws, which is caught by parseCodexSession
    // and returns EMPTY_CODEX_SESSION if it's a "JSONL parse error".
    // But parseJsonLine throws "Codex JSONL parse error".
    expect(results.length).toBe(0); // Files with empty ID are skipped in listSessions
  });

  test("resolveCodexPath throws on invalid agent", () => {
    expect(() => createCodexAdapter({ agent: "opencode" as any, alias: "x" })).toThrow(/requires agent "codex"/);
  });

  test("resolveCodexPath throws on invalid path", () => {
    const a1 = createCodexAdapter({ agent: "codex", alias: "x", path: "" });
    expect(() => a1.listSessions()).toThrow(/must be a non-empty string/);

    const a2 = createCodexAdapter({ agent: "codex", alias: "x", path: "/non/existent/path" });
    expect(() => a2.listSessions()).toThrow(/not found/);
  });

  test("parseCodexSessionForTimeRange handles multi-session file", () => {
    const jsonlPath = join(tempDir, "multi.jsonl");
    writeFileSync(jsonlPath, 
      JSON.stringify({ type: "session_meta", payload: { id: "s1", timestamp: "2024-01-01T00:00:00Z" } }) + "\n" +
      JSON.stringify({ timestamp: "2024-01-01T01:00:00Z", type: "response_item" }) + "\n" +
      JSON.stringify({ type: "session_meta", payload: { id: "s2", timestamp: "2024-01-02T00:00:00Z" } }) + "\n" +
      JSON.stringify({ timestamp: "2024-01-02T01:00:00Z", type: "response_item" }) + "\n"
    );

    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "mock",
      enabled: true,
      path: jsonlPath
    });

    const results = adapter.listSessionsByTimeRange!({ since: 0, limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s2"); // Latest session in file wins
  });
  
  test("getSessionDetail handles unknown session", async () => {
    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "mock",
      enabled: true,
      path: tempDir
    });
    await expect(adapter.getSessionDetail!("unknown", {})).rejects.toThrow(/session not found/);
  });
});
