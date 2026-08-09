/**
 * src/skill-usage/cache.ts
 *
 * Filesystem-backed cache for parsed session matches.
 *
 * JSON backend layout:
 *   <cacheDir>/sessions/<fp[0..2]>/<fp[2..16]>.json
 *
 * Each entry is a single JSON file with shape:
 *   { fingerprint, sessionPath, mtime, parserVersion, matches: SkillMatch[] }
 *
 * The `set` operation is in-memory; `close` flushes to disk. Reads on open
 * eagerly load every entry into memory (acceptable for ~1500 sessions at
 * ~1–5MB total).
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillMatch } from "./types";

export interface SkillUsageCache {
  hasValid(fingerprint: string): boolean;
  get(fingerprint: string): SkillMatch[] | undefined;
  set(fingerprint: string, matches: SkillMatch[]): void;
  vacuum(existingFingerprints: Set<string>): number;
  size(): number;
  close(): Promise<void>;
}

interface CacheEntry {
  fingerprint: string;
  sessionPath: string;
  mtime: string;
  parserVersion: string;
  matches: SkillMatch[];
}

const DEFAULT_PARSER_VERSION = "1.0.0";

class JsonCache implements SkillUsageCache {
  private entries = new Map<string, CacheEntry>();
  private dirty = new Set<string>();
  private deleted = new Set<string>();
  private readonly sessionsDir: string;

  private constructor(
    private readonly cacheDir: string,
    private readonly parserVersion: string,
  ) {
    this.sessionsDir = join(cacheDir, "sessions");
  }

  static async open(cacheDir: string, parserVersion: string): Promise<JsonCache> {
    const sessionsDir = join(cacheDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const cache = new JsonCache(cacheDir, parserVersion);
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
          const entry = JSON.parse(raw) as CacheEntry;
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

  get(fingerprint: string): SkillMatch[] | undefined {
    return this.entries.get(fingerprint)?.matches;
  }

  set(fingerprint: string, matches: SkillMatch[]): void {
    const existing = this.entries.get(fingerprint);
    this.entries.set(fingerprint, {
      fingerprint,
      sessionPath: existing?.sessionPath ?? "",
      mtime: existing?.mtime ?? new Date().toISOString(),
      parserVersion: this.parserVersion,
      matches,
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

export async function openCache(
  cacheDir: string,
  format?: "json" | "sqlite",
): Promise<SkillUsageCache> {
  // Only JSON backend implemented; sqlite reserved for future use
  void format;
  return JsonCache.open(cacheDir, DEFAULT_PARSER_VERSION);
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
