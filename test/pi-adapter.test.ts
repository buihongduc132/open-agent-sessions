import { describe, expect, test } from "bun:test";
import { createPiAdapter } from "../src/adapters/pi";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

describe("Pi Adapter", () => {
  const tmpDir = join(process.cwd(), ".tmp-pi-test");

  test("listSessions returns sessions from directory structure", () => {
    // Setup mock directory structure
    const session1Dir = join(tmpDir, "session1");
    mkdirSync(session1Dir, { recursive: true });
    
    const now = new Date().toISOString();
    const event = {
      type: "message",
      timestamp: now,
      message: {
        role: "user",
        content: "Hello Pi"
      }
    };
    writeFileSync(join(session1Dir, "events.jsonl"), JSON.stringify(event) + "\n");

    const adapter = createPiAdapter(
      { agent: "pi", alias: "pi-test", enabled: true },
      { defaultPath: tmpDir }
    );

    const sessions = adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("session1");
    expect(sessions[0].title).toBe("Hello Pi");
    expect(sessions[0].agent).toBe("pi");

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("getSessionDetail returns messages", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const session1Dir = join(tmpDir, "session1");
    mkdirSync(session1Dir, { recursive: true });
    
    const now = new Date().toISOString();
    const event1 = {
      type: "message",
      id: "msg1",
      timestamp: now,
      message: {
        role: "user",
        content: "Hello Pi"
      }
    };
    const event2 = {
      type: "message",
      id: "msg2",
      timestamp: now,
      message: {
        role: "assistant",
        content: "Hello human"
      }
    };
    writeFileSync(join(session1Dir, "events.jsonl"), JSON.stringify(event1) + "\n" + JSON.stringify(event2) + "\n");

    const adapter = createPiAdapter(
      { agent: "pi", alias: "pi-test", enabled: true },
      { defaultPath: tmpDir }
    );

    const detail = await adapter.getSessionDetail("session1", {});
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0].role).toBe("user");
    expect(detail.messages[0].parts[0].text).toBe("Hello Pi");
    expect(detail.messages[1].role).toBe("assistant");
    expect(detail.messages[1].parts[0].text).toBe("Hello human");

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("listSessions includes flat multica session file in root dir (RCA G1 2026-09-02, RED)", () => {
    // Multica pi runtime stores sessions FLAT: <root>/<YYYYMMDDTHHmmSS.ns>.jsonl
    // (e.g. ~/.multica/pi-sessions/20260901T173710.372125995.jsonl) — no slug subdirectory.
    const flatRoot = join(process.cwd(), ".tmp-pi-flat-test");
    mkdirSync(flatRoot, { recursive: true });

    const userEvent = {
      type: "message",
      id: "flat-msg-1",
      timestamp: "2026-09-01T17:37:10.372Z",
      message: { role: "user", content: "flat multica session unique-gamma" }
    };
    const assistantEvent = {
      type: "message",
      id: "flat-msg-2",
      timestamp: "2026-09-01T17:38:00.000Z",
      message: { role: "assistant", content: "flat multica reply" }
    };
    writeFileSync(
      join(flatRoot, "20260901T173710.372125995.jsonl"),
      JSON.stringify(userEvent) + "\n" + JSON.stringify(assistantEvent) + "\n"
    );

    const adapter = createPiAdapter(
      { agent: "pi", alias: "pi-multica", enabled: true },
      { defaultPath: flatRoot }
    );

    const sessions = adapter.listSessions();
    const flat = sessions.find(s => s.id === "20260901T173710.372125995");
    expect(flat).toBeDefined();
    expect(flat!.title).toBe("flat multica session unique-gamma");
    expect(flat!.message_count).toBeGreaterThanOrEqual(2);
    expect(flat!.created_at).toBe("2026-09-01T17:37:10.372Z");
    expect(flat!.updated_at).toBe("2026-09-01T17:38:00.000Z");

    const hits = adapter.searchSessions!({ text: "unique-gamma" });
    expect(hits.some(s => s.id === "20260901T173710.372125995")).toBe(true);

    // Cleanup
    rmSync(flatRoot, { recursive: true, force: true });
  });
});
