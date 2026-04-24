import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAntigravityAdapter } from "../src/adapters/antigravity";
import { OtherAgentEntry } from "../src/config/types";

describe("AntigravityAdapter", () => {
  let tmpDir: string;
  let entry: OtherAgentEntry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "oas-antigravity-test-"));
    entry = {
      agent: "antigravity",
      alias: "test-ag",
      enabled: true,
      path: tmpDir,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const uuid1 = "314c4421-6caa-42ff-a1e7-67302484a5b3";
  const uuid2 = "f51f246f-f482-403b-945c-f44f22e379b6";

  function createSession(uuid: string, logs: any[]) {
    const brainDir = join(tmpDir, "brain", uuid, ".system_generated", "logs");
    mkdirSync(brainDir, { recursive: true });
    writeFileSync(join(brainDir, "overview.txt"), logs.map(l => JSON.stringify(l)).join("\n"));
  }

  it("lists sessions from brain directories", () => {
    createSession(uuid1, [{ created_at: "2026-04-24T03:00:00Z", source: "USER_EXPLICIT", type: "USER_INPUT", content: "Hi" }]);
    createSession(uuid2, [{ created_at: "2026-04-24T04:00:00Z", source: "USER_EXPLICIT", type: "USER_INPUT", content: "Hello" }]);

    const adapter = createAntigravityAdapter(entry);
    const sessions = adapter.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.id).sort()).toEqual([uuid1, uuid2].sort());
  });

  it("extracts session title from first USER_INPUT log entry", () => {
    createSession(uuid1, [
      { created_at: "2026-04-24T03:00:00Z", source: "SYSTEM", type: "START", content: "System start" },
      { created_at: "2026-04-24T03:01:00Z", source: "USER_EXPLICIT", type: "USER_INPUT", content: "My Real Title\nSecond line" }
    ]);

    const adapter = createAntigravityAdapter(entry);
    const sessions = adapter.listSessions();
    expect(sessions[0].title).toBe("My Real Title");
  });

  it("extracts created_at and updated_at from logs", () => {
    createSession(uuid1, [
      { created_at: "2026-04-24T03:00:00Z", source: "USER_EXPLICIT", type: "USER_INPUT", content: "1" },
      { created_at: "2026-04-24T03:05:00Z", source: "MODEL", type: "PLANNER_RESPONSE", content: "2" }
    ]);

    const adapter = createAntigravityAdapter(entry);
    const sessions = adapter.listSessions();
    expect(sessions[0].created_at).toBe("2026-04-24T03:00:00.000Z");
    expect(sessions[0].updated_at).toBe("2026-04-24T03:05:00.000Z");
  });

  it("counts messages (USER_INPUT + PLANNER_RESPONSE)", () => {
    createSession(uuid1, [
      { source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-04-24T03:00:00Z" },
      { source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-04-24T03:01:00Z" },
      { source: "SYSTEM", type: "OTHER", created_at: "2026-04-24T03:02:00Z" }
    ]);

    const adapter = createAntigravityAdapter(entry);
    const sessions = adapter.listSessions();
    expect(sessions[0].message_count).toBe(2);
  });

  it("returns empty array when no brain dirs exist", () => {
    const adapter = createAntigravityAdapter(entry);
    expect(adapter.listSessions()).toEqual([]);
  });

  it("handles missing overview.txt gracefully", () => {
    mkdirSync(join(tmpDir, "brain", uuid1, ".system_generated", "logs"), { recursive: true });
    const adapter = createAntigravityAdapter(entry);
    const sessions = adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe(uuid1);
  });

  it("searchSessions matches content text", () => {
    createSession(uuid1, [{ created_at: "2026-04-24T03:00:00Z", content: "needle in haystack" }]);
    const adapter = createAntigravityAdapter(entry);
    const results = adapter.searchSessions!({ text: "needle" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(uuid1);
  });

  it("getSessionDetail returns structured messages", async () => {
    createSession(uuid1, [
      { created_at: "2026-04-24T03:00:00Z", source: "USER_EXPLICIT", type: "USER_INPUT", content: "user msg" },
      { created_at: "2026-04-24T03:01:00Z", source: "MODEL", type: "PLANNER_RESPONSE", content: "model msg" }
    ]);

    const adapter = createAntigravityAdapter(entry);
    const detail = await adapter.getSessionDetail(uuid1, {});
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages![0].role).toBe("user");
    expect(detail.messages![1].role).toBe("assistant");
  });

  it("getSessionDetail maps tool_calls from PLANNER_RESPONSE", async () => {
    createSession(uuid1, [
      {
        created_at: "2026-04-24T03:01:00Z",
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        content: "calling tool",
        tool_calls: [{ name: "read_file", args: { path: "f.txt" } }]
      }
    ]);

    const adapter = createAntigravityAdapter(entry);
    const detail = await adapter.getSessionDetail(uuid1, {});
    const toolPart = detail.messages![0].parts.find(p => p.type === "tool");
    expect(toolPart).toBeDefined();
    expect((toolPart as any).tool).toBe("read_file");
  });

  it("getSessionDetail supports selection modes", async () => {
    createSession(uuid1, [
      { created_at: "2026-04-24T03:00:00Z", source: "USER_EXPLICIT", type: "USER_INPUT", content: "1" },
      { created_at: "2026-04-24T03:01:00Z", source: "USER_EXPLICIT", type: "USER_INPUT", content: "2" }
    ]);

    const adapter = createAntigravityAdapter(entry);
    const last1 = await adapter.getSessionDetail(uuid1, { selection: { mode: "last", count: 1 } });
    expect(last1.messages).toHaveLength(1);
    expect(last1.messages![0].parts[0].text).toBe("2");
  });

  it("getSessionDetail supports userOnly filter", async () => {
    createSession(uuid1, [
      { created_at: "2026-04-24T03:00:00Z", source: "USER_EXPLICIT", type: "USER_INPUT", content: "u" },
      { created_at: "2026-04-24T03:01:00Z", source: "MODEL", type: "PLANNER_RESPONSE", content: "a" }
    ]);

    const adapter = createAntigravityAdapter(entry);
    const userOnly = await adapter.getSessionDetail(uuid1, { userOnly: true });
    expect(userOnly.messages).toHaveLength(1);
    expect(userOnly.messages![0].role).toBe("user");
  });

  it("getSessionDetail throws when session not found", () => {
    const adapter = createAntigravityAdapter(entry);
    expect(adapter.getSessionDetail("none", {})).rejects.toThrow(/session not found/);
  });

  it("ignores non-UUID directories in brain", () => {
    mkdirSync(join(tmpDir, "brain", "not-a-uuid", ".system_generated", "logs"), { recursive: true });
    const adapter = createAntigravityAdapter(entry);
    expect(adapter.listSessions()).toHaveLength(0);
  });
});
