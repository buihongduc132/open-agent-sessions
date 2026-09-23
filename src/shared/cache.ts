/**
 * src/shared/cache.ts
 *
 * Generic <T> filesystem-backed JSON cache, extracted from
 * src/skill-usage/cache.ts so it can be reused by cmd-usage and other
 * session-mining modules.
 *
 * Sharded JSON layout (unchanged from skill-usage):
 *   <cacheDir>/sessions/<fp[0..2]>/<fp[2..16]>.json
 *
 * Each entry on disk:
 *   { fingerprint, sessionPath, mtime, parserVersion, value: T }
 *
 * Writes are batched: `set()` mutates an in-memory map and marks the entry
 * dirty; `close()` flushes dirty entries to disk and removes deleted entries.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CacheEntry<T> {
  fingerprint: string;
  sessionPath: string;
  mtime: string;
  parserVersion: string;
  value: T;
}

export interface JsonCache<T> {
  hasValid(fingerprint: string): boolean;
  get(fingerprint: string): T | undefined;
  set(fingerprint: string, value: T): void;
  vacuum(existingFingerprints: Set<string>): number;
  size(): number;
  close(): Promise<void>;
}

class JsonCacheImpl<T> implements JsonCache<T> {
  private entries = new Map<string, CacheEntry<T>>();
  private dirty = new Set<string>();
  private deleted = new Set<string>();
  private readonly sessionsDir: string;

  private constructor(
    private readonly cacheDir: string,
    private readonly parserVersion: string,
  ) {
    this.sessionsDir = join(cacheDir, "sessions");
  }

  static async open(cacheDir: string, parserVersion: string): Promise<JsonCacheImpl<T>> {
    const sessionsDir = join(cacheDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const cache = new JsonCacheImpl<T>(cacheDir, parserVersion);
    await cache.load();
    return cache;
  }

  private async load(): Promise<void> {
    let shards: string[];
    try {
      shards = await readdir(this.sessionsDir);
    } catch {
      return;
    }

    for (const shard of shards) {
      const shardDir = join(this.sessionsDir, shard);
      let files: string[];
      try {
        files = await readdir(shardDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const path = join(shardDir, f);
        try {
          const raw = await readFile(path, "utf-8");
          const entry = JSON.parse(raw) as CacheEntry<T>;
          if (entry && typeof entry.fingerprint === "string") {
            this.entries.set(entry.fingerprint, entry);
          }
        } catch {
          // Skip corrupt entries
        }
      }
    }
  }

  hasValid(fingerprint: string): boolean {
    return this.entries.has(fingerprint);
  }

  get(fingerprint: string): T | undefined {
    return this.entries.get(fingerprint)?.value;
  }

  set(fingerprint: string, value: T): void {
    const existing = this.entries.get(fingerprint);
    this.entries.set(fingerprint, {
      fingerprint,
      sessionPath: existing?.sessionPath ?? "",
      mtime: existing?.mtime ?? new Date().toISOString(),
      parserVersion: this.parserVersion,
      value,
    });
    this.dirty.add(fingerprint);
    this.deleted.delete(fingerprint);
  }

  vacuum(existingFingerprints: Set<string>): number {
    let removed = 0;
    for (const fp of Array.from(this.entries.keys())) {
      if (!existingFingerprints.has(fp)) {
        this.entries.delete(fp);
        this.deleted.add(fp);
        this.dirty.delete(fp);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  async close(): Promise<void> {
    for (const fp of this.dirty) {
      const entry = this.entries.get(fp);
      if (!entry) continue;
      const shard = fp.slice(0, 2);
      const rest = fp.slice(2, 16);
      const shardDir = join(this.sessionsDir, shard);
      await mkdir(shardDir, { recursive: true });
      const path = join(shardDir, `${rest}.json`);
      await writeFile(path, JSON.stringify(entry, null, 2));
    }
    this.dirty.clear();

    for (const fp of this.deleted) {
      const shard = fp.slice(0, 2);
      const rest = fp.slice(2, 16);
      const path = join(this.sessionsDir, shard, `${rest}.json`);
      try {
        await rm(path);
      } catch {
        // Ignore missing files
      }
    }
    this.deleted.clear();
  }
}

export async function openCache<T>(
  cacheDir: string,
  parserVersion: string,
): Promise<JsonCache<T>> {
  return JsonCacheImpl.open<T>(cacheDir, parserVersion);
}

/** Compute the cache fingerprint for a session file. */
export function computeFingerprint(
  absPath: string,
  size: number,
  mtimeNs: bigint | number,
  parserVersion: string,
): string {
  const input = `${absPath}|${size}|${mtimeNs.toString()}|${parserVersion}`;
  return createHash("sha256").update(input).digest("hex");
}
