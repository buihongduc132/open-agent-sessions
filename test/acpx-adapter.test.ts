import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAcpxAdapter } from "../src/adapters/acpx";

// ---------------------------------------------------------------------------
// Per-test temp directory — afterEach cleans up between tests
// ---------------------------------------------------------------------------

let _currentDir = "";

afterEach(() => {
  if (_currentDir) {
    try {
      rmSync(_currentDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    _currentDir = "";
  }
});

function newDir(): string {
  _currentDir = join(
    "/tmp",
    `acpx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  );
  mkdirSync(_currentDir, { recursive: true });
  return _currentDir;
}

// ---------------------------------------------------------------------------
// Session file helpers
// ---------------------------------------------------------------------------

/**
 * Write a valid acpx session JSON to the sessions dir.
 * The sessionId inside the JSON is the canonical ID used for lookup.
 * Filenames are sanitized to avoid filesystem restrictions.
 */
function writeSession(
  baseDir: string,
  sessionId: string,
  agent: string,
  overrides: Record<string, unknown> = {}
): void {
  const dir = join(baseDir, "sessions");
  mkdirSync(dir, { recursive: true });
  const data = {
    sessionId,
    agent,
    scope: "/test/scope",
    name: null,
    closed: false,
    pid: 0,
    runtimeSessionId: null,
    last_prompt: [
      {
        role: "user",
        timestamp: "2025-06-12T09:00:00.000Z",
        textPreview: "Test prompt",
      },
    ],
    ...overrides,
  };
  // Sanitize filename — ':' and '/' are invalid in Linux filenames
  const safe = sessionId.replace(/[/:\\]/g, "_");
  writeFileSync(join(dir, `${safe}.json`), JSON.stringify(data), "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acpx adapter", () => {
  // ── Agent validation ──────────────────────────────────────────────────────

  test("throws for non-acpx agent (deferred to query time — OT4)", () => {
    // Construction no longer throws (OT4: one broken adapter must not kill the registry).
    // The error surfaces on first query with the agent label.
    const adapter = createAcpxAdapter(
      { agent: "opencode" as any, alias: "default", enabled: true }
    );
    expect(adapter.version).toBe("0.0.0-broken");
    expect(() => adapter.listSessions()).toThrow(/acpx adapter requires agent "acpx"/);
  });

  test("returns version string", () => {
    const dir = newDir();
    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    expect(adapter.version).toBe("1.0.0");
  });

  // ── listSessions ──────────────────────────────────────────────────────────

  test("listSessions returns empty when sessions dir does not exist", () => {
    const dir = newDir();
    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    expect(adapter.listSessions()).toEqual([]);
  });

  test("listSessions returns sessions sorted by updated_at descending", () => {
    const dir = newDir();
    // Distinct days so ISO string ordering is unambiguous
    writeSession(dir, "oldest", "opencode", {
      last_prompt: [
        { role: "user", timestamp: "2025-06-10T12:00:00.000Z", textPreview: "Oldest" },
      ],
    });
    writeSession(dir, "middle", "codex", {
      last_prompt: [
        { role: "user", timestamp: "2025-06-11T12:00:00.000Z", textPreview: "Middle" },
      ],
    });
    writeSession(dir, "newest", "claude", {
      last_prompt: [
        { role: "user", timestamp: "2025-06-12T12:00:00.000Z", textPreview: "Newest" },
      ],
    });

    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    const sessions = adapter.listSessions();

    expect(sessions).toHaveLength(3);
    expect(sessions[0].id).toBe("newest");
    expect(sessions[1].id).toBe("middle");
    expect(sessions[2].id).toBe("oldest");
  });

  test("listSessions skips malformed JSON files", () => {
    const dir = newDir();
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeSession(dir, "valid-session", "claude");
    writeFileSync(join(sessionsDir, "bad-file.json"), "{ broken }", "utf8");

    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    expect(adapter.listSessions()).toHaveLength(1);
  });

  test("listSessions maps fields to SessionSummary correctly", () => {
    const dir = newDir();
    writeSession(dir, "my-session-id", "codex");

    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "my-alias", enabled: true },
      { basePath: dir }
    );
    const sessions = adapter.listSessions();

    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.id).toBe("my-session-id");
    expect(s.agent).toBe("codex");
    expect(s.alias).toBe("/test/scope"); // name is null → scope
    expect(s.title).toBe("my-session-id");
    expect(s.message_count).toBe(1);
    expect(s.storage).toBe("other");
  });

  test("listSessions uses name as alias when present", () => {
    const dir = newDir();
    writeSession(dir, "named-session", "claude", { name: "my-named-session" });

    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    expect(adapter.listSessions()[0].alias).toBe("my-named-session");
  });

  test("listSessions casts known agents correctly", () => {
    const dir = newDir();
    writeSession(dir, "s-opencode", "opencode");
    writeSession(dir, "s-codex", "codex");
    writeSession(dir, "s-claude", "claude");
    writeSession(dir, "s-unknown", "gemini"); // unknown → falls back to opencode

    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    const sessions = adapter.listSessions();
    expect(sessions.find((s) => s.id === "s-opencode")?.agent).toBe("opencode");
    expect(sessions.find((s) => s.id === "s-codex")?.agent).toBe("codex");
    expect(sessions.find((s) => s.id === "s-claude")?.agent).toBe("claude");
    expect(sessions.find((s) => s.id === "s-unknown")?.agent).toBe("opencode");
  });

  // ── searchSessions ────────────────────────────────────────────────────────

  test("searchSessions returns empty when sessions dir missing", () => {
    const dir = newDir();
    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    expect(adapter.searchSessions!({ text: "health" })).toEqual([]);
  });

  test("searchSessions matches sessionId", () => {
    const dir = newDir();
    writeSession(dir, "session-with-health", "codex");
    writeSession(dir, "other-session", "opencode");

    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    const results = adapter.searchSessions!({ text: "health" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("session-with-health");
  });

  test("searchSessions matches prompt textPreview", () => {
    const dir = newDir();
    writeSession(dir, "health-session", "codex");
    writeSession(dir, "other-session", "opencode", {
      last_prompt: [
        { role: "user", timestamp: "2025-06-12T09:00:00.000Z", textPreview: "Something else entirely" },
      ],
    });

    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    const results = adapter.searchSessions!({ text: "health" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("health-session");
  });

  test("searchSessions is case-insensitive", () => {
    const dir = newDir();
    writeSession(dir, "health-session", "claude");

    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    expect(adapter.searchSessions!({ text: "HEALTH" })).toHaveLength(1);
    expect(adapter.searchSessions!({ text: "Health" })).toHaveLength(1);
  });

  // ── getSessionDetail ──────────────────────────────────────────────────────

  test("getSessionDetail returns session with messages", async () => {
    const dir = newDir();
    writeSession(dir, "detail-session", "codex", {
      last_prompt: [
        {
          role: "user",
          timestamp: "2025-06-12T09:00:00.000Z",
          textPreview: "First prompt text",
        },
        {
          role: "user",
          timestamp: "2025-06-12T10:00:00.000Z",
          textPreview: "Second prompt text",
        },
      ],
    });

    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    const detail = await adapter.getSessionDetail!("detail-session", {});

    expect(detail.id).toBe("detail-session");
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages![0].parts[0]).toEqual({
      type: "text",
      text: "First prompt text",
    });
    expect(detail.messages![1].parts[0]).toEqual({
      type: "text",
      text: "Second prompt text",
    });
  });

  test("getSessionDetail throws for unknown sessionId", async () => {
    const dir = newDir();
    writeSession(dir, "existing-session", "codex");

    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    await expect(
      adapter.getSessionDetail!("does-not-exist", {})
    ).rejects.toThrow(/session not found/);
  });

  test("getSessionDetail includes closed warning", async () => {
    const dir = newDir();
    writeSession(dir, "closed-session", "claude", {
      closed: true,
      pid: 99999,
    });

    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    const detail = await adapter.getSessionDetail!("closed-session", {});
    expect(detail.warning).toContain("closed");
    expect(detail.warning).toContain("99999");
  });

  // ── forkSession ───────────────────────────────────────────────────────────

  test("forkSession returns ForkResult with synthetic newSessionId", async () => {
    const dir = newDir();
    const adapter = createAcpxAdapter(
      { agent: "acpx", alias: "default", enabled: true },
      { basePath: dir }
    );
    const result = await adapter.forkSession!("parent-session-id", "opencode", "my-alias");

    expect(result.parentSessionId).toBe("parent-session-id");
    expect(result.destAgent).toBe("opencode");
    expect(result.destAlias).toBe("my-alias");
    expect(result.newSessionId).toMatch(/^opencode:my-alias:forked-\d+$/);
    expect(result.forkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
