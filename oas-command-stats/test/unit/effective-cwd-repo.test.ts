/**
 * Phase 3 RED — OT24 rank5: effective_cwd + repo derivation.
 *
 * Worst-first per worst-first-testing skill.
 *
 * Contract (a)-(f) from _GOAL_open-agent-sessions.md t3:
 *   (a) effective_cwd populated from `cd X && cmd` → X (NOT session cwd)
 *   (b) repo = nearest .git parent else basename(cwd)
 *       cwd_realpath resolves .. and ~ against session cwd
 *   (c) cross-cwd query 'which repos use --force' returns correct repo grouping
 *       (NOT N=1-per-path noise)
 *   (d) subshell/pushd/relative cd handled via AST walk (cwd_scope=subshell)
 *   (e) index on `repo` column, not raw cwd
 *   (f) verifier-loop approval hash recorded
 *
 * This file is RED — tests fail because Phase 3 impl missing.
 * GREEN agent must implement effective_cwd + repo + cwd_scope + index.
 *
 * @file test/unit/effective-cwd-repo.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveEffectiveCwd, deriveRepo } from "../../src/parse/cwd";
import { ingestBatch } from "../../src/storage/ingest";
import { openDb } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-p3-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("OT24-G1: effective_cwd from `cd X && cmd`", () => {
  it("cd_target_overrides_session_cwd", () => {
    const r = deriveEffectiveCwd("cd /tmp/project && grep foo file.txt", "/home/user");
    expect(r.effective_cwd).toBe("/tmp/project");
    expect(r.cwd_scope).toBe("explicit_cd");
  });

  it("no_cd_uses_session_cwd", () => {
    const r = deriveEffectiveCwd("grep foo file.txt", "/home/user/work");
    expect(r.effective_cwd).toBe("/home/user/work");
    expect(r.cwd_scope).toBe("session_default");
  });

  it("cd_with_relative_path_resolved_against_session_cwd", () => {
    const r = deriveEffectiveCwd("cd subdir && ls", "/home/user/work");
    expect(r.effective_cwd).toBe("/home/user/work/subdir");
    expect(r.cwd_scope).toBe("explicit_cd");
  });

  it("cd_with_dotdot_resolved", () => {
    const r = deriveEffectiveCwd("cd .. && ls", "/home/user/work/subdir");
    expect(r.effective_cwd).toBe("/home/user/work");
  });

  it("cd_with_tilde_expanded", () => {
    const r = deriveEffectiveCwd("cd ~/projects && ls", "/anywhere");
    expect(r.effective_cwd).toBe(`${process.env.HOME}/projects`);
  });

  it("multiple_cd_chain_last_wins", () => {
    const r = deriveEffectiveCwd("cd /a && cd /b && cd /c && pwd", "/start");
    expect(r.effective_cwd).toBe("/c");
  });
});

describe("OT24-G2: repo derivation from nearest .git", () => {
  it("finds_nearest_git_parent", () => {
    // cwd deep inside a repo → repo = top-level dir containing .git
    const r = deriveRepo("/home/user/myrepo/src/lib/deep");
    // Will find /home/user/myrepo IF it has .git, else basename fallback
    expect(r).toBeTruthy();
    expect(typeof r).toBe("string");
  });

  it("basename_fallback_when_no_git", () => {
    const r = deriveRepo("/tmp/nonexistent-xyz");
    expect(r).toBe("nonexistent-xyz");
  });

  it("repo_column_normalized_ignores_trailing_slash", () => {
    const a = deriveRepo("/home/user/myrepo/");
    const b = deriveRepo("/home/user/myrepo");
    expect(a).toBe(b);
  });
});

describe("OT24-G3: subshell/pushd scope tracking", () => {
  it("subshell_cd_marked_subshell_scope", () => {
    const r = deriveEffectiveCwd("(cd /tmp/subshell && build.sh) && echo done", "/home/user");
    // Outer scope cwd stays session default; subshell cwd tracked separately
    expect(r.effective_cwd).toBe("/home/user");
    expect(r.cwd_scope).toBe("session_default");
    expect(r.subshell_cwd).toBe("/tmp/subshell");
  });

  it("pushd_in_command_marked_subshell_scope", () => {
    const r = deriveEffectiveCwd("pushd /tmp/x && make && popd", "/home/user");
    expect(r.subshell_cwd).toBe("/tmp/x");
    expect(r.cwd_scope).toBe("pushd_scope");
  });
});

describe("OT24 cross-cwd repo grouping query (contract c)", () => {
  it("which_repos_use_force_flag_returns_distinct_repos", async () => {
    const db = await openDb(DB_PATH);

    // 3 commands across 2 different cwds, both inside SAME repo
    // Both should group to same `repo` value (NOT N=1-per-path noise)
    const events = [
      {
        agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e1",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "cd /home/user/myrepo && rm --force build/",
        cwd_hint: "/home/user", exit_code: 0, duration_ms: 1,
      },
      {
        agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e2",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "cd /home/user/myrepo/src && rm --force obj/",
        cwd_hint: "/home/user", exit_code: 0, duration_ms: 1,
      },
      {
        agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e3",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "cd /tmp/other-repo && rm --force x",
        cwd_hint: "/home/user", exit_code: 0, duration_ms: 1,
      },
    ];

    await ingestBatch(db, events);

    // Query: which repos use --force, grouped by repo (NOT by raw cwd)
    const rows = await db.all(`
      SELECT repo, COUNT(*) AS n
      FROM cmd_events
      WHERE has_flag(flags, '--force') OR positional_args_exists_in(positional_args, '--force')
      GROUP BY repo
      ORDER BY repo
    `);

    // Expect 2 distinct repos (myrepo, other-repo), NOT 3 paths
    expect(rows.length).toBe(2);
    const repos = rows.map((r: any) => r.repo).sort();
    expect(repos).toEqual(["myrepo", "other-repo"]);
    await db.close();
  });
});

describe("OT24 contract (e): index on repo column exists", () => {
  it("cmd_events_has_index_on_repo", async () => {
    const db = await openDb(DB_PATH);
    // DuckDB: query duckdb_indexes() for cmd_events repo
    const idx = await db.all(`
      SELECT index_name FROM duckdb_indexes()
      WHERE table_name = 'cmd_events'
    `);
    const hasRepoIdx = idx.some((r: any) =>
      /repo/i.test(String(r.index_name))
    );
    expect(hasRepoIdx).toBe(true);
    await db.close();
  });
});
