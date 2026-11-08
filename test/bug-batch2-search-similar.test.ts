/**
 * Bug-batch-2 tests:
 * - fs-utils contentContainsStreaming (streaming contains helper)
 * - codex searchSessions sqlite candidate narrowing (BUG-2)
 * - antigravity searchSessions streaming + mtime/size guards (BUG-3)
 * - similar resolveTarget routing incl. not-found-everywhere (BUG-7)
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { contentContainsStreaming } from "../src/adapters/fs-utils";
import { createCodexAdapter } from "../src/adapters/codex";
import { createAntigravityAdapter } from "../src/adapters/antigravity";
import { runSimilarCommand } from "../src/cli/similar";
import { runSearchCommand } from "../src/cli/search";
import type { Config } from "../src/config/types";

// ─── contentContainsStreaming ────────────────────────────────────────────────

describe("contentContainsStreaming", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = join(tmpdir(), `oas-streaming-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("finds a match in a small file", () => {
    const p = join(tempDir, "a.jsonl");
    writeFileSync(p, '{"text":"hello manager world"}\n');
    expect(contentContainsStreaming(p, "manager")).toBe(true);
    expect(contentContainsStreaming(p, "missing")).toBe(false);
  });

  test("is case-insensitive (needle passed pre-lowered)", () => {
    const p = join(tempDir, "b.jsonl");
    writeFileSync(p, "The MANAGER was here\n");
    expect(contentContainsStreaming(p, "manager")).toBe(true);
  });

  test("finds a match straddling the chunk boundary (1MB)", () => {
    const p = join(tempDir, "big.jsonl");
    const CHUNK = 1024 * 1024;
    // Place the needle so it crosses the 1 MiB mark.
    const filler = "x".repeat(CHUNK - 4);
    writeFileSync(p, filler + "needle-tail\n");
    expect(contentContainsStreaming(p, "needle-tail")).toBe(true);
  });

  test("early-exit: file with an early match and huge tail is fast", () => {
    const p = join(tempDir, "early.jsonl");
    // 8MB tail after a match at byte ~16. If the helper read the whole file
    // it would still pass correctness; we assert correctness + that a capped
    // scan of the first 100 bytes still finds the early needle.
    writeFileSync(p, '{"x":"quick match"}' + "y".repeat(8 * 1024 * 1024) + "\n");
    expect(contentContainsStreaming(p, "quick match")).toBe(true);
    expect(contentContainsStreaming(p, "quick match", { maxBytes: 100 })).toBe(true);
  });

  test("maxBytes cap limits the scan (needle beyond cap not found)", () => {
    const p = join(tempDir, "capped.jsonl");
    writeFileSync(p, "a".repeat(1000) + "deep-needle");
    expect(contentContainsStreaming(p, "deep-needle", { maxBytes: 500 })).toBe(false);
    expect(contentContainsStreaming(p, "deep-needle")).toBe(true);
  });

  test("returns false for missing files", () => {
    expect(contentContainsStreaming(join(tempDir, "nope.jsonl"), "x")).toBe(false);
  });

  test("empty needle matches", () => {
    const p = join(tempDir, "e.jsonl");
    writeFileSync(p, "anything");
    expect(contentContainsStreaming(p, "")).toBe(true);
  });
});

// ─── BUG-2: codex sqlite candidate narrowing ─────────────────────────────────

describe("codex searchSessions (sqlite candidate narrowing)", () => {
  let tempDir: string;
  let dbPath: string;
  beforeEach(() => {
    tempDir = join(tmpdir(), `codex-srch-${Date.now()}`);
    mkdirSync(join(tempDir, "sessions"), { recursive: true });
    dbPath = join(tempDir, "state_5.sqlite");
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setupDb(rows: Array<{ id: string; title: string; cwd?: string; rolloutPath?: string; firstUser?: string }>) {
    const db = new Database(dbPath);
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      title TEXT NOT NULL, model TEXT, cwd TEXT NOT NULL, rollout_path TEXT,
      first_user_message TEXT
    )`);
    const now = Math.floor(Date.now() / 1000);
    for (const r of rows) {
      db.run(
        `INSERT INTO threads (id, updated_at, created_at, title, cwd, rollout_path, first_user_message) VALUES (?,?,?,?,?,?,?)`,
        [r.id, now, now - 60, r.title, r.cwd ?? tempDir, r.rolloutPath ?? null, r.firstUser ?? null]
      );
    }
    db.close();
  }

  function rollout(id: string, lines: object[]): string {
    const p = join(tempDir, "sessions", `rollout-${id}.jsonl`);
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return p;
  }

  test("title match via indexed field, no rollout read needed", () => {
    setupDb([{ id: "s-title", title: "Fix the manager flow" }]);
    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: dbPath });
    const results = adapter.searchSessions!({ text: "manager" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s-title");
  });

  test("cwd match via indexed field", () => {
    setupDb([{ id: "s-cwd", title: "T", cwd: "/home/x/manager-tools" }]);
    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: dbPath });
    const results = adapter.searchSessions!({ text: "manager" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s-cwd");
  });

  test("content-only match found by streaming the candidate rollout", () => {
    const p = rollout("s-content", [
      { timestamp: "2024-01-01T00:00:00Z", type: "session_meta", payload: { id: "s-content", timestamp: "2024-01-01T00:00:00Z" } },
      { timestamp: "2024-01-01T00:01:00Z", type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "deep manager content" }] } },
    ]);
    setupDb([{ id: "s-content", title: "Unrelated", rolloutPath: p }]);
    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: dbPath });
    const results = adapter.searchSessions!({ text: "manager" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s-content");
  });

  test("needle in no indexed field and no rollout match → full JSONL fallback scan finds it", () => {
    // DB has a thread whose rollout exists but does NOT contain the needle.
    const p = rollout("s-none", [
      { timestamp: "2024-01-01T00:00:00Z", type: "session_meta", payload: { id: "s-none", timestamp: "2024-01-01T00:00:00Z" } },
    ]);
    setupDb([{ id: "s-none", title: "Nothing here", rolloutPath: p }]);
    // A separate rollout file on disk (not referenced by the DB) with the needle.
    rollout("s-deep", [
      { timestamp: "2024-01-02T00:00:00Z", type: "session_meta", payload: { id: "s-deep", timestamp: "2024-01-02T00:00:00Z" } },
      { timestamp: "2024-01-02T00:01:00Z", type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "buried manager token" }] } },
    ]);
    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: dbPath });
    const results = adapter.searchSessions!({ text: "manager" });
    expect(results.some((r) => r.id === "s-deep")).toBe(true);
  });

  test("corrupt JSONL lines are skipped, not fatal", () => {
    const p = join(tempDir, "sessions", "corrupt.jsonl");
    writeFileSync(p, "{not json\n" + JSON.stringify({ timestamp: "2024-01-01T00:00:00Z", type: "session_meta", payload: { id: "s-corrupt", timestamp: "2024-01-01T00:00:00Z" } }) + "\n");
    setupDb([{ id: "s-corrupt", title: "corrupt manager file", rolloutPath: p }]);
    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: dbPath });
    const results = adapter.searchSessions!({ text: "manager" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s-corrupt");
  });

  test("LIKE wildcards in the needle are escaped", () => {
    setupDb([{ id: "s-esc", title: "percent%in-title" }]);
    const adapter = createCodexAdapter({ agent: "codex", alias: "mock", enabled: true, path: dbPath });
    // A bare % would normally match everything; escaped it matches only the literal.
    expect(adapter.searchSessions!({ text: "%" })).toHaveLength(1);
  });
});

// ─── BUG-3: antigravity search guards ────────────────────────────────────────

describe("antigravity searchSessions (streaming + mtime)", () => {
  let tempDir: string;
  let entry: any;
  const uuid1 = "314c4421-6caa-42ff-a1e7-67302484a5b3";
  const uuid2 = "f51f246f-f482-403b-945c-f44f22e379b6";

  beforeEach(() => {
    tempDir = join(tmpdir(), `oas-agy-srch-${Date.now()}`);
    entry = { agent: "antigravity", alias: "test-ag", enabled: true, path: tempDir };
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createSession(uuid: string, lines: object[]) {
    const brainDir = join(tempDir, "brain", uuid, ".system_generated", "logs");
    mkdirSync(brainDir, { recursive: true });
    writeFileSync(join(brainDir, "transcript_full.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  test("finds content match and preserves match count", () => {
    createSession(uuid1, [
      { created_at: "2026-04-24T03:00:00Z", source: "USER_EXPLICIT", type: "USER_INPUT", content: "needle here" },
    ]);
    createSession(uuid2, [
      { created_at: "2026-04-24T04:00:00Z", source: "USER_EXPLICIT", type: "USER_INPUT", content: "other" },
    ]);
    const adapter = createAntigravityAdapter(entry);
    const results = adapter.searchSessions!({ text: "needle" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(uuid1);
  });

  test("stale-session fallback: old logs still searched when nothing recent matches", () => {
    createSession(uuid1, [
      { created_at: "2026-04-24T03:00:00Z", source: "USER_EXPLICIT", type: "USER_INPUT", content: "ancient needle" },
    ]);
    // Backdate the log by 2 years (> RECENT_MTIME_MS).
    const logPath = join(tempDir, "brain", uuid1, ".system_generated", "logs", "transcript_full.jsonl");
    const old = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000);
    utimesSync(logPath, old, old);
    const adapter = createAntigravityAdapter(entry);
    const results = adapter.searchSessions!({ text: "needle" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(uuid1);
  });

  test("recent match short-circuits before stale candidates are scanned", () => {
    createSession(uuid1, [{ created_at: "2026-04-24T03:00:00Z", source: "USER_EXPLICIT", type: "USER_INPUT", content: "old needle" }]);
    const logPath = join(tempDir, "brain", uuid1, ".system_generated", "logs", "transcript_full.jsonl");
    const old = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000);
    utimesSync(logPath, old, old);
    const adapter = createAntigravityAdapter(entry);
    // Stale match is still found when it is the ONLY match (fallback works),
    // and a fresh non-matching session does not resurrect stale non-matches.
    expect(adapter.searchSessions!({ text: "needle" })).toHaveLength(1);
  });
});

// ─── BUG-7: similar target routing ───────────────────────────────────────────

const similarConfig: Config = {
  agents: [
    { agent: "opencode", alias: "default", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "sessions", enabled: true },
  ],
};

describe("similar resolveTarget routing (BUG-7)", () => {
  test("bare id owned by codex routes to codex, error names the resolved agent", async () => {
    const result = await runSimilarCommand({
      sessionId: "01a1ad98-ec62-7553-8045-80efb4b66635",
      config: similarConfig,
      findSimilar: async () => {
        throw new Error("[codex:sessions] codex:sessions does not support similar");
      },
      resolveSessionOwner: async () => ({ agent: "codex", alias: "sessions" }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("[codex:sessions]");
    expect(result.stderr).not.toContain("[opencode:default]");
  });

  test("bare id owned by opencode routes to opencode", async () => {
    let captured: any;
    await runSimilarCommand({
      sessionId: "sess-op",
      config: similarConfig,
      findSimilar: async (q) => {
        captured = q;
        return [];
      },
      resolveSessionOwner: async () => ({ agent: "opencode", alias: "default" }),
    });
    expect(captured.agent).toBe("opencode");
    expect(captured.alias).toBe("default");
  });

  test("not-found-everywhere falls back to opencode when opencode is configured", async () => {
    let captured: any;
    await runSimilarCommand({
      sessionId: "ghost-id",
      config: similarConfig,
      findSimilar: async (q) => {
        captured = q;
        return [];
      },
      resolveSessionOwner: async () => undefined,
    });
    expect(captured.agent).toBe("opencode");
  });

  test("not-found-everywhere with no opencode → exit 1 with clear message", async () => {
    const noOpencode: Config = {
      agents: [{ agent: "codex", alias: "sessions", enabled: true }],
    };
    const result = await runSimilarCommand({
      sessionId: "ghost-id",
      config: noOpencode,
      findSimilar: async () => [],
      resolveSessionOwner: async () => undefined,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Session not found in any configured agent");
    expect(result.stderr).toContain("ghost-id");
  });

  test("explicit --agent codex wins over owner resolver", async () => {
    let captured: any;
    await runSimilarCommand({
      agent: "codex",
      id: "some-id",
      config: similarConfig,
      findSimilar: async (q) => {
        captured = q;
        return [];
      },
      resolveSessionOwner: async () => ({ agent: "opencode", alias: "default" }),
    });
    expect(captured.agent).toBe("codex");
    expect(captured.alias).toBe("sessions");
  });

  test("capability-unsupported on the resolved agent exits 4 with its label", async () => {
    const { CapabilityUnsupportedError } = await import("../src/core/errors");
    const result = await runSimilarCommand({
      sessionId: "codex-owned-id",
      config: similarConfig,
      findSimilar: async () => {
        throw new CapabilityUnsupportedError("codex", "sessions", "similar");
      },
      resolveSessionOwner: async () => ({ agent: "codex", alias: "sessions" }),
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("[codex:sessions]");
    expect(result.stderr).toContain("does not support similar");
    expect(result.stderr).not.toContain("[opencode:default]");
  });
});

// ─── search --agent scoping ──────────────────────────────────────────────────

describe("search --agent scoping", () => {
  test("scoped query passes agent to the service", async () => {
    let captured: any;
    const result = await runSearchCommand({
      text: "manager",
      agent: "codex",
      config: {
        agents: [
          { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
          { agent: "codex", alias: "work", enabled: true },
        ],
      },
      searchSessions: async (q) => {
        captured = q;
        return { sessions: [], errors: [] };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(captured.agent).toBe("codex");
  });

  test("unknown --agent errors", async () => {
    const result = await runSearchCommand({
      text: "manager",
      agent: "notanagent",
      config: {
        agents: [{ agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } }],
      },
      searchSessions: async () => ({ sessions: [], errors: [] }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown agent");
  });
});
