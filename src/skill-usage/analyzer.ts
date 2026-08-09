/**
 * src/skill-usage/analyzer.ts
 *
 * Orchestrates the skill-usage analysis pipeline:
 *   1. Load skill inventory from one or more directories
 *   2. Discover session JSONL files (flat or 1-level nested)
 *   3. Filter by mtime (last N days)
 *   4. For each session:
 *      - Compute fingerprint (sha256 of path|size|mtimeNs|parserVersion)
 *      - If cache hit → load cached matches
 *      - Else → parse session, match tokens against inventory, cache results
 *   5. Aggregate matches into per-skill usage records
 *   6. Return SkillUsageReport
 */

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { computeFingerprint, openCache } from "./cache";
import { matchTier } from "./fuzzy";
import { loadSkillInventory } from "./inventory";
import { extractSkillMentions, extractSkillReads } from "./parser";
import type {
  MatchTier,
  SkillInventoryEntry,
  SkillMatch,
  SkillUsageOptions,
  SkillUsageRecord,
  SkillUsageReport,
  SkillUsageVariant,
} from "./types";

const DEFAULT_DAYS = 7;
const DEFAULT_MAX_DISTANCE = 2;

export async function analyzeSkillUsage(
  options: SkillUsageOptions,
): Promise<SkillUsageReport> {
  const start = Date.now();
  const days = options.days ?? DEFAULT_DAYS;
  const maxDistance = options.fuzzy?.enabled === false ? 1 : (options.fuzzy?.maxDistance ?? DEFAULT_MAX_DISTANCE);
  const parserVersion = options.parserVersion ?? "1.0.0";

  // 1. Load inventory
  const inventory = loadSkillInventory(options.inventoryDirs);

  // 2. Discover session files
  const sessionFiles = await discoverSessions(options.sessionsDir);

  // 3. Filter by mtime (last N days)
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = await filterByMtime(sessionFiles, cutoffMs);

  // 4. Open cache and process each session
  const cache = await openCache(options.cacheDir, options.cacheFormat);
  let scanned = 0;
  let cached = 0;
  const allMatches: SkillMatch[] = [];
  const fpsByPath = new Map<string, string>();

  for (const filePath of recent) {
    const st = await stat(filePath);
    const absPath = resolve(filePath);
    // Bun's Stats doesn't expose mtimeNs; synthesize from mtimeMs * 1e6
    const mtimeNs = BigInt(Math.floor(st.mtimeMs * 1_000_000));
    const fp = computeFingerprint(absPath, st.size, mtimeNs, parserVersion);
    fpsByPath.set(absPath, fp);

    if (cache.hasValid(fp)) {
      cached++;
      const matches = cache.get(fp) ?? [];
      allMatches.push(...matches);
    } else {
      scanned++;
      const matches = await parseSession(filePath, inventory, maxDistance);
      cache.set(fp, matches);
      allMatches.push(...matches);
    }
  }

  // 5. Vacuum orphaned cache entries
  const existingFps = new Set(fpsByPath.values());
  cache.vacuum(existingFps);

  await cache.close();

  // 6. Aggregate
  const bySkill = aggregate(allMatches);
  const maxObservedDistance = allMatches.reduce((max, m) => Math.max(max, m.distance), 0);

  return {
    bySkill,
    scannedSessions: scanned,
    cachedSessions: cached,
    elapsedMs: Date.now() - start,
    maxObservedDistance,
  };
}

async function discoverSessions(sessionsDir: string): Promise<string[]> {
  const result: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const p = join(sessionsDir, entry);
    let st;
    try {
      st = await stat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // Recurse one level
      let subentries: string[];
      try {
        subentries = await readdir(p);
      } catch {
        continue;
      }
      for (const s of subentries) {
        if (s.endsWith(".jsonl")) {
          result.push(join(p, s));
        }
      }
    } else if (entry.endsWith(".jsonl")) {
      result.push(p);
    }
  }

  return result;
}

async function filterByMtime(files: string[], cutoffMs: number): Promise<string[]> {
  const result: string[] = [];
  for (const f of files) {
    const st = await stat(f);
    if (st.mtimeMs >= cutoffMs) result.push(f);
  }
  return result;
}

async function parseSession(
  filePath: string,
  inventory: SkillInventoryEntry[],
  maxDistance: 1 | 2 | 3,
): Promise<SkillMatch[]> {
  const matches: SkillMatch[] = [];

  // Read-tool loads (always T1 exact)
  const reads = extractSkillReads(filePath);
  for (const r of reads) {
    matches.push(r);
  }

  // Text mentions
  const tokens = extractSkillMentions(filePath);
  for (const t of tokens) {
    // Match against each skill; take best (lowest tier rank)
    let best: { skill: string; tier: MatchTier; distance: number } | null = null;

    for (const skill of inventory) {
      const result = matchTier(t.token, skill.name, {
        aliases: skill.aliases,
        maxDistance,
      });
      if (!result) continue;

      const rank = tierRank(result.tier);
      if (best === null || rank < tierRank(best.tier)) {
        best = { skill: skill.name, tier: result.tier, distance: result.distance };
      }
      if (result.tier === "exact") break; // Can't do better
    }

    if (best) {
      matches.push({
        skill: best.skill,
        tier: best.tier,
        distance: best.distance,
        matchedText: t.token,
        source: "text-mention",
        sessionId: t.sessionId,
        timestamp: t.timestamp,
      });
    }
  }

  return matches;
}

function tierRank(t: MatchTier): number {
  switch (t) {
    case "exact":
      return 0;
    case "normalized":
      return 1;
    case "alias":
      return 2;
    case "fuzzy":
      return 3;
  }
}

function aggregate(matches: SkillMatch[]): Record<string, SkillUsageRecord> {
  const bySkill: Record<string, SkillUsageRecord> = {};

  for (const m of matches) {
    let rec = bySkill[m.skill];
    if (!rec) {
      rec = {
        skill: m.skill,
        loads: 0,
        mentions: 0,
        sessions: 0,
        loadedInSessions: [],
        mentionedInSessions: [],
        firstSeen: null,
        lastSeen: null,
        matchedVariants: [],
      };
      bySkill[m.skill] = rec;
    }

    if (m.source === "read-tool") {
      rec.loads++;
      if (!rec.loadedInSessions.includes(m.sessionId)) {
        rec.loadedInSessions.push(m.sessionId);
      }
    } else {
      rec.mentions++;
      if (!rec.mentionedInSessions.includes(m.sessionId)) {
        rec.mentionedInSessions.push(m.sessionId);
      }
    }

    if (m.timestamp) {
      if (rec.firstSeen === null || m.timestamp < rec.firstSeen) {
        rec.firstSeen = m.timestamp;
      }
      if (rec.lastSeen === null || m.timestamp > rec.lastSeen) {
        rec.lastSeen = m.timestamp;
      }
    }

    // Track non-exact variants (T2/T3/T4)
    if (m.tier !== "exact") {
      const existing = rec.matchedVariants.find(
        (v) => v.variant === m.matchedText && v.tier === m.tier && v.distance === m.distance,
      );
      if (existing) {
        existing.count++;
      } else {
        rec.matchedVariants.push({
          variant: m.matchedText,
          tier: m.tier,
          count: 1,
          distance: m.distance,
        });
      }
    }
  }

  // Compute sessions count (union of loaded + mentioned)
  for (const rec of Object.values(bySkill)) {
    const all = new Set([...rec.loadedInSessions, ...rec.mentionedInSessions]);
    rec.sessions = all.size;
  }

  return bySkill;
}
