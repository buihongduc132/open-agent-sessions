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
    const __adapter = createCodexAdapter({ agent: "opencode" as any, alias: "x" });
      expect(() => __adapter.listSessions()).toThrow(/requires agent "codex"/);
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

describe("codex read options (BUG-1/4/5/6)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `codex-readopts-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Build a JSONL session file with 4 user + 2 assistant messages. */
  function writeSessionFile(sessionId = "s-ro"): string {
    const records: string[] = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "session_meta",
        payload: { id: sessionId, timestamp: "2024-01-01T00:00:00Z" },
      }),
    ];
    for (let i = 1; i <= 4; i++) {
      records.push(JSON.stringify({
        timestamp: `2024-01-01T00:0${i}:00Z`,
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: `user msg ${i}` }] },
      }));
    }
    for (let i = 1; i <= 2; i++) {
      records.push(JSON.stringify({
        timestamp: `2024-01-01T00:1${i}:00Z`,
        type: "response_item",
        payload: { role: "assistant", content: [{ type: "output_text", text: `assistant msg ${i}` }] },
      }));
    }
    const filePath = join(tempDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, records.join("\n") + "\n");
    return filePath;
  }

  function makeAdapter(path: string) {
    return createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path });
  }

  test("JSONL: --last N returns exactly N messages", async () => {
    writeSessionFile();
    const adapter = makeAdapter(tempDir);

    const detail = await adapter.getSessionDetail!("s-ro", {
      selection: { mode: "last", count: 3 },
    });
    expect(detail.messages).toHaveLength(3);
    expect(detail.messages![0].parts[0].text).toBe("user msg 4");
    expect(detail.messages![2].parts[0].text).toBe("assistant msg 2");
  });

  test("JSONL: --first N returns exactly N messages", async () => {
    writeSessionFile();
    const adapter = makeAdapter(tempDir);

    const detail = await adapter.getSessionDetail!("s-ro", {
      selection: { mode: "first", count: 2 },
    });
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages![0].parts[0].text).toBe("user msg 1");
  });

  test("JSONL: range selection returns the inclusive slice", async () => {
    writeSessionFile();
    const adapter = makeAdapter(tempDir);

    const detail = await adapter.getSessionDetail!("s-ro", {
      selection: { mode: "range", start: 2, end: 4 },
    });
    // 1-indexed INCLUSIVE range 2..4 -> messages 2,3,4 (matches claude.ts semantics)
    expect(detail.messages).toHaveLength(3);
    expect(detail.messages![0].parts[0].text).toBe("user msg 2");
    expect(detail.messages![1].parts[0].text).toBe("user msg 3");
    expect(detail.messages![2].parts[0].text).toBe("user msg 4");
  });

  test("JSONL: --role user filters to user messages only", async () => {
    writeSessionFile();
    const adapter = makeAdapter(tempDir);

    const detail = await adapter.getSessionDetail!("s-ro", { role: "user" });
    expect(detail.messages).toHaveLength(4);
    for (const m of detail.messages!) expect(m.role).toBe("user");
  });

  test("JSONL: mode last_message returns exactly 1 message", async () => {
    writeSessionFile();
    const adapter = makeAdapter(tempDir);

    const detail = await adapter.getSessionDetail!("s-ro", { mode: "last_message" });
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages![0].role).toBe("assistant");
  });

  test("JSONL: userOnly + role assistant -> empty array (parity with claude)", async () => {
    writeSessionFile();
    const adapter = makeAdapter(tempDir);

    const detail = await adapter.getSessionDetail!("s-ro", {
      userOnly: true,
      role: "assistant",
    });
    expect(detail.messages).toEqual([]);
  });

  test("JSONL: userOnly filters to user role", async () => {
    writeSessionFile();
    const adapter = makeAdapter(tempDir);

    const detail = await adapter.getSessionDetail!("s-ro", { userOnly: true });
    expect(detail.messages).toHaveLength(4);
    for (const m of detail.messages!) expect(m.role).toBe("user");
  });

  test("SQLite: --last N returns exactly N messages", async () => {
    const filePath = writeSessionFile("s-sql");
    const dbPath = join(tempDir, "state_5.sqlite");
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
    db.run(
      "INSERT INTO threads (id, updated_at, created_at, title, cwd, rollout_path) VALUES (?, ?, ?, ?, ?, ?)",
      ["s-sql", 1704085200, 1704081600, "SQL Session", tempDir, filePath]
    );
    db.close();

    const adapter = makeAdapter(dbPath);

    const detail = await adapter.getSessionDetail!("s-sql", {
      selection: { mode: "last", count: 2 },
    });
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages![0].parts[0].text).toBe("assistant msg 1");
  });

  test("SQLite: role user filters", async () => {
    const filePath = writeSessionFile("s-sql2");
    const dbPath = join(tempDir, "state_5.sqlite");
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
    db.run(
      "INSERT INTO threads (id, updated_at, created_at, title, cwd, rollout_path) VALUES (?, ?, ?, ?, ?, ?)",
      ["s-sql2", 1704085200, 1704081600, "SQL Session 2", tempDir, filePath]
    );
    db.close();

    const adapter = makeAdapter(dbPath);

    const detail = await adapter.getSessionDetail!("s-sql2", { role: "user" });
    expect(detail.messages).toHaveLength(4);
    for (const m of detail.messages!) expect(m.role).toBe("user");
  });
});

