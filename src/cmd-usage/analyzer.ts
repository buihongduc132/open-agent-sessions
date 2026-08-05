/**
 * src/cmd-usage/analyzer.ts
 *
 * Orchestrates the cmd-usage analysis pipeline:
 *   1. Discover session JSONL files (scope: "cwd" or "all")
 *   2. Filter by mtime (last N days)
 *   3. For each session:
 *      - Compute fingerprint (sha256 of path|size|mtimeNs|parserVersion)
 *      - If cache hit → load cached matches
 *      - Else → parse session, classify, cache results
 *   4. Aggregate matches into per-signature records
 *   5. Run enrichers to augment with duration/error data
 *   6. Bucket into 7 daily slots
 *   7. Return CmdUsageReport
 */

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openCache, computeFingerprint } from "../shared/cache";
import { classify } from "./classify";
import { extractBashCommands } from "./parser";
import type { Enricher, EnricherQuery, EnricherResult } from "./enrichers/types";
import type {
  CmdMatch,
  CmdUsageOptions,
  CmdUsageRecord,
  CmdUsageReport,
  EnricherStat,
} from "./types";

const DEFAULT_DAYS = 7;
const DEFAULT_PARSER_VERSION = "1.0.0";
const NUM_BUCKETS = 7;

/** Encode a CWD into the pi session directory name format. */
export function encodeCwd(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "---";
  return `--${normalized.slice(1).replace(/\//g, "-")}--`;
}

export async function analyzeCmdUsage(
  options: CmdUsageOptions,
): Promise<CmdUsageReport> {
  const start = Date.now();
  const days = options.days ?? DEFAULT_DAYS;
  const parserVersion = options.parserVersion ?? DEFAULT_PARSER_VERSION;
  const scope = options.scope ?? "cwd";
  const enrichers = options.enrichers ?? [];

  // 1. Discover session files
  const sessionFiles = await discoverSessions(options.sessionsDir, scope, options.cwd);

  // 2. Filter by mtime
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = await filterByMtime(sessionFiles, cutoffMs);

  // 3. Open cache and process each session
  const cache = await openCache<CmdMatch[]>(options.cacheDir, parserVersion);
  let scanned = 0;
  let cached = 0;
  const allMatches: CmdMatch[] = [];
  const fpsByPath = new Map<string, string>();

  for (const filePath of recent) {
    const st = await stat(filePath);
    const absPath = resolve(filePath);
    const mtimeNs = BigInt(Math.floor(st.mtimeMs * 1_000_000));
    const fp = computeFingerprint(absPath, st.size, mtimeNs, parserVersion);
    fpsByPath.set(absPath, fp);

    if (cache.hasValid(fp)) {
      cached++;
      const matches = cache.get(fp) ?? [];
      allMatches.push(...matches);
    } else {
      scanned++;
      const matches = await parseAndClassify(filePath);
      cache.set(fp, matches);
      allMatches.push(...matches);
    }
  }

  // Vacuum orphaned cache entries
  const existingFps = new Set(fpsByPath.values());
  cache.vacuum(existingFps);
  await cache.close();

  // 4. Aggregate by signature
  const bySignature = aggregate(allMatches);

  // 5. Run enrichers
  const enricherStats: EnricherStat[] = [];
  for (const enricher of enrichers) {
    const statEntry: EnricherStat = { name: enricher.name, unavailable: false };

    try {
      const isAvailable = await enricher.available();
      if (!isAvailable) {
        statEntry.unavailable = true;
        enricherStats.push(statEntry);
        continue;
      }

      // Build enricher queries from all matches
      const queries: EnricherQuery[] = [];
      const matchByKey = new Map<string, CmdMatch[]>();

      for (const m of allMatches) {
        const key = `${m.sig}|${m.raw}`;
        queries.push({
          sig: m.sig,
          rawCommand: m.raw,
          cwd: "", // sessionsDir doesn't carry CWD per match in this impl
          tsRange: [m.ts, m.ts],
        });
        const arr = matchByKey.get(key) ?? [];
        arr.push(m);
        matchByKey.set(key, arr);
      }

      const enricherResults = await enricher.batchLookup(queries);

      // Merge dur/err into records
      for (const [key, result] of enricherResults) {
        const matches = matchByKey.get(key);
        if (!matches || matches.length === 0) continue;

        const sig = matches[0].sig;
        const record = bySignature[sig];
        if (!record) continue;

        const enrichedCount = matches.length;
        // Update aggregate duration/error
        if (result.durMs !== undefined) {
          const prevTotal = (record.durAvg ?? 0) * (record.enrichedPct * record.count);
          const newTotal = prevTotal + result.durMs * enrichedCount;
          const totalEnriched = (record.enrichedPct * record.count) + enrichedCount;
          record.durAvg = newTotal / totalEnriched;
        }

        if (result.exit !== undefined) {
          record.errCount = (record.errCount ?? 0) + (result.exit !== 0 ? enrichedCount : 0);
          record.errRate = record.errCount / record.count;
        }
      }

      enricherStats.push(statEntry);
    } catch {
      statEntry.unavailable = true;
      enricherStats.push(statEntry);
    }
  }

  // Update enrichedPct for all records
  const enrichedSigs = new Set<string>();
  for (const e of enrichers) {
    // Count how many matches each enricher enriched
  }
  // Simple: if enricherStats has any non-unavailable, mark records as enriched
  for (const sig of Object.keys(bySignature)) {
    const record = bySignature[sig];
    const enrichedMatchCount = allMatches.filter((m) => m.sig === sig).length;
    if (enrichedMatchCount > 0 && enricherStats.some((e) => !e.unavailable)) {
      record.enrichedPct = enrichedMatchCount / record.count;
    }
  }

  return {
    bySignature,
    scannedSessions: scanned,
    cachedSessions: cached,
    elapsedMs: Date.now() - start,
    enricherStats,
  };
}

