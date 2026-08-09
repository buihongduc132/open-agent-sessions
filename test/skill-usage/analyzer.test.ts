/**
 * RED tests for src/skill-usage/analyzer.ts
 *
 * analyzeSkillUsage(options) → SkillUsageReport
 *
 * Covers the end-to-end scenarios from design doc section 7:
 * 1. T1 exact hyphenated name from text
 * 2. T2 normalized space variant
 * 3. T2 normalized PascalCase
 * 4. T3 alias from frontmatter
 * 5. T4 fuzzy typo within distance 2
 * 6. T1 read-load via toolCall path
 * 7. Cache invalidation on edit (mtime change)
 * 8. Cache vacuum on delete
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, copyFile, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { analyzeSkillUsage } from "../../src/skill-usage/analyzer";

const FIXTURES = join(import.meta.dir, "fixtures");
const INV = join(FIXTURES, "skill-inventory");
const SESSIONS_SRC = join(FIXTURES, "sessions");

async function setupSandbox(): Promise<{ sessions: string; cache: string }> {
  const root = await mkdtemp(join(tmpdir(), "skill-analyzer-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  await mkdir(sessions, { recursive: true });
  await mkdir(cache, { recursive: true });
  // copy each fixture session into the sandbox
  for (const f of [
    "session-read-load.jsonl",
    "session-text-mention-hyphen.jsonl",
    "session-alias.jsonl",
    "session-typo.jsonl",
  ]) {
    await copyFile(join(SESSIONS_SRC, f), join(sessions, f));
  }
  return { sessions, cache };
}

describe("analyzeSkillUsage", () => {
  test("returns a SkillUsageReport with expected top-level shape", async () => {
    const { sessions, cache } = await setupSandbox();
    const report = await analyzeSkillUsage({
      sessionsDir: sessions,
      inventoryDirs: [INV],
      cacheDir: cache,
      days: 30,
      fuzzy: { enabled: true, maxDistance: 2 },
    });
    expect(report).toBeDefined();
    expect(typeof report.scannedSessions).toBe("number");
    expect(typeof report.cachedSessions).toBe("number");
    expect(typeof report.elapsedMs).toBe("number");
    expect(typeof report.maxObservedDistance).toBe("number");
    expect(report.bySkill).toBeInstanceOf(Object);
  });

  test("loads count: verifier-loop gets 1 load from session-read-load.jsonl", async () => {
    const { sessions, cache } = await setupSandbox();
    const report = await analyzeSkillUsage({
      sessionsDir: sessions,
      inventoryDirs: [INV],
      cacheDir: cache,
      days: 30,
      fuzzy: { enabled: true, maxDistance: 2 },
    });
    expect(report.bySkill["verifier-loop"].loads).toBeGreaterThanOrEqual(1);
  });

  test("mentions count aggregates T1+T2+T3+T4 across sessions", async () => {
    const { sessions, cache } = await setupSandbox();
    const report = await analyzeSkillUsage({
      sessionsDir: sessions,
      inventoryDirs: [INV],
      cacheDir: cache,
      days: 30,
      fuzzy: { enabled: true, maxDistance: 2 },
    });
    const v = report.bySkill["verifier-loop"];
    expect(v).toBeDefined();
    // multiple mention hits across hyphen + alias sessions
    expect(v.mentions).toBeGreaterThanOrEqual(1);
  });

  test("matchedVariants populated for T2 normalized (verifier-loop from 'verifier loop')", async () => {
    const { sessions, cache } = await setupSandbox();
    const report = await analyzeSkillUsage({
      sessionsDir: sessions,
      inventoryDirs: [INV],
      cacheDir: cache,
      days: 30,
      fuzzy: { enabled: true, maxDistance: 2 },
    });
    const v = report.bySkill["verifier-loop"];
    expect(v.matchedVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tier: "normalized" }),
      ]),
    );
  });

  test("matchedVariants populated for T3 alias (jewilo from session-alias.jsonl)", async () => {
    const { sessions, cache } = await setupSandbox();
    const report = await analyzeSkillUsage({
      sessionsDir: sessions,
      inventoryDirs: [INV],
      cacheDir: cache,
      days: 30,
      fuzzy: { enabled: true, maxDistance: 2 },
    });
    const v = report.bySkill["verifier-loop"];
    expect(v.matchedVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tier: "alias", variant: "jewilo" }),
      ]),
    );
  });

  test("matchedVariants populated for T4 fuzzy (worktree-lifecycel typo, distance 2)", async () => {
    const { sessions, cache } = await setupSandbox();
    const report = await analyzeSkillUsage({
      sessionsDir: sessions,
      inventoryDirs: [INV],
      cacheDir: cache,
      days: 30,
      fuzzy: { enabled: true, maxDistance: 2 },
    });
    const w = report.bySkill["worktree-lifecycle"];
    expect(w).toBeDefined();
    expect(w.matchedVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tier: "fuzzy", distance: 2 }),
      ]),
    );
    expect(report.maxObservedDistance).toBeGreaterThanOrEqual(2);
  });

  test("firstSeen and lastSeen populated from session timestamps", async () => {
    const { sessions, cache } = await setupSandbox();
    const report = await analyzeSkillUsage({
      sessionsDir: sessions,
      inventoryDirs: [INV],
      cacheDir: cache,
      days: 30,
      fuzzy: { enabled: true, maxDistance: 2 },
    });
    const v = report.bySkill["verifier-loop"];
    expect(v.firstSeen).toBeTruthy();
    expect(v.lastSeen).toBeTruthy();
    // fixtures span 10:00 → 12:00 on 2026-07-15
    expect(v.firstSeen).toBe("2026-07-15T10:00:10.000Z");
  });

  test("scannedSessions counts parsed files on fresh run", async () => {
    const { sessions, cache } = await setupSandbox();
    const report = await analyzeSkillUsage({
      sessionsDir: sessions,
      inventoryDirs: [INV],
      cacheDir: cache,
      days: 30,
      fuzzy: { enabled: true, maxDistance: 2 },
    });
    expect(report.scannedSessions).toBe(4);
    expect(report.cachedSessions).toBe(0);
  });

  test("second call (cached) skips reparsing → cachedSessions > 0", async () => {
    const { sessions, cache } = await setupSandbox();
    const opts = {
      sessionsDir: sessions,
      inventoryDirs: [INV],
      cacheDir: cache,
      days: 30,
      fuzzy: { enabled: true, maxDistance: 2 } as const,
    };
    await analyzeSkillUsage(opts);
    const report2 = await analyzeSkillUsage(opts);
    expect(report2.cachedSessions).toBe(4);
    expect(report2.scannedSessions).toBe(0);
  });

  test("scenario 7: cache invalidation when session mtime changes", async () => {
    const { sessions, cache } = await setupSandbox();
    const opts = {
      sessionsDir: sessions,
      inventoryDirs: [INV],
      cacheDir: cache,
      days: 30,
      fuzzy: { enabled: true, maxDistance: 2 } as const,
    };
    const r1 = await analyzeSkillUsage(opts);
    expect(r1.cachedSessions).toBe(0);
    // bump mtime on one session file far into the future
    const target = join(sessions, "session-read-load.jsonl");
    const future = new Date(Date.now() + 60_000);
    await utimes(target, future, future);
    const r2 = await analyzeSkillUsage(opts);
    expect(r2.scannedSessions).toBe(1);
    expect(r2.cachedSessions).toBe(3);
  });

  test("scenario 8: vacuum removes orphaned cache entries when a session is deleted", async () => {
    const { sessions, cache } = await setupSandbox();
    const opts = {
      sessionsDir: sessions,
      inventoryDirs: [INV],
      cacheDir: cache,
      days: 30,
      fuzzy: { enabled: true, maxDistance: 2 } as const,
    };
    await analyzeSkillUsage(opts);
    // delete one session file then re-run → vacuum should clean its cache entry
    await rm(join(sessions, "session-alias.jsonl"), { force: true });
    const r2 = await analyzeSkillUsage(opts);
    expect(r2.scannedSessions).toBe(0);
    expect(r2.cachedSessions).toBe(3);
  });

  test("days filter excludes sessions older than N days", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-analyzer-"));
    const sessions = join(root, "sessions");
    const cacheDir = join(root, "cache");
    await mkdir(sessions, { recursive: true });
    await mkdir(cacheDir, { recursive: true });

    // old session: dated 2020 — mtime also 2020
    const oldFile = join(sessions, "old.jsonl");
    await writeFile(
      oldFile,
      [
        '{"type":"session","version":3,"id":"old-sess","timestamp":"2020-01-01T00:00:00.000Z","cwd":"/tmp"}',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2020-01-01T00:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"using caveman here"}]}}',
      ].join("\n") + "\n",
    );
    const past = new Date("2020-01-02T00:00:00.000Z");
    await utimes(oldFile, past, past);

    const report = await analyzeSkillUsage({
      sessionsDir: sessions,
      inventoryDirs: [INV],
      cacheDir: cacheDir,
      days: 7,
      fuzzy: { enabled: true, maxDistance: 2 },
    });
    // old session excluded by mtime → not scanned, not counted
    expect(report.scannedSessions + report.cachedSessions).toBe(0);
    await rm(root, { recursive: true, force: true });
  });
});
