import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "path";
import type { SessionSummary } from "../src/core/types";
import type { SessionsService } from "../src/cli/sessions";

function runCLI(args: string[], cwd: string, timeoutMs = 8000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("bun", [join(cwd, "bin", "oas"), ...args], { cwd, timeout: timeoutMs });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => { resolve({ exitCode: code ?? 1, stdout, stderr }); });
    proc.on("error", (e) => { resolve({ exitCode: 1, stdout, stderr: e.message }); });
  });
}

const WORKTREES = {
  openAgentSessions: "/home/bhd/Documents/Projects/bhd/open-agent-sessions",
  oasFunctionalitiesImprove: "/home/bhd/Documents/Projects/bhd/oas-functionalities-improve",
  oasAprGaps: "/home/bhd/Documents/Projects/bhd/oas-16apr-gaps",
};

function makeSession(id: string, title: string, directory: string): SessionSummary {
  return {
    id,
    agent: "opencode",
    alias: "default",
    title,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 5,
    storage: "db",
  };
}

describe("GAP 11: oas sessions project scope across worktrees", () => {
  test("open-agent-sessions worktree: oas returns sessions (exact project match)", async () => {
    const result = await runCLI(["sessions", "--limit", "5", "--format", "json"], WORKTREES.openAgentSessions);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  test("oas-16apr-gaps worktree: oas returns sessions (no project entry, queries by directory)", async () => {
    const result = await runCLI(["sessions", "--limit", "5", "--format", "json"], WORKTREES.oasAprGaps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  test("oas sessions count in oas-16apr-gaps >= ocxo session list count", async () => {
    const [oasResult, ocxoResult] = await Promise.all([
      runCLI(["sessions", "--limit", "0", "--format", "json"], WORKTREES.oasAprGaps),
      new Promise<{ stdout: string }>((resolve) => {
        const proc = spawn("ocxo", ["session", "list", "-n", "100"], { cwd: WORKTREES.oasAprGaps, timeout: 15000 });
        let stdout = "";
        proc.stdout.on("data", (d) => { stdout += d.toString(); });
        proc.on("close", () => { resolve({ stdout }); });
        proc.on("error", () => { resolve({ stdout: "" }); });
        setTimeout(() => { proc.kill(); resolve({ stdout: "" }); }, 15000);
      }),
    ]);

    expect(oasResult.exitCode).toBe(0);
    const oasSessions = JSON.parse(oasResult.stdout);
    const ocxoLines = ocxoResult.stdout.trim().split("\n").filter((l) => l.length > 0);
    const ocxoCount = Math.max(0, ocxoLines.length - 2);

    expect(oasSessions.length).toBeGreaterThanOrEqual(ocxoCount);
  });

  test("oas-16apr-gaps: oas sessions does not return /tmp/e2e_context sessions", async () => {
    const result = await runCLI(["sessions", "--limit", "20", "--format", "json"], WORKTREES.oasAprGaps);
    expect(result.exitCode).toBe(0);
    const sessions: { id: string; title: string }[] = JSON.parse(result.stdout);
    const hasTmp = sessions.some((s) =>
      s.title.includes("/tmp") || s.title.includes("e2e_context") || s.title.includes("e2e tasks")
    );
    expect(hasTmp).toBe(false);
  });

  test("oasFunctionalitiesImprove worktree: no project entry → returns empty or scoped", async () => {
    const result = await runCLI(["sessions", "--limit", "5", "--format", "json"], WORKTREES.oasFunctionalitiesImprove);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("open-agent-sessions: oas sessions count >= ocxo count", async () => {
    const [oasResult, ocxoResult] = await Promise.all([
      runCLI(["sessions", "--limit", "0", "--format", "json"], WORKTREES.openAgentSessions),
      new Promise<{ stdout: string }>((resolve) => {
        const proc = spawn("ocxo", ["session", "list", "-n", "100"], { cwd: WORKTREES.openAgentSessions, timeout: 15000 });
        let stdout = "";
        proc.stdout.on("data", (d) => { stdout += d.toString(); });
        proc.on("close", () => { resolve({ stdout }); });
        proc.on("error", () => { resolve({ stdout: "" }); });
        setTimeout(() => { proc.kill(); resolve({ stdout: "" }); }, 15000);
      }),
    ]);

    expect(oasResult.exitCode).toBe(0);
    const oasSessions = JSON.parse(oasResult.stdout);
    const ocxoLines = ocxoResult.stdout.trim().split("\n").filter((l) => l.length > 0 && !l.includes("─") && !l.includes("Session ID"));
    const ocxoCount = ocxoLines.length;

    expect(oasSessions.length).toBeGreaterThanOrEqual(ocxoCount);
  });
});

describe("GAP 11: unit-level — cwd drives session scope", () => {
  test("getSessions receives correct cwd from runSessionsCommand", async () => {
    let receivedCwd: string | undefined;
    const mockGetSessions: SessionsService = async (query) => {
      receivedCwd = query.cwd;
      return { sessions: [], errors: [] };
    };

    const { runSessionsCommand } = await import("../src/cli/sessions");
    await runSessionsCommand({
      last: "30d",
      config: { agents: [{ agent: "opencode", alias: "default", enabled: true, storage: { mode: "auto" } }] },
      getSessions: mockGetSessions,
    });

    expect(receivedCwd).toBe(process.cwd());
  });

  test("sessions for worktree without project entry returns sessions by directory match", async () => {
    const cwd = WORKTREES.oasAprGaps;
    const projectSessions = [
      makeSession("ses-001", "OAS sessions UX requirements", cwd),
      makeSession("ses-002", "Gaps implementation workflow", cwd),
    ];

    const mockGetSessions: SessionsService = async ({ cwd: c }) => {
      if (c === cwd) return { sessions: projectSessions, errors: [] };
      return { sessions: [], errors: [] };
    };

    const { runSessionsCommand } = await import("../src/cli/sessions");
    const result = await runSessionsCommand({
      last: "30d",
      format: "json",
      config: { agents: [{ agent: "opencode", alias: "default", enabled: true, storage: { mode: "auto" } }] },
      getSessions: mockGetSessions,
    });

    expect(result.exitCode).toBe(0);
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(result.stdout); }).not.toThrow();
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(2);
  });

  test("sessions for nonexistent directory returns empty JSON (no sessions match cwd)", async () => {
    const mockGetSessions: SessionsService = async ({ cwd: c }) => {
      if (c.includes("nonexistent")) return { sessions: [], errors: [] };
      return { sessions: [makeSession("fake", "Fake", "/home/bhd/somewhere")], errors: [] };
    };

    const { runSessionsCommand } = await import("../src/cli/sessions");
    const originalCwd = process.cwd;
    Object.defineProperty(process, "cwd", { value: () => "/nonexistent/path", configurable: true });
    try {
      const result = await runSessionsCommand({
        last: "30d",
        format: "json",
        config: { agents: [{ agent: "opencode", alias: "default", enabled: true, storage: { mode: "auto" } }] },
        getSessions: mockGetSessions,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("[]");
    } finally {
      Object.defineProperty(process, "cwd", { value: originalCwd, configurable: true });
    }
  });
});
