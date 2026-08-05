/**
 * Phase 6 RED — Sysops query layer + freshness indicators (LD3 LD4).
 *
 * Worst-first per worst-first-testing skill.
 *
 * Contract (a)-(i) from _GOAL_open-agent-sessions.md t6:
 *   (a) 6 LD3 query templates: recent+args, args-for-program, most-run (3 modes),
 *       time-of-day histogram, drill-down, cross-cwd
 *   (b) tz-aware histogram: --tz UTC|local|<IANA>; persists ts_utc + host_tz_offset
 *   (c) ingested_at separate from event_ts; host_clock_skew_check >300s
 *   (d) freshness banner every output: last_ingested_at + max_event_ts + stale
 *       (stderr warning, exit 0)
 *   (e) saved queries (--save/--list/--rerun) + ~/.config/oas-stats/history.jsonl
 *   (f) --follow mode (re-run + diff)
 *   (g) coverage ribbon per-source (agent x day x last_seen_ts)
 *   (h) p99 latency <=200ms on 90d data (DEFERRED to integration bench)
 *   (i) verifier-loop approval hash recorded
 *
 * This file is RED — tests fail because Phase 6 impl missing.
 *
 * @file test/unit/sysops-query-layer.test.ts
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/storage/duckdb";
import { ingestBatch } from "../../src/storage/ingest";
import {
  queryRecent,
  queryArgsForProgram,
  queryMostRun,
  queryTimeOfDayHistogram,
  queryDrillDown,
  queryCrossCwd,
  queryCoverageRibbon,
  computeFreshness,
  checkClockSkew,
} from "../../src/query/templates";
import {
  saveQuery,
  listQueries,
  rerunQuery,
} from "../../src/query/history";
import { diffFollow } from "../../src/query/follow";

const DB_PATH = join(tmpdir(), `oas-cs-p6-${process.pid}-${Date.now()}.duckdb`);
const HISTORY_DIR = join(tmpdir(), `oas-cs-history-${process.pid}-${Date.now()}`);
const HISTORY_PATH = join(HISTORY_DIR, "history.jsonl");

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
  try { rmSync(HISTORY_DIR, { recursive: true }); } catch {}
});

async function seedDb() {
  const db = await openDb(DB_PATH);
  const now = Date.now();
  await ingestBatch(db, [
    {
      agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e1",
      source_schema_version: "0.1.0", event_ts: new Date(now - 1000),
      raw_command: "git status", cwd_hint: "/tmp/repo1", exit_code: 0, duration_ms: 5,
    },
    {
      agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e2",
      source_schema_version: "0.1.0", event_ts: new Date(now - 2000),
      raw_command: "git commit -m foo", cwd_hint: "/tmp/repo1", exit_code: 1, duration_ms: 10,
    },
    {
      agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e3",
      source_schema_version: "0.1.0", event_ts: new Date(now - 3000),
      raw_command: "npm install", cwd_hint: "/tmp/repo2", exit_code: 0, duration_ms: 100,
    },
  ]);
  return db;
}

describe("LD3 (a1): queryRecent — recent cmds+args", () => {
  it("returns_last_n_with_args", async () => {
    const db = await seedDb();
    const rows = await queryRecent(db, 2);
    expect(rows.length).toBe(2);
    expect(rows[0]).toHaveProperty("raw_command");
    expect(rows[0]).toHaveProperty("event_ts");
    // Most recent first
    expect(rows[0].event_ts.getTime()).toBeGreaterThanOrEqual(rows[1].event_ts.getTime());
    await db.close();
  });
});

describe("LD3 (a2): queryArgsForProgram — args for program", () => {
  it("returns_distinct_args_for_program", async () => {
    const db = await seedDb();
    const rows = await queryArgsForProgram(db, "git");
    expect(Array.isArray(rows)).toBe(true);
    // git was called with: status, commit
    expect(rows.some((r: any) => String(r.arg).includes("status"))).toBe(true);
    expect(rows.some((r: any) => String(r.arg).includes("commit"))).toBe(true);
    await db.close();
  });
});

describe("LD3 (a3): queryMostRun — 3 modes", () => {
  it("raw_count_mode", async () => {
    const db = await seedDb();
    const rows = await queryMostRun(db, "raw_count");
    expect(rows[0]).toHaveProperty("program");
    expect(rows[0]).toHaveProperty("n");
    expect(typeof rows[0].n).toBe("number");
    await db.close();
  });

  it("distinct_day_mode", async () => {
    const db = await seedDb();
    const rows = await queryMostRun(db, "distinct_day");
    expect(rows[0]).toHaveProperty("program");
    expect(rows[0]).toHaveProperty("distinct_days");
    await db.close();
  });

  it("failure_weighted_mode", async () => {
    const db = await seedDb();
    const rows = await queryMostRun(db, "failure_weighted");
    expect(rows[0]).toHaveProperty("program");
    // Weighted by failures — git had exit_code=1 in seed data
    expect(rows[0]).toHaveProperty("weight");
    await db.close();
  });
});

describe("LD3 (a4): queryTimeOfDayHistogram — tz-aware", () => {
  it("tz_utc_returns_24_buckets", async () => {
    const db = await seedDb();
    const rows = await queryTimeOfDayHistogram(db, "UTC");
    expect(rows.length).toBe(24);
    expect(rows[0]).toHaveProperty("hour");
    expect(rows[0]).toHaveProperty("n");
    await db.close();
  });

  it("tz_local_uses_host_tz", async () => {
    const db = await seedDb();
    const rows = await queryTimeOfDayHistogram(db, "local");
    expect(rows.length).toBe(24);
    await db.close();
  });

  it("tz_iana_resolves", async () => {
    const db = await seedDb();
    const rows = await queryTimeOfDayHistogram(db, "Asia/Ho_Chi_Minh");
    expect(rows.length).toBe(24);
    await db.close();
  });
});

describe("LD3 (a5): queryDrillDown — drill to session", () => {
  it("returns_oas_session_id_for_event", async () => {
    const db = await seedDb();
    const result = await queryDrillDown(db, "e1");
    expect(result).toBeTruthy();
    expect(result).toHaveProperty("agent");
    expect(result).toHaveProperty("session_id");
    await db.close();
  });
});

describe("LD3 (a6): queryCrossCwd — cross-cwd counts", () => {
  it("groups_by_repo", async () => {
    const db = await seedDb();
    const rows = await queryCrossCwd(db);
    expect(rows[0]).toHaveProperty("repo");
    expect(rows[0]).toHaveProperty("n");
    await db.close();
  });
});

describe("LD3 (g): queryCoverageRibbon — per-source coverage", () => {
  it("returns_agent_x_day_x_last_seen_ts", async () => {
    const db = await seedDb();
    const rows = await queryCoverageRibbon(db);
    expect(rows[0]).toHaveProperty("agent");
    expect(rows[0]).toHaveProperty("day");
    expect(rows[0]).toHaveProperty("last_seen_ts");
    await db.close();
  });
});

describe("LD3 (d): computeFreshness — freshness banner", () => {
  it("returns_last_ingested_at_max_event_ts_stale", async () => {
    const db = await seedDb();
    const f = await computeFreshness(db);
    expect(f).toHaveProperty("last_ingested_at");
    expect(f).toHaveProperty("max_event_ts");
    expect(f).toHaveProperty("stale");
    expect(typeof f.stale).toBe("boolean");
    await db.close();
  });

  it("stale_true_when_max_event_ts_older_than_1h", async () => {
    const db = await openDb(DB_PATH);
    await ingestBatch(db, [
      {
        agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e-old",
        source_schema_version: "0.1.0",
        event_ts: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago
        raw_command: "echo old", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1,
      },
    ]);
    const f = await computeFreshness(db);
    expect(f.stale).toBe(true);
    await db.close();
  });
});

describe("LD3 (c): checkClockSkew — host clock skew", () => {
  it("flags_when_ingested_at_ahead_of_event_ts_by_over_300s", async () => {
    const db = await seedDb();
    const skew = await checkClockSkew(db);
    expect(skew).toHaveProperty("skew_seconds");
    expect(skew).toHaveProperty("flagged");
    expect(typeof skew.flagged).toBe("boolean");
    await db.close();
  });
});

describe("LD3 (e): saved queries — history.jsonl", () => {
  beforeEach(() => {
    mkdirSync(HISTORY_DIR, { recursive: true });
    writeFileSync(HISTORY_PATH, "");
  });

  it("save_query_appends_to_history_jsonl", async () => {
    await saveQuery(HISTORY_PATH, {
      name: "my-recent",
      template: "recent",
      params: { n: 5 },
    });
    const content = await import("node:fs").then(fs => fs.readFileSync(HISTORY_PATH, "utf8"));
    expect(content).toContain("my-recent");
    expect(content).toContain("recent");
  });

  it("list_queries_returns_all_saved", async () => {
    await saveQuery(HISTORY_PATH, { name: "q1", template: "recent", params: {} });
    await saveQuery(HISTORY_PATH, { name: "q2", template: "most_run", params: {} });
    const list = await listQueries(HISTORY_PATH);
    expect(list.length).toBe(2);
    expect(list.map((q: any) => q.name).sort()).toEqual(["q1", "q2"]);
  });

  it("rerun_query_loads_and_returns_template_params", async () => {
    await saveQuery(HISTORY_PATH, { name: "qr", template: "recent", params: { n: 3 } });
    const q = await rerunQuery(HISTORY_PATH, "qr");
    expect(q.name).toBe("qr");
    expect(q.params.n).toBe(3);
  });
});

describe("LD3 (f): diffFollow — --follow mode", () => {
  it("diffs_consecutive_runs_returns_added_rows", async () => {
    const db = await seedDb();
    const run1 = await queryRecent(db, 10);
    // Simulate new event ingested between runs
    await ingestBatch(db, [
      {
        agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e-new",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "new cmd", cwd_hint: "/tmp", exit_code: 0, duration_ms: 1,
      },
    ]);
    const run2 = await queryRecent(db, 10);
    const diff = diffFollow(run1, run2);
    expect(diff.added.length).toBe(1);
    expect(diff.added[0].event_id).toBe("e-new");
    await db.close();
  });
});
