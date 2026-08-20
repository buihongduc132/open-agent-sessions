/**
 * Grok integration tests — prove grok is wired through createAdapterRegistry
 * + normalizeSessionSummary, NOT just the unit layer.
 *
 * The unit tests in test/adapters/grok.test.ts call the adapter directly,
 * bypassing createAdapterRegistry + normalizeSessionSummary. That is how an
 * adapter can look "green" while `oas sessions --agent grok` throws
 * "adapter factory not found" / "agent must be one of ...". These tests build
 * the registry the way `bin/oas` does and assert the full CLI path works.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterRegistry, createGrokAdapter } from "../src/index";
import type { Config } from "../src/index";

const ENCODED_CWD = encodeURIComponent("/home/proj");
const PARENT_ID = "0198f000-0000-7000-8000-0000000000aa";
const CHILD_ID = "01a01eee-e88c-7382-a502-ef19db9f1ee2";

type GrokEntry = { agent: "grok"; alias: string; enabled: boolean; path?: string };

function seedGrokSession(
  root: string,
  opts: {
    encodedCwd: string;
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    parentSessionId?: string;
    chatLines?: unknown[];
  }
): void {
  const dir = join(root, opts.encodedCwd, opts.id);
  mkdirSync(dir, { recursive: true });
  const chatLines = opts.chatLines ?? [];
  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify({
      info: { id: opts.id, cwd: "/home/proj" },
      session_summary: opts.title,
      created_at: opts.createdAt,
      updated_at: opts.updatedAt,
      num_messages: chatLines.length,
      num_chat_messages: chatLines.length,
      current_model_id: "grok-4.6",
      generated_title: opts.title,
      ...(opts.parentSessionId ? { parent_session_id: opts.parentSessionId } : {}),
    })
  );
  const payload = chatLines.map((line) => JSON.stringify(line)).join("\n");
  writeFileSync(join(dir, "chat_history.jsonl"), payload ? `${payload}\n` : "");
}

describe("grok adapter — registry/normalize integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "oas-grok-registry-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does NOT throw 'agent must be one of' when listing via the registry", async () => {
    seedGrokSession(tmpDir, {
      encodedCwd: ENCODED_CWD,
      id: CHILD_ID,
      title: "Child grok session",
      createdAt: "2026-08-20T11:29:28.000Z",
      updatedAt: "2026-08-20T11:40:52.000Z",
      parentSessionId: PARENT_ID,
      chatLines: [
        {
          type: "user",
          content: [{ type: "text", text: "hello from registry grok fixture" }],
        },
      ],
    });

    const config: Config = {
      agents: [{ agent: "grok", alias: "default", enabled: true }],
    };
    const registry = createAdapterRegistry(config, {
      grok: (entry) => createGrokAdapter(entry as GrokEntry, { sessionsDir: tmpDir }),
    });

    const sessions = await registry.adapters[0].listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].agent).toBe("grok");
    expect(sessions[0].alias).toBe("default");
    expect(sessions[0].parentSessionId).toBe(PARENT_ID);
  });
});
