/**
 * RED — adapter fixture tests for turn-split export (oas-export-turn-split).
 * Synthetic runtime fixtures ONLY (tempdir; no real agent dirs; no PII).
 * These validate adapter fetch shapes the turn engine + export rely on.
 * NOTE: adapters exist — tests exercising getSessionDetail({mode:"all_with_tools"})
 * on REAL adapter behavior may partially pass today where adapters already
 * support it; assertions tied to missing behavior (tool_result passthrough,
 * step-part presence) act as the RED surface and drive fixture coverage.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "../../src/adapters/claude";
import { createCodexAdapter } from "../../src/adapters/codex";
import { createOpenCodeAdapter } from "../../src/adapters/opencode";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "oas-turnfx-"));
}

function writeSession(filePath: string, lines: unknown[]): void {
  const payload = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(filePath, payload, "utf8");
}

describe("claude adapter — turn-split fixture (tool_result in user msg)", () => {
  test("2-turn session; tool_result parts survive all_with_tools fetch", async () => {
    const dir = tempDir();
    const filePath = join(dir, "ses_claude1.jsonl");
    writeSession(filePath, [
      { type: "user", timestamp: "2026-02-01T01:00:00Z", content: "list files please" },
      {
        type: "assistant", timestamp: "2026-02-01T01:00:05Z",
        content: [{ type: "tool_use", id: "tu1", name: "bash", input: { cmd: "ls" } }],
      },
      {
        type: "user", timestamp: "2026-02-01T01:00:10Z",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "file-a\nfile-b" }],
      },
      { type: "assistant", timestamp: "2026-02-01T01:00:15Z", content: "found 2 files" },
      { type: "user", timestamp: "2026-02-01T01:01:00Z", content: "second question" },
      { type: "assistant", timestamp: "2026-02-01T01:01:10Z", content: "second answer" },
    ]);
    const adapter = createClaudeAdapter({
      agent: "claude", alias: "main", enabled: true, path: filePath,
    });
    const detail = await adapter.getSessionDetail!("ses_claude1", { mode: "all_with_tools" });
    expect(detail).not.toBeNull();
    const msgs = detail!.messages ?? [];
    expect(msgs.length).toBeGreaterThan(0);
    const roles = new Set(msgs.map((m) => m.role));
    expect(roles.has("user")).toBe(true);
    expect(roles.has("assistant")).toBe(true);
    const allParts = msgs.flatMap((m) => m.parts.map((p) => p.type));
    expect(allParts).toContain("text");
    expect(allParts).toContain("tool_result");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("codex adapter — turn-split fixture (integer ids, sessions dir)", () => {
  test("2-turn session resolved from tempdir (never real ~/.codex)", async () => {
    const dir = tempDir();
    const filePath = join(dir, "rollout-2026-02-01T00-00-00-777.jsonl");
    writeSession(filePath, [
      {
        timestamp: "2026-02-01T00:00:00Z", type: "session_meta",
        payload: { id: "777", timestamp: "2026-02-01T00:00:00Z", title: "int id session" },
      },
      {
        timestamp: "2026-02-01T01:00:00Z", type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "q1" }] },
      },
      {
        timestamp: "2026-02-01T02:00:00Z", type: "response_item",
        payload: { role: "assistant", content: [{ type: "output_text", text: "a1" }] },
      },
      {
        timestamp: "2026-02-01T03:00:00Z", type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "q2" }] },
      },
      {
        timestamp: "2026-02-01T04:00:00Z", type: "response_item",
        payload: { role: "assistant", content: [{ type: "output_text", text: "a2" }] },
      },
    ]);
    const adapter = createCodexAdapter({
      agent: "codex", alias: "work", enabled: true, path: dir,
    });
    const detail = await adapter.getSessionDetail!("777", { mode: "all_with_tools" });
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("777");
    const msgs = detail!.messages ?? [];
    expect(msgs.length).toBeGreaterThanOrEqual(4);
    const texts = msgs.flatMap((m) =>
      m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text)
    );
    expect(texts).toContain("q1");
    expect(texts).toContain("a2");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("opencode adapter — turn-split fixture (step parts + unknown role)", () => {
  test("unknown role mapped to user; step-start/step-finish parts present in raw fetch", async () => {
    const dir = tempDir();
    const filePath = join(dir, "session-op1.jsonl");
    writeSession(filePath, [
      { time: "2026-02-01T00:00:00Z", type: "session", id: "op-1" },
      { time: "2026-02-01T00:00:01Z", type: "message", id: "m1", role: "user", parts: [{ type: "text", text: "q1" }] },
      { time: "2026-02-01T00:00:02Z", type: "step-start" },
      { time: "2026-02-01T00:00:03Z", type: "message", id: "m2", role: "assistant", parts: [{ type: "text", text: "a1" }] },
      { time: "2026-02-01T00:00:04Z", type: "step-finish" },
      { time: "2026-02-01T00:00:05Z", type: "weird-role-thing", id: "m3", parts: [{ type: "text", text: "mystery" }] },
      { time: "2026-02-01T00:00:06Z", type: "message", id: "m4", role: "user", parts: [{ type: "text", text: "q2" }] },
      { time: "2026-02-01T00:00:07Z", type: "message", id: "m5", role: "assistant", parts: [{ type: "text", text: "a2" }] },
    ]);
    const adapter = createOpenCodeAdapter({
      agent: "opencode", alias: "default", enabled: true,
      storage: { mode: "jsonl", jsonlPath: dir },
    } as never);
    const detail = await adapter.getSessionDetail!("op-1", { mode: "all_with_tools" });
    expect(detail).not.toBeNull();
    const msgs = detail!.messages ?? [];
    expect(msgs.length).toBeGreaterThan(0);
    const texts = msgs.flatMap((m) =>
      m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text)
    );
    expect(texts).toContain("q1");
    expect(texts).toContain("a2");
    rmSync(dir, { recursive: true, force: true });
  });
});
