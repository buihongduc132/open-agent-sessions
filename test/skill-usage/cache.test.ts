/**
 * RED tests for src/skill-usage/cache.ts
 *
 * openCache(cacheDir, format?) → SkillUsageCache
 * SkillUsageCache methods: hasValid, get, set, vacuum, size, close
 *
 * Covers design doc section 7 scenarios 7 (cache invalidation) and 8 (vacuum).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openCache } from "../../src/skill-usage/cache";

const SAMPLE_MATCHES = [
  {
    skill: "verifier-loop",
    tier: "exact",
    distance: 0,
    matchedText: "verifier-loop",
    source: "read-tool",
    sessionId: "sess-1",
    timestamp: "2026-07-15T10:00:00.000Z",
  },
];

describe("SkillUsageCache (JSON backend, default)", () => {
  test("openCache creates the cache dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cache-"));
    const target = join(dir, "cache");
    const cache = await openCache(target);
    await cache.close();
    const s = await stat(target);
    expect(s.isDirectory()).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("set(fp, matches) then hasValid(fp) === true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cache-"));
    const cache = await openCache(dir);
    cache.set("fp-1", SAMPLE_MATCHES);
    await cache.close();
    const cache2 = await openCache(dir);
    expect(cache2.hasValid("fp-1")).toBe(true);
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("get(fp) returns stored matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cache-"));
    const cache = await openCache(dir);
    cache.set("fp-2", SAMPLE_MATCHES);
    await cache.close();
    const cache2 = await openCache(dir);
    const got = cache2.get("fp-2");
    expect(got).toEqual(SAMPLE_MATCHES);
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("different fp → not valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cache-"));
    const cache = await openCache(dir);
    cache.set("fp-3", SAMPLE_MATCHES);
    await cache.close();
    const cache2 = await openCache(dir);
    expect(cache2.hasValid("fp-different")).toBe(false);
    expect(cache2.get("fp-different")).toBeUndefined();
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("vacuum removes orphaned entries and returns count removed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cache-"));
    const cache = await openCache(dir);
    cache.set("keep-fp", SAMPLE_MATCHES);
    cache.set("orphan-fp", SAMPLE_MATCHES);
    await cache.close();
    const cache2 = await openCache(dir);
    // existing fingerprints excludes orphan-fp → must be removed
    const removed = cache2.vacuum(new Set(["keep-fp"]));
    expect(removed).toBe(1);
    expect(cache2.hasValid("orphan-fp")).toBe(false);
    expect(cache2.hasValid("keep-fp")).toBe(true);
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("size() reports entry count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cache-"));
    const cache = await openCache(dir);
    expect(cache.size()).toBe(0);
    cache.set("fp-a", SAMPLE_MATCHES);
    cache.set("fp-b", SAMPLE_MATCHES);
    await cache.close();
    const cache2 = await openCache(dir);
    expect(cache2.size()).toBe(2);
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("close() flushes pending writes (size survives new handle)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cache-"));
    const cache = await openCache(dir);
    cache.set("fp-flush", SAMPLE_MATCHES);
    await cache.close();
    const cache2 = await openCache(dir);
    expect(cache2.hasValid("fp-flush")).toBe(true);
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });
});
