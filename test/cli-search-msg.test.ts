/**
 * test/cli-search-msg.test.ts
 *
 * Comprehensive RED test suite for Milestone 6 (CLI Surface, Formatting & Short IDs: Tasks 23–27):
 * - Task 23 (cli-search-msg-output): Message-level search hits (timestamp, [agent/alias], 7-char shortId, #turn_index, snippet).
 * - Task 24 (cli-context-flag): --context <N> and -C <N> displaying before/after turns with visual delimiters (│ vs ▶).
 * - Task 25 (cli-short-id-support): 7-char short session ID truncation and --session <shortId> filtering via msg_pointers.
 * - Task 26 (cli-sync-flag): Auto-sync / --sync running syncAllSessions, and --no-sync skipping synchronization.
 * - Task 27 (cli-highlighting): ANSI escape styling on matched terms, honoring NO_COLOR=1 and --no-color, UTF-8/JSON integrity.
 * - Adversarial & Edge Cases: Empty/whitespace query, special character escaping, extreme context windows, flag collisions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Database } from "bun:sqlite";

import { runSearchCommand, type SearchOptions } from "../src/cli/search";
import { initSearchSchema, openSearchDb, closeSearchDb } from "../src/search/db";
import { syncSessionFile, syncAllSessions, type SyncFileInput } from "../src/search/sync";
import type { Config } from "../src/config/types";

// ============================================================================
// CLI Helper for End-to-End Invocations
// ============================================================================

interface CliExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {}
): Promise<CliExecutionResult> {
  return new Promise((resolve) => {
    const cliPath = join(__dirname, "..", "bin", "oas");
    const proc = spawn("bun", [cliPath, ...args], {
      cwd: options.cwd ?? join(__dirname, ".."),
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve({ exitCode: 1, stdout, stderr: stderr + "\n[timeout after " + (options.timeoutMs ?? 5000) + "ms]" });
      }
    }, options.timeoutMs ?? 5000);

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? 0, stdout, stderr });
      }
    });
    proc.on("error", (e) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ exitCode: 1, stdout, stderr: e.message });
      }
    });
  });
}

// ============================================================================
// Test Suite Setup & Fixtures
// ============================================================================

describe("Milestone 6: CLI Surface, Formatting & Short IDs (Tasks 23–27)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let sessionsDir: string;
  let configPath: string;
  let testConfig: Config;

  const session1Id = "01a05958-382a-4318-8f81-5421d0199e1a";
  const session1ShortId = "01a0595";
  const session2Id = "7f9b1c2d-9481-4231-901a-83b271a06412";
  const session2ShortId = "7f9b1c2";
  const sessionUnicodeId = "3c4d5e6f-1234-5678-9abc-def012345678";
  const sessionUnicodeShortId = "3c4d5e6";

  let session1File: string;
  let session2File: string;
  let sessionUnicodeFile: string;

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `oas-cli-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tempDir, { recursive: true });

    dbPath = join(tempDir, "oas", "search.sqlite");
    mkdirSync(join(tempDir, "oas"), { recursive: true });
    db = openSearchDb({ dbPath });
    initSearchSchema(db);

    sessionsDir = join(tempDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    // Session 1: opencode / personal (5 turns: #0 user, #1 assistant, #2 toolCall, #3 user, #4 assistant)
    session1File = join(sessionsDir, "session-1.jsonl");
    const session1Turns = [
      { role: 1, timestamp: 1704067200000, content: "How do I deploy the production database migration?" },
      { role: 2, timestamp: 1704067210000, content: "You should run prisma migrate deploy in the server console." },
      { role: 2, timestamp: 1704067220000, toolCall: { name: "bash", arguments: { command: "prisma migrate deploy" } } },
      { role: 1, timestamp: 1704067260000, content: "The database migration completed successfully. What next?" },
      { role: 2, timestamp: 1704067270000, content: "Now verify the health endpoint and restart the api service." },
    ];
    writeFileSync(session1File, session1Turns.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

    // Session 2: claude / work (3 turns: #0 user, #1 assistant, #2 toolCall)
    session2File = join(sessionsDir, "session-2.jsonl");
    const session2Turns = [
      { role: 1, timestamp: 1704153600000, content: "Please configure the nginx reverse proxy for authentication." },
      { role: 2, timestamp: 1704153610000, content: "I will configure the reverse proxy and deploy the auth server configuration." },
      { role: 2, timestamp: 1704153620000, toolCall: { name: "edit", arguments: { path: "/etc/nginx/sites-available/auth.conf" } } },
    ];
    writeFileSync(session2File, session2Turns.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

    // Session 3: pi / default (Unicode + emoji)
    sessionUnicodeFile = join(sessionsDir, "session-unicode.jsonl");
    const sessionUnicodeTurns = [
      { role: 1, timestamp: 1704240000000, content: "Kiểm tra hệ thống deploy 🚀 và xác thực bảo mật" },
      { role: 2, timestamp: 1704240010000, content: "Hệ thống deploy 🚀 đã khởi động thành công!" },
    ];
    writeFileSync(sessionUnicodeFile, sessionUnicodeTurns.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

    // Sync initial session files into SQLite search index
    await syncSessionFile(db, { path: session1File, agent: "opencode", alias: "personal", sessionId: session1Id });
    await syncSessionFile(db, { path: session2File, agent: "claude", alias: "work", sessionId: session2Id });
    await syncSessionFile(db, { path: sessionUnicodeFile, agent: "pi", alias: "default", sessionId: sessionUnicodeId });

    // Config file setup
    testConfig = {
      agents: [
        { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
        { agent: "claude", alias: "work", enabled: true, storage: { mode: "auto" } },
        { agent: "pi", alias: "default", enabled: true, storage: { mode: "auto" } },
      ],
    };

    const configDir = join(tempDir, ".config", "oas");
    mkdirSync(configDir, { recursive: true });
    configPath = join(configDir, "config.yaml");
    const yamlContent = `
agents:
  - agent: opencode
    alias: personal
    enabled: true
  - agent: claude
    alias: work
    enabled: true
  - agent: pi
    alias: default
    enabled: true
`;
    writeFileSync(configPath, yamlContent, "utf8");
  });

  afterEach(() => {
    closeSearchDb(db);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // Task 23: Message-Level Search Output (cli-search-msg-output)
  // ==========================================================================
  describe("Task 23: Message-Level Search Output (cli-search-msg-output)", () => {
    test("when searching with --text, formats individual message-level matches rather than session headers", async () => {
      const result = await runSearchCommand({
        text: "deploy",
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);

      // Must display formatted timestamp (date or time)
      expect(result.stdout).toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/);

      // Must display [<agent>/<alias>] or [<agent>:<alias>] identifier
      expect(result.stdout).toMatch(/\[opencode[\/: ]personal\]/);

      // Must display 7-character short session ID
      expect(result.stdout).toContain(session1ShortId);

      // Must display #<turn_index>
      expect(result.stdout).toMatch(/#\d+/);

      // Must display turn text snippet
      expect(result.stdout.toLowerCase()).toContain("deploy");
    });

    test("formats multiple matching turns within the same session as distinct message entries", async () => {
      // Session 1 has 'deploy' in turn #0 (user), turn #1 (assistant), and turn #2 (bash toolCall)
      const result = await runSearchCommand({
        text: "deploy",
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);

      // Should have entries for turn 0, turn 1, and turn 2
      expect(result.stdout).toContain("#0");
      expect(result.stdout).toContain("#1");
      expect(result.stdout).toContain("#2");

      // Verify that snippets contain turn-specific text
      expect(result.stdout).toContain("How do I deploy");
      expect(result.stdout).toContain("prisma migrate deploy");
    });

    test("displays distinct [agent/alias] identifiers for hits across different agents", async () => {
      const result = await runSearchCommand({
        text: "deploy",
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);

      // Opencode session match
      expect(result.stdout).toMatch(/\[opencode[\/: ]personal\]/);
      expect(result.stdout).toContain(session1ShortId);

      // Claude session match
      expect(result.stdout).toMatch(/\[claude[\/: ]work\]/);
      expect(result.stdout).toContain(session2ShortId);
    });

    test("returns zero exitCode and clean 'No matches found' message when query has no hits", async () => {
      const result = await runSearchCommand({
        text: "nonexistent_term_zyx987_xyz",
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toMatch(/no (messages|sessions|matches) found/);
    });

    test("supports --format json returning structured message-level hit objects", async () => {
      const result = await runSearchCommand({
        text: "deploy",
        format: "json",
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);

      const firstHit = parsed[0];
      // Message-level fields in JSON hit
      expect(firstHit).toHaveProperty("sessionId");
      expect(firstHit).toHaveProperty("shortId");
      expect(firstHit.shortId).toHaveLength(7);
      expect(firstHit).toHaveProperty("turnIndex");
      expect(firstHit).toHaveProperty("agent");
      expect(firstHit).toHaveProperty("alias");
      expect(firstHit).toHaveProperty("snippet");
      expect(firstHit).toHaveProperty("timestamp");
    });
  });

  // ==========================================================================
  // Task 24: Context Flag Support (cli-context-flag)
  // ==========================================================================
  describe("Task 24: Context Flag Support (cli-context-flag)", () => {
    test("outputs up to N context turns before and after hit with visual delimiters", async () => {
      // Turn #2 in session 1 matches 'bash' toolCall
      const result = await runSearchCommand({
        text: "bash",
        context: 2,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);

      // Distinct visual delimiters for hit turn vs context turns
      // Hit turn uses ▶ delimiter (or ▶ [hit])
      expect(result.stdout).toMatch(/▶/);

      // Context turns use │ delimiter (or │ [context])
      expect(result.stdout).toMatch(/│/);

      // Before context should show turn #0 and turn #1
      expect(result.stdout).toContain("#0");
      expect(result.stdout).toContain("#1");

      // Hit turn #2
      expect(result.stdout).toContain("#2");

      // After context should show turn #3 and turn #4
      expect(result.stdout).toContain("#3");
      expect(result.stdout).toContain("#4");
    });

    test("shorthand -C flag works identically to --context", async () => {
      // Test programmatic invocation supporting contextN alias
      const result = await runSearchCommand({
        text: "bash",
        contextN: 2,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/▶/);
      expect(result.stdout).toMatch(/│/);
      expect(result.stdout).toContain("#1");
      expect(result.stdout).toContain("#3");
    });

    test("handles boundary turn #0 (start of session) with zero prior context turns", async () => {
      // Turn #0 matches 'How do I deploy'
      const result = await runSearchCommand({
        text: "How do I deploy",
        context: 2,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("#0");
      // Does not invent turn #-1 or negative turn indices
      expect(result.stdout).not.toMatch(/#-\d+/);
      // After context should show turn #1 and turn #2
      expect(result.stdout).toContain("#1");
    });

    test("handles boundary last turn (end of session) with zero subsequent context turns", async () => {
      // Turn #4 matches 'health endpoint'
      const result = await runSearchCommand({
        text: "health endpoint",
        context: 2,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("#4");
      // Does not invent turn #5 or subsequent non-existent turns
      expect(result.stdout).not.toContain("#5");
      // Before context should show turn #2 and turn #3
      expect(result.stdout).toContain("#3");
    });

    test("omits context delimiters when context is 0 or omitted", async () => {
      const result = await runSearchCommand({
        text: "bash",
        context: 0,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("#2");
      // Context turn indicator │ should not be displayed when context=0
      expect(result.stdout).not.toContain("│ [context]");
    });

    test("--format json with --context includes contextBefore and contextAfter arrays", async () => {
      const result = await runSearchCommand({
        text: "bash",
        context: 2,
        format: "json",
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);

      const hit = parsed[0];
      expect(hit.turnIndex).toBe(2);
      expect(Array.isArray(hit.contextBefore)).toBe(true);
      expect(hit.contextBefore.length).toBe(2);
      expect(Array.isArray(hit.contextAfter)).toBe(true);
      expect(hit.contextAfter.length).toBe(2);
    });
  });

  // ==========================================================================
  // Task 25: Short Session ID Support & Filter (cli-short-id-support)
  // ==========================================================================
  describe("Task 25: Short Session ID Support & Filter (cli-short-id-support)", () => {
    test("short session IDs are consistently truncated to exactly 7 characters", async () => {
      const result = await runSearchCommand({
        text: "deploy",
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      // Should show 7-character prefix 01a0595 for session 1
      expect(result.stdout).toContain(session1ShortId);
      // Should show 7-character prefix 7f9b1c2 for session 2
      expect(result.stdout).toContain(session2ShortId);

      // In line-by-line format, check that short ID token has length 7
      const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
      const shortIdMatches = result.stdout.match(/\b[0-9a-f]{7}\b/g);
      expect(shortIdMatches).not.toBeNull();
      expect(shortIdMatches!.length).toBeGreaterThan(0);
    });

    test("filters search hits unambiguously when --session <shortId> is provided", async () => {
      // Both session 1 and session 2 contain 'deploy'
      // Filtering by session 1 short ID must return ONLY session 1 hits
      const result = await runSearchCommand({
        text: "deploy",
        session: session1ShortId,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(session1ShortId);
      // Session 2 must NOT appear in output
      expect(result.stdout).not.toContain(session2ShortId);
      expect(result.stdout).not.toContain("nginx");
    });

    test("filters search hits when full UUID session ID is provided", async () => {
      const result = await runSearchCommand({
        text: "deploy",
        session: session2Id,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(session2ShortId);
      expect(result.stdout).not.toContain(session1ShortId);
    });

    test("returns zero hits when --session does not match any indexed session", async () => {
      const result = await runSearchCommand({
        text: "deploy",
        session: "0000000",
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toMatch(/no (messages|sessions|matches) found/);
    });

    test("resolves hyphenated session slugs without CLI flag collisions", async () => {
      // Indexed slug starting with hyphens or containing dashes
      const hyphenSessionFile = join(sessionsDir, "session-hyphen.jsonl");
      const hyphenId = "codex-deploy-auth-99";
      const turns = [
        { role: 1, timestamp: 1704326400000, content: "Deploy staging container cluster" },
      ];
      writeFileSync(hyphenSessionFile, turns.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");
      await syncSessionFile(db, { path: hyphenSessionFile, agent: "codex", alias: "work", sessionId: hyphenId });

      const result = await runSearchCommand({
        text: "staging",
        session: "codex-d",
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("staging container cluster");
    });
  });

  // ==========================================================================
  // Task 26: Sync Flag Support (cli-sync-flag)
  // ==========================================================================
  describe("Task 26: Sync Flag Support (cli-sync-flag)", () => {
    test("automatically syncs newly created session files before querying when --sync is active", async () => {
      // Add new session file on disk after initial sync
      const newSessionFile = join(sessionsDir, "session-new.jsonl");
      const newSessionId = "4d5e6f7a-8b9c-0d1e-2f3a-4b5c6d7e8f9a";
      const newSessionTurns = [
        { role: 1, timestamp: 1704412800000, content: "Kubernetes helm chart deploy ingress controller" },
      ];
      writeFileSync(newSessionFile, newSessionTurns.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

      // Searching with sync: true must index the new file and return the hit
      const result = await runSearchCommand({
        text: "Kubernetes",
        sync: true,
        db,
        dbPath,
        config: testConfig,
        sessionFiles: [
          { path: newSessionFile, agent: "opencode", alias: "personal", sessionId: newSessionId },
        ],
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Kubernetes");
      expect(result.stdout).toContain("helm chart");
    });

    test("--no-sync skips synchronization and searches current index directly", async () => {
      // Add another session file on disk
      const unsyncedSessionFile = join(sessionsDir, "session-unsynced.jsonl");
      const unsyncedId = "9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d";
      const unsyncedTurns = [
        { role: 1, timestamp: 1704499200000, content: "Terraform infrastructure provisioning automation" },
      ];
      writeFileSync(unsyncedSessionFile, unsyncedTurns.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

      // Searching with noSync: true skips updating watermarks
      const result = await runSearchCommand({
        text: "Terraform",
        noSync: true,
        db,
        dbPath,
        config: testConfig,
        sessionFiles: [
          { path: unsyncedSessionFile, agent: "opencode", alias: "personal", sessionId: unsyncedId },
        ],
      } as any);

      expect(result.exitCode).toBe(0);
      // Since sync was skipped, "Terraform" is not indexed in SQLite and must not be found
      expect(result.stdout.toLowerCase()).toMatch(/no (messages|sessions|matches) found/);
    });

    test("--sync incrementally indexes newly appended turns in existing files", async () => {
      // Append a turn to session 1
      const appendTurn = { role: 1, timestamp: 1704067300000, content: "Docker compose microservice architecture" };
      writeFileSync(session1File, JSON.stringify(appendTurn) + "\n", { flag: "a" });

      const result = await runSearchCommand({
        text: "microservice",
        sync: true,
        db,
        dbPath,
        config: testConfig,
        sessionFiles: [
          { path: session1File, agent: "opencode", alias: "personal", sessionId: session1Id },
        ],
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("microservice");
      expect(result.stdout).toContain(session1ShortId);
    });
  });

  // ==========================================================================
  // Task 27: Terminal Highlighting & Color Control (cli-highlighting)
  // ==========================================================================
  describe("Task 27: Terminal Highlighting & Color Control (cli-highlighting)", () => {
    test("highlights matched query terms using ANSI escape styling when color is enabled", async () => {
      const result = await runSearchCommand({
        text: "deploy",
        noColor: false,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);

      // ANSI escape sequence \x1b[...m must wrap or precede the matched term
      const hasAnsiCodes = /\x1b\[[0-9;]*m/.test(result.stdout);
      expect(hasAnsiCodes).toBe(true);

      // Check specifically that the matched word is styled
      expect(result.stdout).toMatch(/\x1b\[[0-9;]*mdeploy\x1b\[[0-9;]*m/i);
    });

    test("honors NO_COLOR=1 environment variable by omitting all ANSI escape codes", async () => {
      const origEnv = process.env.NO_COLOR;
      try {
        process.env.NO_COLOR = "1";
        const result = await runSearchCommand({
          text: "deploy",
          db,
          dbPath,
          config: testConfig,
        } as any);

        expect(result.exitCode).toBe(0);
        // Must still contain the word 'deploy'
        expect(result.stdout.toLowerCase()).toContain("deploy");
        // Must NOT contain any ANSI escape sequences
        expect(result.stdout).not.toMatch(/\x1b\[[0-9;]*m/);
      } finally {
        if (origEnv === undefined) {
          delete process.env.NO_COLOR;
        } else {
          process.env.NO_COLOR = origEnv;
        }
      }
    });

    test("honors --no-color flag by omitting all ANSI escape codes", async () => {
      const result = await runSearchCommand({
        text: "deploy",
        noColor: true,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain("deploy");
      expect(result.stdout).not.toMatch(/\x1b\[[0-9;]*m/);
    });

    test("preserves multi-byte UTF-8 text and emojis without byte distortion during highlighting", async () => {
      const result = await runSearchCommand({
        text: "deploy",
        noColor: false,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      // Vietnamese text and rocket emoji must be preserved intact
      expect(result.stdout).toContain("Kiểm tra hệ thống");
      expect(result.stdout).toContain("🚀");
      expect(result.stdout).toContain(sessionUnicodeShortId);
    });

    test("--format json outputs valid JSON without injecting raw ANSI escape codes into keys", async () => {
      const result = await runSearchCommand({
        text: "deploy",
        format: "json",
        noColor: false,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      // Must be completely parseable JSON
      let parsed: any;
      expect(() => {
        parsed = JSON.parse(result.stdout);
      }).not.toThrow();
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Adversarial & Boundary Hardening
  // ==========================================================================
  describe("Adversarial & Boundary Hardening", () => {
    test("rejects empty or whitespace query with exitCode 1 and stderr message", async () => {
      const result = await runSearchCommand({
        text: "   ",
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing required argument: --text");
    });

    test("safely executes queries containing quotes, colons, and special punctuation", async () => {
      const result = await runSearchCommand({
        text: 'prisma "migrate" deploy: (v1.0)',
        db,
        dbPath,
        config: testConfig,
      } as any);

      // Must execute cleanly without SQLite syntax error or crash
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("syntax error");
    });

    test("handles extreme context window (--context 100) gracefully without crashing", async () => {
      const result = await runSearchCommand({
        text: "bash",
        context: 100,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      // Returns all 5 turns in session 1
      expect(result.stdout).toContain("#0");
      expect(result.stdout).toContain("#4");
    });

    test("handles negative or non-integer context value safely", async () => {
      const result = await runSearchCommand({
        text: "bash",
        context: -1,
        db,
        dbPath,
        config: testConfig,
      } as any);

      expect(result.exitCode).toBe(0);
      // Should treat as 0 or not crash
      expect(result.stdout).toContain("#2");
    });
  });

  // ==========================================================================
  // End-to-End CLI Binary Verification (bin/oas)
  // ==========================================================================
  describe("End-to-End CLI Binary Verification (bin/oas)", () => {
    test("`oas search --text deploy` displays message matches with shortId and turn index", async () => {
      const cliResult = await runCli(["search", "--text", "deploy"], {
        env: {
          XDG_CACHE_HOME: tempDir,
          HOME: tempDir,
        },
      });

      expect(cliResult.exitCode).toBe(0);
      expect(cliResult.stdout).toContain(session1ShortId);
      expect(cliResult.stdout).toMatch(/#\d+/);
      expect(cliResult.stdout.toLowerCase()).toContain("deploy");
    });

    test("`oas search --text bash -C 2` displays context window with visual delimiters", async () => {
      const cliResult = await runCli(["search", "--text", "bash", "-C", "2"], {
        env: {
          XDG_CACHE_HOME: tempDir,
          HOME: tempDir,
        },
      });

      expect(cliResult.exitCode).toBe(0);
      expect(cliResult.stdout).toMatch(/▶/);
      expect(cliResult.stdout).toMatch(/│/);
      expect(cliResult.stdout).toContain("#1");
      expect(cliResult.stdout).toContain("#2");
      expect(cliResult.stdout).toContain("#3");
    });

    test("`oas search --text deploy --session <shortId>` filters by short session ID", async () => {
      const cliResult = await runCli(["search", "--text", "deploy", "--session", session1ShortId], {
        env: {
          XDG_CACHE_HOME: tempDir,
          HOME: tempDir,
        },
      });

      expect(cliResult.exitCode).toBe(0);
      expect(cliResult.stdout).toContain(session1ShortId);
      expect(cliResult.stdout).not.toContain(session2ShortId);
    });

    test("`oas search --text deploy --no-color` suppresses ANSI escape codes", async () => {
      const cliResult = await runCli(["search", "--text", "deploy", "--no-color"], {
        env: {
          XDG_CACHE_HOME: tempDir,
          HOME: tempDir,
        },
      });

      expect(cliResult.exitCode).toBe(0);
      expect(cliResult.stdout).not.toMatch(/\x1b\[[0-9;]*m/);
      expect(cliResult.stdout.toLowerCase()).toContain("deploy");
    });
  });
});
