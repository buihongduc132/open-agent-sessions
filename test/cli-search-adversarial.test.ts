/**
 * test/cli-search-adversarial.test.ts
 *
 * Adversarial stress test suite for Milestone 6 CLI formatting and argument handling (Tasks 23–27).
 *
 * Covers:
 * 1. Hostile CLI arguments:
 *    - Non-numeric context: -C abc, -C NaN, -C -10, --context abc, --context NaN, --context -10
 *    - Huge context: -C 5000, --context 5000
 *    - Wildcard & regex-heavy queries under ANSI highlighting: (foo|bar).*, ***, [test], etc.
 *    - Special characters & SQL injection attempts in short session IDs: "01a0595' OR 1=1", etc.
 * 2. Color suppression:
 *    - NO_COLOR=1, NO_COLOR=true, --no-color flag -> EXACTLY 0 ANSI escape sequences.
 * 3. Text preservation:
 *    - Multi-byte UTF-8, Japanese text, astral plane emojis, ZWJ sequences under highlighting and context.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Database } from "bun:sqlite";

import { runSearchCommand } from "../src/cli/search";
import { initSearchSchema, openSearchDb, closeSearchDb } from "../src/search/db";
import { syncSessionFile } from "../src/search/sync";
import type { Config } from "../src/config/types";

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
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + "\n[timeout after " + (options.timeoutMs ?? 5000) + "ms]",
        });
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

// ANSI escape sequence matcher: ESC [ ... [a-zA-Z]
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

describe("Adversarial Stress Testing: M6 CLI Formatting & Argument Handling", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let sessionsDir: string;
  let testConfig: Config;

  const session1Id = "01a05958-382a-4318-8f81-5421d0199e1a";
  const session1ShortId = "01a0595";
  const japaneseSessionId = "8b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e";
  const emojiSessionId = "e1a2b3c4-d5e6-7f8a-9b0c-1d2e3f4a5b6c";

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `oas-adv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tempDir, { recursive: true });

    dbPath = join(tempDir, "oas", "search.sqlite");
    mkdirSync(join(tempDir, "oas"), { recursive: true });
    db = openSearchDb({ dbPath });
    initSearchSchema(db);

    sessionsDir = join(tempDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    // Standard session with technical text
    const session1File = join(sessionsDir, "session-standard.jsonl");
    const session1Turns = [
      { role: 1, timestamp: 1704067200000, content: "Starting cluster deploy process with kubernetes" },
      { role: 2, timestamp: 1704067210000, content: "Cluster deploy configuration initialized. Running helm upgrade." },
      { role: 2, timestamp: 1704067220000, toolCall: { name: "bash", arguments: { command: "helm upgrade --install oas ./chart" } } },
      { role: 1, timestamp: 1704067230000, content: "The cluster deploy finished successfully." },
      { role: 2, timestamp: 1704067240000, content: "Deploy verified and pods are healthy." },
    ];
    writeFileSync(session1File, session1Turns.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

    // Japanese session (with space-tokenized terms and continuous conversational turns)
    const japaneseFile = join(sessionsDir, "session-japanese.jsonl");
    const japaneseTurns = [
      { role: 1, timestamp: 1704153600000, content: "こんにちは、 日本語 のテストセッションを開始します。" },
      { role: 2, timestamp: 1704153610000, content: "データベースの接続確認と検索インデックスの同期を行います。" },
      { role: 2, timestamp: 1704153620000, toolCall: { name: "test_tool", arguments: { target: "本番サーバーの更新" } } },
      { role: 1, timestamp: 1704153630000, content: "日本語 の検索クエリで正しくヒットするか検証してください。" },
      { role: 2, timestamp: 1704153640000, content: "検証完了：文字化けや境界線の崩れはありません。" },
    ];
    writeFileSync(japaneseFile, japaneseTurns.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

    // Astral plane emojis, ZWJ sequences, and Vietnamese text
    const emojiFile = join(sessionsDir, "session-emoji.jsonl");
    const emojiTurns = [
      { role: 1, timestamp: 1704240000000, content: "Astral plane test: 🧑‍💻 astronaut 🧑‍🚀 and rockets 🚀🛰️🛸 with Vietnamese: Kiểm tra hệ thống" },
      { role: 2, timestamp: 1704240010000, content: "Deep space mission 🌟💫 and emojis ⚡🎯 deployed: Hệ thống hoạt động bình thường!" },
      { role: 2, timestamp: 1704240020000, toolCall: { name: "galaxy_exec", arguments: { flag: "🪐", msg: "Bảo mật tuyệt đối 🔒" } } },
    ];
    writeFileSync(emojiFile, emojiTurns.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

    // Sync all sessions
    await syncSessionFile(db, { path: session1File, agent: "opencode", alias: "personal", sessionId: session1Id });
    await syncSessionFile(db, { path: japaneseFile, agent: "claude", alias: "work", sessionId: japaneseSessionId });
    await syncSessionFile(db, { path: emojiFile, agent: "pi", alias: "default", sessionId: emojiSessionId });

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
    const configPath = join(configDir, "config.yaml");
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
  // Section 1: Hostile CLI Arguments
  // ==========================================================================
  describe("Hostile CLI Arguments", () => {
    describe("Non-numeric and negative context flags (-C abc, -C NaN, -C -10)", () => {
      test("handles -C abc via programmatic API without crashing or throwing", async () => {
        const result = await runSearchCommand({
          text: "deploy",
          context: "abc" as any,
          db,
          config: testConfig,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(session1ShortId);
        // Non-numeric context must not include context delimiters
        expect(result.stdout).not.toContain("│ [context]");
      });

      test("handles -C NaN via programmatic API safely", async () => {
        const result = await runSearchCommand({
          text: "deploy",
          context: NaN,
          db,
          config: testConfig,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(session1ShortId);
        expect(result.stdout).not.toContain("│ [context]");
      });

      test("handles -C -10 via programmatic API safely (clamped to 0)", async () => {
        const result = await runSearchCommand({
          text: "deploy",
          context: -10,
          db,
          config: testConfig,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(session1ShortId);
        expect(result.stdout).not.toContain("│ [context]");
      });

      test("handles CLI binary with -C abc", async () => {
        const res = await runCli(["search", "--text", "deploy", "-C", "abc"], {
          env: { XDG_CACHE_HOME: tempDir, HOME: tempDir },
        });

        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain(session1ShortId);
        expect(res.stdout).not.toContain("│ [context]");
      });

      test("handles CLI binary with -C NaN", async () => {
        const res = await runCli(["search", "--text", "deploy", "-C", "NaN"], {
          env: { XDG_CACHE_HOME: tempDir, HOME: tempDir },
        });

        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain(session1ShortId);
        expect(res.stdout).not.toContain("│ [context]");
      });

      test("handles CLI binary with -C -10 and --context -10 safely", async () => {
        const res1 = await runCli(["search", "--text", "deploy", "-C-10"], {
          env: { XDG_CACHE_HOME: tempDir, HOME: tempDir },
        });
        expect(res1.exitCode).toBe(0);
        expect(res1.stdout).toContain(session1ShortId);

        const res2 = await runCli(["search", "--text", "deploy", "--context", "-10"], {
          env: { XDG_CACHE_HOME: tempDir, HOME: tempDir },
        });
        expect(res2.exitCode).toBe(0);
        expect(res2.stdout).toContain(session1ShortId);
      });
    });

    describe("Huge context flag (-C 5000)", () => {
      test("handles huge context window (-C 5000) via programmatic API without crashing", async () => {
        const start = performance.now();
        const result = await runSearchCommand({
          text: "helm",
          context: 5000,
          db,
          config: testConfig,
        });
        const elapsed = performance.now() - start;

        expect(result.exitCode).toBe(0);
        expect(elapsed).toBeLessThan(1000); // Must complete quickly
        expect(result.stdout).toContain("▶ [hit]");
        expect(result.stdout).toContain("│ [context]");
        // All turns in the session should be present
        expect(result.stdout).toContain("#0");
        expect(result.stdout).toContain("#4");
      });

      test("handles huge context window (-C 5000) via CLI binary", async () => {
        const res = await runCli(["search", "--text", "helm", "-C", "5000"], {
          env: { XDG_CACHE_HOME: tempDir, HOME: tempDir },
        });

        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("▶ [hit]");
        expect(res.stdout).toContain("│ [context]");
        expect(res.stdout).toContain("#0");
        expect(res.stdout).toContain("#4");
      });
    });

    describe("Wildcard or regex-heavy queries under ANSI highlighting", () => {
      const hostileQueries = [
        "(foo|bar).*",
        "***",
        "*****",
        "[test]",
        "\\b[a-z0-9_]+\\b",
        "+?^${}()|[]\\",
        "((((((nested))))))",
        ".*.*.*.*.*.*",
        "/.*(a+)+$/",
        '"quoted term with * and : punctuation"',
        "NEAR(a, b, 10)",
        "AND OR NOT",
      ];

      for (const query of hostileQueries) {
        test(`safely processes hostile query "${query}" without highlighter regex crash or ReDoS`, async () => {
          // Both with color enabled (triggering highlightMatches) and disabled
          const start = performance.now();
          const resultWithColor = await runSearchCommand({
            text: query,
            noColor: false,
            db,
            config: testConfig,
          });
          const elapsed = performance.now() - start;

          expect(resultWithColor.exitCode).toBe(0);
          expect(elapsed).toBeLessThan(1000); // ReDoS defense check
          expect(resultWithColor.stderr).not.toContain("SyntaxError");

          // CLI binary execution
          const cliRes = await runCli(["search", "--text", query], {
            env: { XDG_CACHE_HOME: tempDir, HOME: tempDir },
          });
          expect(cliRes.exitCode).toBe(0);
          expect(cliRes.stderr).not.toContain("SyntaxError");
        });
      }
    });

    describe("Special characters & SQL injection attempts in short session IDs", () => {
      const hostileSessionIds = [
        "01a0595' OR 1=1",
        "'; DROP TABLE msg_pointers; --",
        "01a0595\" OR \"\"=\"",
        "01a0595' UNION SELECT 1,2,3,4,5,6,7,8,9--",
        "%",
        "_",
        "%%%",
        "---",
        "-C 2",
        "--session",
      ];

      for (const hostileId of hostileSessionIds) {
        test(`safely executes with hostile --session "${hostileId}" without SQL injection or crash`, async () => {
          const result = await runSearchCommand({
            text: "deploy",
            session: hostileId,
            db,
            config: testConfig,
          });

          // Must return exitCode 0, no SQL syntax errors
          expect(result.exitCode).toBe(0);
          expect(result.stderr).not.toContain("syntax error");
          expect(result.stderr).not.toContain("unrecognized token");

          // Verify SQLite tables msg_pointers, msg_fts, file_watermarks are intact
          const countPointers = db.query("SELECT count(*) as count FROM msg_pointers").get() as { count: number };
          expect(countPointers.count).toBeGreaterThan(0);

          const countFts = db.query("SELECT count(*) as count FROM msg_fts").get() as { count: number };
          expect(countFts.count).toBeGreaterThan(0);

          // CLI binary invocation
          const cliRes = await runCli(["search", "--text", "deploy", "--session", hostileId], {
            env: { XDG_CACHE_HOME: tempDir, HOME: tempDir },
          });
          expect(cliRes.exitCode).toBe(0);
          expect(cliRes.stderr).not.toContain("syntax error");
        });
      }

      test("handles embedded null byte in session parameter safely via programmatic API", async () => {
        const result = await runSearchCommand({
          text: "deploy",
          session: "01a0595\x00extra",
          db,
          config: testConfig,
        });
        expect(result.exitCode).toBe(0);
        // Returns no matches found without throwing
        expect(result.stdout.toLowerCase()).toMatch(/no (matches|sessions|messages) found/);
      });
    });
  });

  // ==========================================================================
  // Section 2: Color Suppression
  // ==========================================================================
  describe("Color Suppression (NO_COLOR & --no-color)", () => {
    test("when NO_COLOR=1 is set, exactly 0 ANSI escape sequences exist in output", async () => {
      const origEnv = process.env.NO_COLOR;
      try {
        process.env.NO_COLOR = "1";

        const result = await runSearchCommand({
          text: "cluster",
          noColor: false, // Even if caller attempted noColor: false
          db,
          config: testConfig,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("cluster");

        const matches = result.stdout.match(ANSI_REGEX);
        expect(matches).toBeNull();
        expect(ANSI_REGEX.test(result.stdout)).toBe(false);
      } finally {
        if (origEnv === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = origEnv;
      }
    });

    test("when NO_COLOR=true is set in CLI environment, exactly 0 ANSI escape sequences exist", async () => {
      const cliRes = await runCli(["search", "--text", "cluster"], {
        env: {
          XDG_CACHE_HOME: tempDir,
          HOME: tempDir,
          NO_COLOR: "true",
        },
      });

      expect(cliRes.exitCode).toBe(0);
      expect(cliRes.stdout).toContain("cluster");

      const matches = cliRes.stdout.match(ANSI_REGEX);
      expect(matches).toBeNull();
      expect(ANSI_REGEX.test(cliRes.stdout)).toBe(false);
    });

    test("when --no-color is specified on CLI, exactly 0 ANSI escape sequences exist", async () => {
      const cliRes = await runCli(["search", "--text", "deploy", "--no-color"], {
        env: {
          XDG_CACHE_HOME: tempDir,
          HOME: tempDir,
        },
      });

      expect(cliRes.exitCode).toBe(0);
      expect(cliRes.stdout).toContain("deploy");

      const matches = cliRes.stdout.match(ANSI_REGEX);
      expect(matches).toBeNull();
      expect(ANSI_REGEX.test(cliRes.stdout)).toBe(false);
    });

    test("when context window (-C 2) and --no-color are combined, exactly 0 ANSI escape sequences exist", async () => {
      const cliRes = await runCli(["search", "--text", "helm", "-C", "2", "--no-color"], {
        env: {
          XDG_CACHE_HOME: tempDir,
          HOME: tempDir,
        },
      });

      expect(cliRes.exitCode).toBe(0);
      expect(cliRes.stdout).toContain("▶ [hit]");
      expect(cliRes.stdout).toContain("│ [context]");

      const matches = cliRes.stdout.match(ANSI_REGEX);
      expect(matches).toBeNull();
      expect(ANSI_REGEX.test(cliRes.stdout)).toBe(false);
    });

    test("verify that colorEnabled produces ANSI styling so suppression is demonstrably effective", async () => {
      const coloredResult = await runSearchCommand({
        text: "cluster",
        noColor: false,
        db,
        config: testConfig,
      });

      expect(coloredResult.exitCode).toBe(0);
      const matches = coloredResult.stdout.match(ANSI_REGEX);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(2); // Start code and reset code
    });
  });

  // ==========================================================================
  // Section 3: Text Preservation
  // ==========================================================================
  describe("Text Preservation (Multi-byte UTF-8, Japanese, Astral Plane Emojis)", () => {
    test("preserves Japanese text without character slicing or corruption under highlighting", async () => {
      const result = await runSearchCommand({
        text: "日本語",
        noColor: false,
        db,
        config: testConfig,
      });

      expect(result.exitCode).toBe(0);
      // Ensure Japanese text is preserved
      expect(result.stdout).toContain("日本語");
      expect(result.stdout).toContain("テストセッション");
      // Ensure no Unicode replacement character \uFFFD was generated
      expect(result.stdout).not.toContain("\uFFFD");
      // Check that ANSI styling wrapped the Japanese term
      expect(result.stdout).toMatch(/\x1b\[[0-9;]*m日本語\x1b\[[0-9;]*m/);
    });

    test("preserves Japanese context turns with visual delimiters and no mangling", async () => {
      const result = await runSearchCommand({
        text: "test_tool",
        context: 2,
        noColor: false,
        db,
        config: testConfig,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("▶ [hit]");
      expect(result.stdout).toContain("│ [context]");
      expect(result.stdout).toContain("データベースの接続確認");
      expect(result.stdout).toContain("本番サーバーの更新");
      expect(result.stdout).toContain("文字化けや境界線の崩れはありません");
      expect(result.stdout).not.toContain("\uFFFD");
    });

    test("preserves astral plane emojis (🧑‍💻, 🚀, 🪐) and multi-codepoint sequences without slicing", async () => {
      const result = await runSearchCommand({
        text: "astronaut",
        context: 2,
        noColor: false,
        db,
        config: testConfig,
      });

      expect(result.exitCode).toBe(0);
      // Check complex emojis
      expect(result.stdout).toContain("🧑‍💻");
      expect(result.stdout).toContain("🧑‍🚀");
      expect(result.stdout).toContain("🚀");
      expect(result.stdout).toContain("🛰️");
      expect(result.stdout).toContain("🛸");
      expect(result.stdout).toContain("🪐");
      expect(result.stdout).toContain("🔒");
      // Vietnamese text check
      expect(result.stdout).toContain("Kiểm tra hệ thống");
      expect(result.stdout).toContain("Bảo mật tuyệt đối");
      // Ensure no corrupted replacement chars
      expect(result.stdout).not.toContain("\uFFFD");
    });

    test("preserves astral plane emojis and Vietnamese text when formatted as JSON", async () => {
      const result = await runSearchCommand({
        text: "astronaut",
        context: 2,
        format: "json",
        db,
        config: testConfig,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);

      const hit = parsed[0];
      expect(hit.snippet).toContain("🧑‍💻");
      expect(hit.snippet).toContain("🚀");
      expect(hit.snippet).toContain("Kiểm tra hệ thống");
      expect(result.stdout).not.toContain("\uFFFD");
    });

    test("end-to-end CLI binary outputs Japanese and astral emojis cleanly", async () => {
      const cliRes = await runCli(["search", "--text", "Astral", "--no-color"], {
        env: {
          XDG_CACHE_HOME: tempDir,
          HOME: tempDir,
        },
      });

      expect(cliRes.exitCode).toBe(0);
      expect(cliRes.stdout).toContain("🧑‍💻");
      expect(cliRes.stdout).toContain("🚀");
      expect(cliRes.stdout).toContain("Kiểm tra hệ thống");
      expect(cliRes.stdout).not.toContain("\uFFFD");
    });
  });
});
