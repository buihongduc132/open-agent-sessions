/**
 * src/cmd-usage/enrichers/atuin-bridge.ts
 *
 * AtuinEnricher: enriches cmd-usage with duration/exit from atuin SQLite DB.
 *
 * Uses bun:sqlite (Bun builtin, zero install).
 * Opens DB readonly + immutable to avoid lock contention.
 *
 * Freshness gate:
 *   - Throttled (default 30s) to avoid repeated MAX(timestamp) queries
 *   - STALE on first call or when MAX(timestamp) changes
 *   - FRESH when MAX unchanged within throttle window
 *   - On STALE: clear in-memory cache, re-query DB
 *   - On FRESH: return cached results
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Enricher, EnricherQuery, EnricherResult } from "./types";

export interface AtuinEnricherOptions {
  /** Path to atuin history.db. Default: auto-detect from ~/snap/atuin/<rev>/history.db */
  dbPath?: string;
  /** Cache directory (unused for now — in-memory cache only). */
  cacheDir?: string;
  /** Throttle for freshness gate in ms. Default: 30000. */
  gateThrottleMs?: number;
}

/** Escape LIKE special characters in a command string. */
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Resolve the default atuin DB path. */
function resolveDefaultDbPath(): string | null {
  const home = homedir();
  // Try ~/snap/atuin/*/history.db — find the latest numbered snap
  const glob = join(home, "snap", "atuin", "*", ".local", "share", "atuin", "history.db");
  // Use fs to find matching paths
  const { readdirSync, existsSync: exists } = require("node:fs");
  const snapDir = join(home, "snap", "atuin");
  if (!exists(snapDir)) return null;

  let latest: string | null = null;
  let latestNum = -1;
  try {
    const entries = readdirSync(snapDir);
    for (const entry of entries) {
      const num = parseInt(entry, 10);
      if (!isNaN(num) && num > latestNum) {
        const candidate = join(snapDir, entry, ".local", "share", "atuin", "history.db");
        if (exists(candidate)) {
          latest = candidate;
          latestNum = num;
        }
      }
    }
  } catch {
    return null;
  }
  return latest;
}

export class AtuinEnricher implements Enricher {
  name = "atuin";
  private readonly dbPath: string | null;
  private readonly gateThrottleMs: number;
  private knownMax: number | null = null;
  private lastGateCheck = 0;
  private resultCache = new Map<string, EnricherResult>();

  constructor(opts: AtuinEnricherOptions = {}) {
    this.gateThrottleMs = opts.gateThrottleMs ?? 30000;
    if (opts.dbPath) {
      this.dbPath = opts.dbPath;
    } else {
      this.dbPath = resolveDefaultDbPath();
    }
  }

  async available(): Promise<boolean> {
    if (!this.dbPath || !existsSync(this.dbPath)) return false;

    try {
      const db = new Database(this.dbPath, { readonly: true });
      try {
        // Check if history table exists
        const row = db.query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='history'"
        ).get();
        return row !== null && row !== undefined;
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  }

  /**
   * Freshness gate: checks if atuin DB has new data since last check.
   * Returns "STALE" or "FRESH".
   * Throttled: if called within gateThrottleMs of last check, returns cached result.
   */
  async freshnessGate(): Promise<"STALE" | "FRESH"> {
    const now = Date.now();

    // Throttle check
    if (now - this.lastGateCheck < this.gateThrottleMs && this.knownMax !== null) {
      return "FRESH";
    }

    this.lastGateCheck = now;

    if (!this.dbPath || !existsSync(this.dbPath)) {
      return "STALE";
    }

    try {
      const db = new Database(this.dbPath, { readonly: true });
      try {
        const row = db.query<{ max_ts: number | null }, []>(
          "SELECT MAX(timestamp) as max_ts FROM history"
        ).get();

        const currentMax = row?.max_ts ?? null;

        if (this.knownMax === null) {
          // First call
          this.knownMax = currentMax;
          return "STALE";
        }

        if (currentMax !== this.knownMax) {
          this.knownMax = currentMax;
          return "STALE";
        }

        return "FRESH";
      } finally {
        db.close();
      }
    } catch {
      return "STALE";
    }
  }

  async batchLookup(cmds: EnricherQuery[]): Promise<Map<string, EnricherResult>> {
    const results = new Map<string, EnricherResult>();

    if (!this.dbPath || !existsSync(this.dbPath)) {
      return results;
    }

    // Check freshness
    const gate = await this.freshnessGate();

    if (gate === "FRESH" && this.resultCache.size > 0) {
      // Return cached results for matching keys
      for (const cmd of cmds) {
        const key = `${cmd.sig}|${cmd.rawCommand}`;
        const cached = this.resultCache.get(key);
        if (cached) {
          results.set(key, cached);
        }
      }
      return results;
    }

    // STALE or empty cache — query DB
    if (gate === "STALE") {
      this.resultCache.clear();
    }

    let db: Database;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch {
      return results;
    }

    try {
      for (const cmd of cmds) {
        const key = `${cmd.sig}|${cmd.rawCommand}`;

        // Check cache first
        const cached = this.resultCache.get(key);
        if (cached) {
          results.set(key, cached);
          continue;
        }

        try {
          const escapedCmd = escapeLike(cmd.rawCommand);
          const startTs = new Date(cmd.tsRange[0]).getTime();
          const endTs = new Date(cmd.tsRange[1]).getTime();
          const midTs = (startTs + endTs) / 2;

          const row = db.query<{ duration: number; exit: number }, [string, string, number, number, number]>(
            `SELECT duration, exit FROM history
             WHERE cwd = ? AND command LIKE ? ESCAPE '\\'
               AND timestamp BETWEEN ? AND ?
             ORDER BY ABS(timestamp - ?)
             LIMIT 1`
          ).get(cmd.cwd, escapedCmd, startTs, endTs, midTs);

          if (row) {
            const result: EnricherResult = { durMs: row.duration, exit: row.exit };
            results.set(key, result);
            this.resultCache.set(key, result);
          }
        } catch {
          // Skip individual command errors
        }
      }
    } finally {
      db.close();
    }

    return results;
  }
}
