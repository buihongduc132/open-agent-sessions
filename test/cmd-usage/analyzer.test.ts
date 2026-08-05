/**
 * RED tests for src/cmd-usage/analyzer.ts
 *
 * analyzeCmdUsage(): orchestrate full pipeline
 * discoverSessions(): scope-based session discovery
 * filterByMtime(): time-based filtering
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { analyzeCmdUsage } from "../../src/cmd-usage/analyzer";
import type { Enricher, EnricherQuery, EnricherResult } from "../../src/cmd-usage/enrichers/types";

// ── Helper: create mock session files ─────────────────────────────────────

async function createMockSession(
  dir: string,
  sessionId: string,
  cwd: string,
  commands: string[],
): Promise<string> {
  const sessionDir = join(dir, cwd.replace(/^\//, "--").replace(/\//g, "-") + "--");
  await mkdir(sessionDir, { recursive: true });
  // Use current timestamp to ensure it falls within the 7-day bucket window
  const now = new Date();
  const ts = now.toISOString();
  const fileTs = ts.replace(/:/g, "-");
  const filePath = join(sessionDir, `${fileTs}_${sessionId}.jsonl`);

  const lines = [
    `{"type":"session","version":3,"id":"${sessionId}","timestamp":"${ts}","cwd":"${cwd}"}`,
  ];

  for (let i = 0; i < commands.length; i++) {
    const msgTs = new Date(now.getTime() - (i + 1) * 1000).toISOString();
    lines.push(
      `{"type":"message","id":"m${i}","parentId":null,"timestamp":"${msgTs}","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_${i}","name":"bash","arguments":{"command":"${commands[i]}"}}]}}`,
    );
  }

  await writeFile(filePath, lines.join("\n") + "\n");
  return filePath;
}

// ── Mock enricher ─────────────────────────────────────────────────────────

class MockEnricher implements Enricher {
  name = "mock";
  private results: Map<string, EnricherResult>;
  private _available: boolean;

  constructor(results: Record<string, EnricherResult> = {}, available = true) {
    this.results = new Map(Object.entries(results));
    this._available = available;
  }

  async available(): Promise<boolean> {
    return this._available;
  }

  async batchLookup(cmds: EnricherQuery[]): Promise<Map<string, EnricherResult>> {
    const map = new Map<string, EnricherResult>();
    for (const cmd of cmds) {
      const key = `${cmd.sig}|${cmd.rawCommand}`;
      const result = this.results.get(key);
      if (result) {
        map.set(key, result);
      }
    }
    return map;
  }
}

// ── analyzeCmdUsage ───────────────────────────────────────────────────────

describe("analyzeCmdUsage", () => {
  test("end-to-end: extracts and classifies bash commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmd-analyzer-"));
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    await createMockSession(sessionsDir, "sess-1", "/tmp/proj", [
      "git fetch --all",
      "npm test --ci",
      "git diff --stat",
    ]);

    const report = await analyzeCmdUsage({
      sessionsDir,
      scope: "all",
      days: 7,
      cacheDir: join(dir, "cache"),
    });

    expect(report.bySignature["git.fetch"]).toBeDefined();
    expect(report.bySignature["git.fetch"].count).toBe(1);
    expect(report.bySignature["npm.test"]).toBeDefined();
    expect(report.bySignature["npm.test"].count).toBe(1);
    expect(report.bySignature["git.diff"]).toBeDefined();
    expect(report.bySignature["git.diff"].count).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("aggregates by signature across multiple commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmd-analyzer-agg-"));
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    await createMockSession(sessionsDir, "sess-1", "/tmp/proj", [
      "git fetch --all",
      "git fetch --prune",
      "git fetch origin",
    ]);

    const report = await analyzeCmdUsage({
      sessionsDir,
      scope: "all",
      days: 7,
      cacheDir: join(dir, "cache"),
    });

    expect(report.bySignature["git.fetch"].count).toBe(3);

    await rm(dir, { recursive: true, force: true });
  });

  test("returns empty report for no sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmd-analyzer-empty-"));
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    const report = await analyzeCmdUsage({
      sessionsDir,
      scope: "all",
      days: 7,
      cacheDir: join(dir, "cache"),
    });

    expect(Object.keys(report.bySignature).length).toBe(0);
    expect(report.scannedSessions).toBe(0);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("report shape includes all required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmd-analyzer-shape-"));
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    await createMockSession(sessionsDir, "sess-1", "/tmp/proj", ["git fetch"]);

    const report = await analyzeCmdUsage({
      sessionsDir,
      scope: "all",
      days: 7,
      cacheDir: join(dir, "cache"),
    });

    // Report-level fields
    expect(report).toHaveProperty("bySignature");
    expect(report).toHaveProperty("scannedSessions");
    expect(report).toHaveProperty("cachedSessions");
    expect(report).toHaveProperty("elapsedMs");
    expect(report).toHaveProperty("enricherStats");

    // Record-level fields
    const record = report.bySignature["git.fetch"];
    expect(record).toHaveProperty("sig");
    expect(record).toHaveProperty("count");
    expect(record).toHaveProperty("flags");
    expect(record).toHaveProperty("args");
    expect(record).toHaveProperty("buckets");
    expect(record).toHaveProperty("lastTs");
    expect(record).toHaveProperty("enrichedPct");

    await rm(dir, { recursive: true, force: true });
  });

  test("7-day bucketing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmd-analyzer-bucket-"));
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    await createMockSession(sessionsDir, "sess-1", "/tmp/proj", [
      "git fetch",
      "git diff",
    ]);

    const report = await analyzeCmdUsage({
      sessionsDir,
      scope: "all",
      days: 7,
      cacheDir: join(dir, "cache"),
    });

    const record = report.bySignature["git.fetch"];
    expect(record.buckets.length).toBe(7);
    // Sum of buckets should equal count
    expect(record.buckets.reduce((a, b) => a + b, 0)).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("enricher integration: merges dur/err when available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmd-analyzer-enrich-"));
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    await createMockSession(sessionsDir, "sess-1", "/tmp/proj", ["git fetch --all"]);

    const enricher = new MockEnricher({
      "git.fetch|git fetch --all": { durMs: 1500, exit: 0 },
    });

    const report = await analyzeCmdUsage({
      sessionsDir,
      scope: "all",
      days: 7,
      cacheDir: join(dir, "cache"),
      enrichers: [enricher],
    });

    const record = report.bySignature["git.fetch"];
    expect(record.durAvg).toBe(1500);
    expect(record.errCount).toBe(0);
    expect(record.errRate).toBe(0);
    expect(record.enrichedPct).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  test("enricher integration: unavailable enricher skipped gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmd-analyzer-unavail-"));
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    await createMockSession(sessionsDir, "sess-1", "/tmp/proj", ["git fetch"]);

    const enricher = new MockEnricher({}, false);

    const report = await analyzeCmdUsage({
      sessionsDir,
      scope: "all",
      days: 7,
      cacheDir: join(dir, "cache"),
      enrichers: [enricher],
    });

    // Should still have the record, just without enrichment
    expect(report.bySignature["git.fetch"]).toBeDefined();
    expect(report.bySignature["git.fetch"].durAvg).toBeUndefined();
    expect(report.enricherStats[0].unavailable).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("cache hit: second run uses cached data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmd-analyzer-cache-"));
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const cacheDir = join(dir, "cache");

    await createMockSession(sessionsDir, "sess-1", "/tmp/proj", ["git fetch"]);

    // First run: scan
    const report1 = await analyzeCmdUsage({
      sessionsDir,
      scope: "all",
      days: 7,
      cacheDir,
    });
    expect(report1.scannedSessions).toBe(1);
    expect(report1.cachedSessions).toBe(0);

    // Second run: should use cache
    const report2 = await analyzeCmdUsage({
      sessionsDir,
      scope: "all",
      days: 7,
      cacheDir,
    });
    expect(report2.scannedSessions).toBe(0);
    expect(report2.cachedSessions).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });
});

// ── scope: "cwd" vs "all" ────────────────────────────────────────────────

describe("analyzeCmdUsage scope", () => {
  test('scope="cwd" filters to encoded CWD dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmd-analyzer-cwd-"));
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Create sessions in two different CWD dirs
    await createMockSession(sessionsDir, "sess-1", "/tmp/proj-a", ["git fetch"]);
    await createMockSession(sessionsDir, "sess-2", "/tmp/proj-b", ["npm test"]);

    const report = await analyzeCmdUsage({
      sessionsDir,
      scope: "cwd",
      cwd: "/tmp/proj-a",
      days: 7,
      cacheDir: join(dir, "cache"),
    });

    // Should only see proj-a commands
    expect(report.bySignature["git.fetch"]).toBeDefined();
    expect(report.bySignature["npm.test"]).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  test('scope="all" scans all sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmd-analyzer-all-"));
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    await createMockSession(sessionsDir, "sess-1", "/tmp/proj-a", ["git fetch"]);
    await createMockSession(sessionsDir, "sess-2", "/tmp/proj-b", ["npm test"]);

    const report = await analyzeCmdUsage({
      sessionsDir,
      scope: "all",
      days: 7,
      cacheDir: join(dir, "cache"),
    });

    expect(report.bySignature["git.fetch"]).toBeDefined();
    expect(report.bySignature["npm.test"]).toBeDefined();

    await rm(dir, { recursive: true, force: true });
  });
});

// ── EnricherStats ─────────────────────────────────────────────────────────

describe("enricherStats", () => {
  test("reports stats for each enricher", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmd-analyzer-stats-"));
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    await createMockSession(sessionsDir, "sess-1", "/tmp/proj", ["git fetch"]);

    const enricher1 = new MockEnricher({ "git.fetch|git fetch": { durMs: 100 } });
    const enricher2 = new MockEnricher({}, false);

    const report = await analyzeCmdUsage({
      sessionsDir,
      scope: "all",
      days: 7,
      cacheDir: join(dir, "cache"),
      enrichers: [enricher1, enricher2],
    });

    expect(report.enricherStats.length).toBe(2);
    expect(report.enricherStats[0].name).toBe("mock");
    expect(report.enricherStats[0].unavailable).toBe(false);
    expect(report.enricherStats[1].name).toBe("mock");
    expect(report.enricherStats[1].unavailable).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });
});