async function discoverSessions(
  sessionsDir: string,
  scope: "cwd" | "all",
  cwd?: string,
): Promise<string[]> {
  const result: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [];
  }

  if (scope === "cwd" && cwd) {
    // Filter to the encoded CWD directory
    const encoded = encodeCwd(cwd);
    const targetDir = join(sessionsDir, encoded);
    try {
      const subentries = await readdir(targetDir);
      for (const s of subentries) {
        if (s.endsWith(".jsonl")) {
          result.push(join(targetDir, s));
        }
      }
    } catch {
      return [];
    }
    return result;
  }

  // scope = "all" — scan all directories one level deep
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
    try {
      const st = await stat(f);
      if (st.mtimeMs >= cutoffMs) result.push(f);
    } catch {
      continue;
    }
  }
  return result;
}

async function parseAndClassify(filePath: string): Promise<CmdMatch[]> {
  const calls = extractBashCommands(filePath);
  const matches: CmdMatch[] = [];

  for (const call of calls) {
    const result = classify(call.command);
    matches.push({
      sig: result.sig,
      base: result.base,
      sub: result.sub,
      raw: call.command,
      ts: call.ts,
      sessionId: call.sessionId,
      toolCallId: call.toolCallId,
    });
  }

  return matches;
}

function aggregate(matches: CmdMatch[]): Record<string, CmdUsageRecord> {
  const bySig: Record<string, CmdUsageRecord> = {};

  for (const m of matches) {
    let rec = bySig[m.sig];
    if (!rec) {
      rec = {
        sig: m.sig,
        base: m.base,
        sub: m.sub,
        count: 0,
        flags: [],
        args: [],
        buckets: new Array(NUM_BUCKETS).fill(0),
        lastTs: m.ts,
        enrichedPct: 0,
      };
      bySig[m.sig] = rec;
    }

    rec.count++;

    if (!rec.lastTs || m.ts > rec.lastTs) {
      rec.lastTs = m.ts;
    }

    // Bucket assignment
    if (m.ts) {
      const bucketIdx = bucketIndex(m.ts);
      if (bucketIdx >= 0 && bucketIdx < NUM_BUCKETS) {
        rec.buckets[bucketIdx]++;
      }
    }
  }

  return bySig;
}

/** Compute the 7-day bucket index [0..6] for an ISO timestamp. */
function bucketIndex(tsIso: string): number {
  const ts = new Date(tsIso).getTime();
  if (!Number.isFinite(ts)) return -1;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const daysAgo = Math.floor((now - ts) / dayMs);
  // Bucket 0 = 6 days ago, bucket 6 = today
  const idx = NUM_BUCKETS - 1 - daysAgo;
  return idx >= 0 && idx < NUM_BUCKETS ? idx : -1;
}
