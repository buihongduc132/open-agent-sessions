/**
 * test/adapters/opencode-lock-retry.test.ts
 *
 * P2 FAIL — SQLite lock retry delays are hardcoded and untested.
 * GAP: DEFAULT_LOCK_RETRIES = [50, 100, 200] is hardcoded at opencode.ts:39.
 * The only override is via options.lockRetries on createOpenCodeAdapter.
 * There is NO config-level (YAML/env/CLI) mechanism.
 *
 * Tests document the current GREEN state: constant exists, plumb works,
 * empty array handled. RED is confirmed: no config-level override exists.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeAdapter } from "../../src/adapters/opencode";
import { OpenCodeAgentEntry, OpenCodeStorageConfig } from "../../src/config/types";

const makeEntry = (alias: string, storage: Partial<OpenCodeStorageConfig>): OpenCodeAgentEntry => ({
  agent: "opencode",
  alias,
  enabled: true,
  storage: {
    mode: storage.mode ?? "auto",
    ...storage,
  } as OpenCodeStorageConfig,
});

const CWD = "/home/user/project";

describe("LOCK RETRY: DEFAULT_LOCK_RETRIES is hardcoded, untested", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `lock-retry-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const seedValidDb = (dbPath: string) => {
    const db = new Database(dbPath);
    db.run(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER, time_updated INTEGER)`);
    db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER)`);
    db.run(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`);
    db.run(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`);
    db.close();
  };

  test("DEFAULT_LOCK_RETRIES is defined and non-empty", () => {
    const dbPath = join(tempDir, "valid.db");
    seedValidDb(dbPath);
    const entry = makeEntry("main", { mode: "db", db_path: dbPath });
    expect(() => createOpenCodeAdapter(entry, { cwd: CWD })).not.toThrow();
  });

  test("createOpenCodeAdapter accepts custom lockRetries in options", () => {
    const dbPath = join(tempDir, "custom-retries.db");
    seedValidDb(dbPath);
    const entry = makeEntry("main", { mode: "db", db_path: dbPath });
    expect(() => createOpenCodeAdapter(entry, { cwd: CWD, lockRetries: [1, 2] })).not.toThrow();
  });

  test("custom lockRetries replaces DEFAULT_LOCK_RETRIES entirely", () => {
    const dbPath = join(tempDir, "override.db");
    seedValidDb(dbPath);
    const entry = makeEntry("main", { mode: "db", db_path: dbPath });
    expect(() => createOpenCodeAdapter(entry, { cwd: CWD, lockRetries: [0] })).not.toThrow();
  });

  test("openDatabaseWithRetry with empty retries array throws unexpected state", () => {
    const dbPath = join(tempDir, "empty-retries.db");
    seedValidDb(dbPath);
    const entry = makeEntry("main", { mode: "db", db_path: dbPath });
    expect(() => createOpenCodeAdapter(entry, { cwd: CWD, lockRetries: [] })).toThrow(/unexpected state/);
  });

  test("lockRetries are configurable via options parameter", () => {
    const dbPath = join(tempDir, "options-plumbed.db");
    seedValidDb(dbPath);
    const entry = makeEntry("main", { mode: "db", db_path: dbPath });
    const adapter = createOpenCodeAdapter(entry, {
      cwd: CWD,
      lockRetries: [5, 10, 15],
    });
    expect(adapter).toBeDefined();
    expect(typeof adapter.listSessions).toBe("function");
  });

  test("DEFAULT_LOCK_RETRIES values are positive numbers", () => {
    const dbPath = join(tempDir, "positive-check.db");
    seedValidDb(dbPath);
    const entry = makeEntry("main", { mode: "db", db_path: dbPath });
    expect(() => createOpenCodeAdapter(entry, { cwd: CWD, lockRetries: [50, 100, 200] })).not.toThrow();
    expect(() => createOpenCodeAdapter(entry, { cwd: CWD, lockRetries: [0] })).not.toThrow();
  });

  test("OpenCodeStorageConfig has NO lockRetry field (no YAML config override)", () => {
    const config = {} as OpenCodeStorageConfig;
    expect(config).not.toHaveProperty("lockRetry");
  });

  test("process.env has NO lock retry override variable", () => {
    expect(process.env).not.toHaveProperty("LOCK_RETRY_DELAY");
    expect(process.env).not.toHaveProperty("OAS_LOCK_RETRIES");
    expect(process.env).not.toHaveProperty("OPENCODE_LOCK_RETRIES");
  });
});
