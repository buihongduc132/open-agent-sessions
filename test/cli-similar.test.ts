/**
 * REQ-SIM-03: `oas similar` CLI command tests
 */

import { describe, expect, test } from "bun:test";
import { runSimilarCommand, type SimilarService, type SimilarQuery } from "../src/cli/similar";
import { type Config } from "../src/config/types";
import type { SimilarSessionResult } from "../src/similarity/search";

const baseConfig: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
  ],
};

function makeSimilarService(results: SimilarSessionResult[]): SimilarService {
  return async (query: { agent: string; alias: string; id: string }, _topK?: number) => {
    void query;
    return results;
  };
}

function makeSimResult(overrides: Partial<SimilarSessionResult> = {}): SimilarSessionResult {
  return {
    sessionId: "sess-002",
    title: "Similar session",
    score: 0.85,
    rank: 1,
    matchType: "hybrid",
    matchedChunks: 3,
    ...overrides,
  };
}

describe("cli similar", () => {
  describe("session ID validation", () => {
    test("requires session-id argument", async () => {
      const result = await runSimilarCommand({
        config: baseConfig,
        findSimilar: makeSimilarService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("session ID");
    });

    test("accepts session-id via sessionId option", async () => {
      const result = await runSimilarCommand({
        sessionId: "abc123",
        config: baseConfig,
        findSimilar: makeSimilarService([]),
      });

      expect(result.exitCode).toBe(0);
    });

    test("accepts session-id via id option", async () => {
      const result = await runSimilarCommand({
        id: "def456",
        config: baseConfig,
        findSimilar: makeSimilarService([]),
      });

      expect(result.exitCode).toBe(0);
    });
  });

  describe("format output", () => {
    test("returns text by default", async () => {
      const results = [makeSimResult({ sessionId: "sess-002", title: "Second session", rank: 1 })];

      const result = await runSimilarCommand({
        sessionId: "sess-001",
        config: baseConfig,
        findSimilar: makeSimilarService(results),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("sess-002");
      expect(result.stdout).toContain("Second session");
    });

    test("outputs valid JSON with --format json", async () => {
      const results = [
        makeSimResult({ sessionId: "sess-A", title: "Alpha", rank: 1 }),
        makeSimResult({ sessionId: "sess-B", title: "Beta", rank: 2 }),
      ];

      const result = await runSimilarCommand({
        sessionId: "sess-001",
        format: "json",
        config: baseConfig,
        findSimilar: makeSimilarService(results),
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
      expect(parsed[0]).toHaveProperty("sessionId");
      expect(parsed[0]).toHaveProperty("score");
      expect(parsed[0]).toHaveProperty("rank");
    });

    test("shows 'No similar sessions found' when results are empty", async () => {
      const result = await runSimilarCommand({
        sessionId: "sess-001",
        config: baseConfig,
        findSimilar: makeSimilarService([]),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No similar sessions");
    });

    test("text format shows rank, matchType, score, and session_id", async () => {
      const results = [
        makeSimResult({
          sessionId: "sess-xyz",
          title: "Another session",
          rank: 1,
          score: 0.75,
          matchType: "fts-only",
          matchedChunks: 2,
        }),
      ];

      const result = await runSimilarCommand({
        sessionId: "sess-001",
        config: baseConfig,
        findSimilar: makeSimilarService(results),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("rank 1");
      expect(result.stdout).toContain("fts-only");
      expect(result.stdout).toContain("0.7500");
      expect(result.stdout).toContain("sess-xyz");
    });
  });

  describe("topK parameter", () => {
    test("passes topK to the service", async () => {
      let capturedTopK: number | undefined;
      const service: SimilarService = async (query: SimilarQuery, topK?: number) => {
        capturedTopK = topK;
        return [];
      };

      await runSimilarCommand({
        sessionId: "sess-001",
        top: 10,
        config: baseConfig,
        findSimilar: service,
      });

      expect(capturedTopK).toBe(10);
    });

    test("defaults topK to 5 when --top not specified", async () => {
      let capturedTopK: number | undefined;
      const service: SimilarService = async (query: SimilarQuery, topK?: number) => {
        capturedTopK = topK;
        return [];
      };

      await runSimilarCommand({
        sessionId: "sess-001",
        config: baseConfig,
        findSimilar: service,
      });

      // The CLI normalises --top to 5 by default
      expect(capturedTopK).toBe(5);
    });
  });

  describe("error handling", () => {
    test("returns exit code 1 on service error", async () => {
      const failingService: SimilarService = async () => {
        throw new Error("Database error");
      };

      const result = await runSimilarCommand({
        sessionId: "sess-001",
        config: baseConfig,
        findSimilar: failingService,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Database error");
    });

    test("returns exit code 1 when OpenCode agent is not configured", async () => {
      const emptyConfig: Config = {
        agents: [
          { agent: "codex", alias: "work", enabled: true },
        ],
      };

      const result = await runSimilarCommand({
        sessionId: "sess-001",
        config: emptyConfig,
        findSimilar: makeSimilarService([]),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("OpenCode");
    });
  });

  describe("multiple results", () => {
    test("displays multiple results in rank order", async () => {
      const results = [
        makeSimResult({ sessionId: "sess-high", title: "High score session", rank: 1, score: 0.95 }),
        makeSimResult({ sessionId: "sess-mid", title: "Mid score session", rank: 2, score: 0.72 }),
        makeSimResult({ sessionId: "sess-low", title: "Low score session", rank: 3, score: 0.50 }),
      ];

      const result = await runSimilarCommand({
        sessionId: "sess-001",
        config: baseConfig,
        findSimilar: makeSimilarService(results),
      });

      expect(result.exitCode).toBe(0);
      const stdout = result.stdout;
      // Rank 1 should appear before rank 2
      const idx1 = stdout.indexOf("rank 1");
      const idx2 = stdout.indexOf("rank 2");
      expect(idx1).toBeLessThan(idx2);
      // All session IDs should be present
      expect(stdout).toContain("sess-high");
      expect(stdout).toContain("sess-mid");
      expect(stdout).toContain("sess-low");
    });
  });
});
