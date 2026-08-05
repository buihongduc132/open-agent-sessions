/**
 * RED tests for src/shared/cache.ts
 *
 * Generic<T> JsonCache extracted from skill-usage/cache.ts.
 * Tests that the cache works with different value types,
 * sharded layout, dirty tracking, vacuum, and fingerprint determinism.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, stat, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openCache, computeFingerprint } from "../../src/shared/cache";

// Test with different value types to verify generic<T>
interface SimpleValue {
  name: string;
  count: number;
}

interface ComplexValue {
  sig: string;
  flags: string[];
  args: { norm: string; count: number }[];
}

describe("JsonCache<T> generic", () => {
  test("works with simple value type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shared-cache-simple-"));
    const cache = await openCache<SimpleValue>(dir, "1.0.0");
    const value: SimpleValue = { name: "test", count: 42 };
    cache.set("fp-simple", value);
    await cache.close();

    const cache2 = await openCache<SimpleValue>(dir, "1.0.0");
    expect(cache2.hasValid("fp-simple")).toBe(true);
    expect(cache2.get("fp-simple")).toEqual(value);
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("works with complex nested value type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shared-cache-complex-"));
    const cache = await openCache<ComplexValue[]>(dir, "1.0.0");
    const values: ComplexValue[] = [
      { sig: "git.diff", flags: ["--stat", "HEAD"], args: [{ norm: "<path>", count: 5 }] },
      { sig: "npm.test", flags: ["--ci"], args: [] },
    ];
    cache.set("fp-complex", values);
    await cache.close();

    const cache2 = await openCache<ComplexValue[]>(dir, "1.0.0");
    expect(cache2.hasValid("fp-complex")).toBe(true);
    expect(cache2.get("fp-complex")).toEqual(values);
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("works with primitive array value type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shared-cache-prim-"));
    const cache = await openCache<string[]>(dir, "1.0.0");
    const value = ["alpha", "beta", "gamma"];
    cache.set("fp-prim", value);
    await cache.close();

    const cache2 = await openCache<string[]>(dir, "1.0.0");
    expect(cache2.get("fp-prim")).toEqual(value);
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("JsonCache<T> sharded layout", () => {
  test("creates sharded directory structure on close", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shared-cache-shard-"));
    const cache = await openCache<SimpleValue>(dir, "1.0.0");
    cache.set("ab12345678901234", { name: "test", count: 1 });
    await cache.close();

    // Verify sharded layout: <cacheDir>/sessions/<fp[0..2]>/<fp[2..16]>.json
    const sessionsDir = join(dir, "sessions");
    const s = await stat(sessionsDir);
    expect(s.isDirectory()).toBe(true);

    const shards = await readdir(sessionsDir);
    expect(shards).toContain("ab");

    const shardDir = join(sessionsDir, "ab");
    const files = await readdir(shardDir);
    expect(files).toContain("12345678901234.json");

    // Verify content
    const content = JSON.parse(await readFile(join(shardDir, "12345678901234.json"), "utf-8"));
    expect(content.fingerprint).toBe("ab12345678901234");
    expect(content.value).toEqual({ name: "test", count: 1 });

    await rm(dir, { recursive: true, force: true });
  });

  test("loads entries from sharded layout on open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shared-cache-load-"));
    const cache = await openCache<SimpleValue>(dir, "1.0.0");
    cache.set("cd98765432109876", { name: "loaded", count: 99 });
    await cache.close();

    const cache2 = await openCache<SimpleValue>(dir, "1.0.0");
    expect(cache2.size()).toBe(1);
    expect(cache2.hasValid("cd98765432109876")).toBe(true);
    expect(cache2.get("cd98765432109876")).toEqual({ name: "loaded", count: 99 });
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("JsonCache<T> dirty tracking", () => {
  test("set marks entry as dirty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shared-cache-dirty-"));
    const cache = await openCache<SimpleValue>(dir, "1.0.0");
    cache.set("fp-dirty", { name: "dirty", count: 1 });
    // Not yet on disk
    const sessionsDir = join(dir, "sessions");
    // Directory exists but should be empty before close
    const shards = await readdir(sessionsDir).catch(() => []);
    expect(shards.length).toBe(0);
    await cache.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("close flushes all dirty entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shared-cache-flush-"));
    const cache = await openCache<SimpleValue>(dir, "1.0.0");
    cache.set("fp-a", { name: "a", count: 1 });
    cache.set("fp-b", { name: "b", count: 2 });
    cache.set("fp-c", { name: "c", count: 3 });
    await cache.close();

    const cache2 = await openCache<SimpleValue>(dir, "1.0.0");
    expect(cache2.size()).toBe(3);
    expect(cache2.get("fp-a")?.name).toBe("a");
    expect(cache2.get("fp-b")?.name).toBe("b");
    expect(cache2.get("fp-c")?.name).toBe("c");
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("overwriting same fp updates value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shared-cache-overwrite-"));
    const cache = await openCache<SimpleValue>(dir, "1.0.0");
    cache.set("fp-ow", { name: "v1", count: 1 });
    cache.set("fp-ow", { name: "v2", count: 2 });
    await cache.close();

    const cache2 = await openCache<SimpleValue>(dir, "1.0.0");
    expect(cache2.get("fp-ow")).toEqual({ name: "v2", count: 2 });
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("JsonCache<T> vacuum", () => {
  test("removes orphaned entries not in existing set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shared-cache-vacuum-"));
    const cache = await openCache<SimpleValue>(dir, "1.0.0");
    cache.set("keep-fp", { name: "keep", count: 1 });
    cache.set("orphan-fp", { name: "orphan", count: 2 });
    await cache.close();

    const cache2 = await openCache<SimpleValue>(dir, "1.0.0");
    const removed = cache2.vacuum(new Set(["keep-fp"]));
    expect(removed).toBe(1);
    expect(cache2.hasValid("orphan-fp")).toBe(false);
    expect(cache2.hasValid("keep-fp")).toBe(true);
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("vacuum returns 0 when nothing to remove", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shared-cache-vacuum0-"));
    const cache = await openCache<SimpleValue>(dir, "1.0.0");
    cache.set("fp1", { name: "a", count: 1 });
    cache.set("fp2", { name: "b", count: 2 });
    await cache.close();

    const cache2 = await openCache<SimpleValue>(dir, "1.0.0");
    const removed = cache2.vacuum(new Set(["fp1", "fp2"]));
    expect(removed).toBe(0);
    expect(cache2.size()).toBe(2);
    await cache2.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("vacuum deletes files from disk on close", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shared-cache-vacuum-del-"));
    const cache = await openCache<SimpleValue>(dir, "1.0.0");
    cache.set("keep", { name: "keep", count: 1 });
    cache.set("remove", { name: "remove", count: 2 });
    await cache.close();

    const cache2 = await openCache<SimpleValue>(dir, "1.0.0");
    cache2.vacuum(new Set(["keep"]));
    await cache2.close();

    // Reopen and verify removed entry is gone
    const cache3 = await openCache<SimpleValue>(dir, "1.0.0");
    expect(cache3.hasValid("remove")).toBe(false);
    expect(cache3.hasValid("keep")).toBe(true);
    await cache3.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("computeFingerprint", () => {
  test("deterministic for same inputs", () => {
    const fp1 = computeFingerprint("/path/to/file", 1024, 1234567890n, "1.0.0");
    const fp2 = computeFingerprint("/path/to/file", 1024, 1234567890n, "1.0.0");
    expect(fp1).toBe(fp2);
  });

  test("different path → different fingerprint", () => {
    const fp1 = computeFingerprint("/path/a", 1024, 1234567890n, "1.0.0");
    const fp2 = computeFingerprint("/path/b", 1024, 1234567890n, "1.0.0");
    expect(fp1).not.toBe(fp2);
  });

  test("different size → different fingerprint", () => {
    const fp1 = computeFingerprint("/path", 1024, 1234567890n, "1.0.0");
    const fp2 = computeFingerprint("/path", 2048, 1234567890n, "1.0.0");
    expect(fp1).not.toBe(fp2);
  });

  test("different mtime → different fingerprint", () => {
    const fp1 = computeFingerprint("/path", 1024, 1234567890n, "1.0.0");
    const fp2 = computeFingerprint("/path", 1024, 9876543210n, "1.0.0");
    expect(fp1).not.toBe(fp2);
  });

  test("different parserVersion → different fingerprint", () => {
    const fp1 = computeFingerprint("/path", 1024, 1234567890n, "1.0.0");
    const fp2 = computeFingerprint("/path", 1024, 1234567890n, "2.0.0");
    expect(fp1).not.toBe(fp2);
  });

  test("returns 64-char hex string (sha256)", () => {
    const fp = computeFingerprint("/path", 1024, 1234567890n, "1.0.0");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  test("accepts number mtimeNs (not just bigint)", () => {
    const fp1 = computeFingerprint("/path", 1024, 1234567890, "1.0.0");
    const fp2 = computeFingerprint("/path", 1024, 1234567890n, "1.0.0");
    expect(fp1).toBe(fp2);
  });
});

describe("JsonCache<T> concurrent open/close", () => {
  test("two handles to same dir see same data after close", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shared-cache-concurrent-"));
    const cache1 = await openCache<SimpleValue>(dir, "1.0.0");
    cache1.set("shared-fp", { name: "shared", count: 42 });
    await cache1.close();

    const cache2 = await openCache<SimpleValue>(dir, "1.0.0");
    const cache3 = await openCache<SimpleValue>(dir, "1.0.0");
    expect(cache2.hasValid("shared-fp")).toBe(true);
    expect(cache3.hasValid("shared-fp")).toBe(true);
    await cache2.close();
    await cache3.close();
    await rm(dir, { recursive: true, force: true });
  });
});
