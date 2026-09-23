/**
 * RED tests for src/cmd-usage/parser.ts
 *
 * extractBashCommands(filePath): extract bash toolCall commands from pi JSONL
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extractBashCommands } from "../../src/cmd-usage/parser";

const SESSIONS = join(import.meta.dir, "fixtures", "sessions");

describe("extractBashCommands", () => {
  test("extracts bash commands from simple session", () => {
    const file = join(SESSIONS, "session-bash-simple.jsonl");
    const calls = extractBashCommands(file);
    expect(calls.length).toBe(2);
    expect(calls[0].command).toBe("git fetch --all --prune");
    expect(calls[1].command).toBe("npm test --ci");
  });

  test("captures sessionId from session block", () => {
    const file = join(SESSIONS, "session-bash-simple.jsonl");
    const calls = extractBashCommands(file);
    expect(calls[0].sessionId).toBe("sess-bash-simple");
    expect(calls[1].sessionId).toBe("sess-bash-simple");
  });

  test("captures timestamp from message", () => {
    const file = join(SESSIONS, "session-bash-simple.jsonl");
    const calls = extractBashCommands(file);
    expect(calls[0].ts).toBe("2026-07-15T10:00:10.000Z");
  });

  test("captures toolCallId", () => {
    const file = join(SESSIONS, "session-bash-simple.jsonl");
    const calls = extractBashCommands(file);
    expect(calls[0].toolCallId).toBe("call_001");
    expect(calls[1].toolCallId).toBe("call_002");
  });

  test("skips non-bash toolCalls (read, write)", () => {
    const file = join(SESSIONS, "session-no-bash.jsonl");
    const calls = extractBashCommands(file);
    expect(calls).toEqual([]);
  });

  test("handles compound commands", () => {
    const file = join(SESSIONS, "session-bash-compound.jsonl");
    const calls = extractBashCommands(file);
    expect(calls.length).toBe(2);
    expect(calls[0].command).toBe("sudo git diff --stat && npm test --ci");
    expect(calls[1].command).toBe("env FOO=bar mise run deploy-prod");
  });

  test("handles multi-line JSON (literal newlines in command)", () => {
    const file = join(SESSIONS, "session-multiline.jsonl");
    const calls = extractBashCommands(file);
    expect(calls.length).toBe(1);
    expect(calls[0].command).toContain("python3");
  });

  test("returns empty array for file with no messages", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "cmd-parser-"));
    const file = join(tmp, "session.jsonl");
    await writeFile(
      file,
      '{"type":"session","version":3,"id":"s1","timestamp":"2026-07-15T10:00:00.000Z","cwd":"/tmp"}\n',
    );
    const calls = extractBashCommands(file);
    expect(calls).toEqual([]);
    await rm(tmp, { recursive: true, force: true });
  });

  test("handles missing arguments.command gracefully", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "cmd-parser-"));
    const file = join(tmp, "session.jsonl");
    await writeFile(
      file,
      [
        '{"type":"session","version":3,"id":"s1","timestamp":"2026-07-15T10:00:00.000Z","cwd":"/tmp"}',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-15T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{}}]}}',
      ].join("\n") + "\n",
    );
    const calls = extractBashCommands(file);
    // Should skip entries without command
    expect(calls).toEqual([]);
    await rm(tmp, { recursive: true, force: true });
  });

  test("handles malformed JSON lines", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "cmd-parser-"));
    const file = join(tmp, "session.jsonl");
    await writeFile(
      file,
      [
        '{"type":"session","version":3,"id":"s1","timestamp":"2026-07-15T10:00:00.000Z","cwd":"/tmp"}',
        'this is not valid json',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-15T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"echo hi"}}]}}',
      ].join("\n") + "\n",
    );
    const calls = extractBashCommands(file);
    expect(calls.length).toBe(1);
    expect(calls[0].command).toBe("echo hi");
    await rm(tmp, { recursive: true, force: true });
  });

  test("tracks sessionId across multiple session blocks", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "cmd-parser-"));
    const file = join(tmp, "session.jsonl");
    await writeFile(
      file,
      [
        '{"type":"session","version":3,"id":"sess-1","timestamp":"2026-07-15T10:00:00.000Z","cwd":"/tmp"}',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-15T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"echo first"}}]}}',
        '{"type":"session","version":3,"id":"sess-2","timestamp":"2026-07-15T11:00:00.000Z","cwd":"/tmp"}',
        '{"type":"message","id":"m2","parentId":null,"timestamp":"2026-07-15T11:00:05.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c2","name":"bash","arguments":{"command":"echo second"}}]}}',
      ].join("\n") + "\n",
    );
    const calls = extractBashCommands(file);
    expect(calls.length).toBe(2);
    expect(calls[0].sessionId).toBe("sess-1");
    expect(calls[1].sessionId).toBe("sess-2");
    await rm(tmp, { recursive: true, force: true });
  });

  test("ignores user messages", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "cmd-parser-"));
    const file = join(tmp, "session.jsonl");
    await writeFile(
      file,
      [
        '{"type":"session","version":3,"id":"s1","timestamp":"2026-07-15T10:00:00.000Z","cwd":"/tmp"}',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-15T10:00:05.000Z","message":{"role":"user","content":[{"type":"text","text":"run bash"}]}}',
        '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-15T10:00:10.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"echo hello"}}]}}',
      ].join("\n") + "\n",
    );
    const calls = extractBashCommands(file);
    expect(calls.length).toBe(1);
    expect(calls[0].command).toBe("echo hello");
    await rm(tmp, { recursive: true, force: true });
  });
});
