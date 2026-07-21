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
});