describe("codex title truncation (BUG-8)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `codex-title-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("extracted title is first line, stripped of backticks, max 120 chars", () => {
    const longText = `\`\`\`\n${"x".repeat(300)}\nsecond line`;
    const filePath = join(tempDir, "title.jsonl");
    writeFileSync(filePath,
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "s-title", timestamp: "2024-01-01T00:00:00Z" },
      }) + "\n" +
      JSON.stringify({
        timestamp: "2024-01-01T00:01:00Z",
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: longText }] },
      }) + "\n"
    );

    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: tempDir });
    const sessions = adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title.length).toBeLessThanOrEqual(120);
    expect(sessions[0].title).not.toContain("`");
    expect(sessions[0].title).toBe("x".repeat(120));
  });

  test("multi-line raw user message is collapsed to first line", () => {
    const filePath = join(tempDir, "title2.jsonl");
    writeFileSync(filePath,
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "s-title2", timestamp: "2024-01-01T00:00:00Z" },
      }) + "\n" +
      JSON.stringify({
        timestamp: "2024-01-01T00:01:00Z",
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "first line\nsecond line" }] },
      }) + "\n"
    );

    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: tempDir });
    const sessions = adapter.listSessions();
    expect(sessions[0].title).toBe("first line");
  });

  test("sqlite titles are sanitized: first line, no backticks, max 120 (BUG-8)", () => {
    const dbPath = join(tempDir, "state_5.sqlite");
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        title TEXT NOT NULL,
        model TEXT,
        cwd TEXT NOT NULL
      )
    `);
    db.run(
      "INSERT INTO threads (id, updated_at, created_at, title, cwd) VALUES (?, ?, ?, ?, ?)",
      ["s-db", 1704085200, 1704081600, "```\n" + "Very Long DB Title ".repeat(20) + "\n```", tempDir]
    );
    db.close();

    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: dbPath });
    const sessions = adapter.listSessions();
    expect(sessions[0].title.length).toBeLessThanOrEqual(120);
    expect(sessions[0].title).not.toContain("`");
    expect(sessions[0].title).not.toContain("\n");
    expect(sessions[0].title).toBe(
      "Very Long DB Title ".repeat(6).trimEnd() + " Very L"
    );
  });

  test("sqlite detail title is sanitized too (BUG-8)", async () => {
    const dbPath = join(tempDir, "state_5.sqlite");
    // Real rollout file so detail never triggers the ~/.codex/sessions fallback scan.
    const rolloutPath = join(tempDir, "rollout-dbt.jsonl");
    writeFileSync(rolloutPath,
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "s-dbt", timestamp: "2024-01-01T00:00:00Z" },
      }) + "\n" +
      JSON.stringify({
        timestamp: "2024-01-01T00:01:00Z",
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "hello" }] },
      }) + "\n"
    );
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
    db.run(
      "INSERT INTO threads (id, updated_at, created_at, title, cwd, rollout_path) VALUES (?, ?, ?, ?, ?, ?)",
      ["s-dbt", 1704085200, 1704081600, "```\n" + "y".repeat(300) + "\n```", tempDir, rolloutPath]
    );
    db.close();

    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: dbPath });
    const detail = await adapter.getSessionDetail!("s-dbt", {});
    expect(detail.title.length).toBeLessThanOrEqual(120);
    expect(detail.title).not.toContain("`");
    expect(detail.title).toBe("y".repeat(120));
  });
});

