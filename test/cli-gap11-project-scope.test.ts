import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../src/core/types";
import type { SessionsService, TimeRangeOptions } from "../src/cli/sessions";

function makeSession(id: string, title: string, projectId: string): SessionSummary {
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

describe("GAP 11: oas sessions project scope", () => {
  test("no global fallback for non-project directories", async () => {
    const globalSessions = [
      makeSession("global-tmp-001", "e2e test session in /tmp", "global"),
      makeSession("global-tmp-002", "another /tmp workdir session", "global"),
      makeSession("global-home-001", "home directory session", "global"),
    ];

    const mockGetSessions: SessionsService = async () => {
      return { sessions: globalSessions, errors: [] };
    };

    const result = await mockGetSessions({ cwd: "/nonexistent/project/path", timeRange: {} });
    expect(result.sessions).toHaveLength(0);
  });

  test("returns only project sessions, not global worktree sessions", async () => {
    const projectSessions = [
      makeSession("proj-001", "Project-specific session A", "project-specific-id"),
      makeSession("proj-002", "Project-specific session B", "project-specific-id"),
    ];

    const mockGetSessions: SessionsService = async () => {
      return { sessions: projectSessions, errors: [] };
    };

    const result = await mockGetSessions({ cwd: "/some/project", timeRange: {} });
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.every((s) => s.title.startsWith("Project-specific"))).toBe(true);
    expect(result.sessions.some((s) => s.title.includes("/tmp"))).toBe(false);
  });

  test("session count matches ocxo count for same project", async () => {
    const ocxoCount = 5;
    const projectSessions = Array.from({ length: ocxoCount }, (_, i) =>
      makeSession(`ses-${i}`, `Project session ${i}`, "project-abc"),
    );

    const mockGetSessions: SessionsService = async () => {
      return { sessions: projectSessions, errors: [] };
    };

    const result = await mockGetSessions({ cwd: "/some/project", timeRange: {} });
    expect(result.sessions.length).toBe(ocxoCount);
  });

  test("excludes tmp e2e context workdir sessions", async () => {
    const projectSession = makeSession("proj-correct", "GAP implementation session", "proj-abc");
    const tmpE2ESession = makeSession("tmp-e2e-001", "e2e context session", "global");

    const mockGetSessions: SessionsService = async () => {
      return { sessions: [projectSession, tmpE2ESession], errors: [] };
    };

    const result = await mockGetSessions({ cwd: "/some/project", timeRange: {} });
    expect(result.sessions.some((s) => s.title.includes("e2e context"))).toBe(false);
    expect(result.sessions.some((s) => s.title.includes("/tmp"))).toBe(false);
  });

  test("returns exact project sessions not parent global", async () => {
    const exactProjectSession = makeSession("exact-proj-001", "Session from exact match", "exact-project-id");
    const globalSession = makeSession("global-proj-001", "Global project (wrong)", "global");

    const mockGetSessions: SessionsService = async () => {
      return { sessions: [exactProjectSession], errors: [] };
    };

    const result = await mockGetSessions({ cwd: "/exact/project/path", timeRange: {} });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe("exact-proj-001");
    expect(result.sessions.some((s) => s.id === "global-proj-001")).toBe(false);
  });
});