describe("codex list message_count (BUG-9)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `codex-count-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("listSessionsByTimeRange message_count agrees with detail for JSONL path", () => {
    const records: string[] = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "s-count", timestamp: "2024-01-01T00:00:00Z" },
      }),
    ];
    for (let i = 1; i <= 4; i++) {
      records.push(JSON.stringify({
        timestamp: `2024-01-01T00:0${i}:00Z`,
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: `u${i}` }] },
      }));
    }
    for (let i = 1; i <= 2; i++) {
      records.push(JSON.stringify({
        timestamp: `2024-01-01T00:1${i}:00Z`,
        type: "response_item",
        payload: { role: "assistant", content: [{ type: "output_text", text: `a${i}` }] },
      }));
    }
    // tool-ish response item should NOT be counted
    records.push(JSON.stringify({
      timestamp: "2024-01-01T00:15:00Z",
      type: "response_item",
      payload: { role: "tool", content: [] },
    }));
    const filePath = join(tempDir, "count.jsonl");
    writeFileSync(filePath, records.join("\n") + "\n");

    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: tempDir });

    const list = adapter.listSessionsByTimeRange!({ since: 0, limit: 10 });
    expect(list).toHaveLength(1);
    expect(list[0].message_count).toBe(6);

    const full = adapter.listSessions();
    expect(full[0].message_count).toBe(6);
  });

  test("sqlite listSessionsByTimeRange message_count comes from rollout JSONL (BUG-9)", () => {
    const dbPath = join(tempDir, "state_5.sqlite");
    const rolloutPath = join(tempDir, "rollout-count.jsonl");
    const records: string[] = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "s-sql-count", timestamp: "2024-01-01T00:00:00Z" },
      }),
    ];
    for (let i = 1; i <= 3; i++) {
      records.push(JSON.stringify({
        timestamp: `2024-01-01T00:0${i}:00Z`,
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: `u${i}` }] },
      }));
    }
    records.push(JSON.stringify({
      timestamp: "2024-01-01T00:10:00Z",
      type: "response_item",
      payload: { role: "assistant", content: [{ type: "output_text", text: "a1" }] },
    }));
    // tool + event records must NOT be counted
    records.push(JSON.stringify({
      timestamp: "2024-01-01T00:11:00Z",
      type: "response_item",
      payload: { role: "tool", content: [] },
    }));
    records.push(JSON.stringify({
      timestamp: "2024-01-01T00:12:00Z",
      type: "event_msg",
      payload: { role: "user" },
    }));
    writeFileSync(rolloutPath, records.join("\n") + "\n");

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
    const now = Math.floor(Date.now() / 1000);
    db.run(
      "INSERT INTO threads (id, updated_at, created_at, title, cwd, rollout_path) VALUES (?, ?, ?, ?, ?, ?)",
      ["s-sql-count", now, now - 60, "counted", tempDir, rolloutPath]
    );
    // Row with a missing rollout file: count must stay 0, no throw
    db.run(
      "INSERT INTO threads (id, updated_at, created_at, title, cwd, rollout_path) VALUES (?, ?, ?, ?, ?, ?)",
      ["s-sql-missing", now - 120, now - 180, "missing file", tempDir, "/nonexistent/machine/path.jsonl"]
    );
    db.close();

    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: dbPath });
    const list = adapter.listSessionsByTimeRange!({ since: 0, limit: 10 });
    expect(list).toHaveLength(2);
    const counted = list.find((s) => s.id === "s-sql-count");
    expect(counted?.message_count).toBe(4);
    const missing = list.find((s) => s.id === "s-sql-missing");
    expect(missing?.message_count).toBe(0);

    // listSessions (no limit) uses the same sqlite path — same counts
    const full = adapter.listSessions();
    expect(full.find((s) => s.id === "s-sql-count")?.message_count).toBe(4);
  });

  test("sqlite list message_count agrees with detail message_count (BUG-9)", async () => {
    const dbPath = join(tempDir, "state_5.sqlite");
    const records: string[] = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "s-sql-agree", timestamp: "2024-01-01T00:00:00Z" },
      }),
    ];
    for (let i = 1; i <= 5; i++) {
      records.push(JSON.stringify({
        timestamp: `2024-01-01T00:0${i}:00Z`,
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: `u${i}` }] },
      }));
    }
    const rolloutPath = join(tempDir, "rollout-agree.jsonl");
    writeFileSync(rolloutPath, records.join("\n") + "\n");

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
    const now = Math.floor(Date.now() / 1000);
    db.run(
      "INSERT INTO threads (id, updated_at, created_at, title, cwd, rollout_path) VALUES (?, ?, ?, ?, ?, ?)",
      ["s-sql-agree", now, now - 60, "agreement", tempDir, rolloutPath]
    );
    db.close();

    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: dbPath });
    const list = adapter.listSessionsByTimeRange!({ since: 0, limit: 10 });
    const detail = await adapter.getSessionDetail!("s-sql-agree", {});
    expect(list[0].message_count).toBe(detail.message_count);
  });
});
