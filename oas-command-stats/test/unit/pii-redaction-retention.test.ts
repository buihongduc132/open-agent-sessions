/**
 * Phase 4 RED — PII redaction + retention enforcement (OT30 rank5 GDPR).
 *
 * Worst-first per worst-first-testing skill.
 *
 * Contract (a)-(g) from _GOAL_open-agent-sessions.md t4:
 *   (a) ingestion-stage tokenizer-regex redacts on write:
 *       - Bearer tokens (Authorization: Bearer xyz)
 *       - AWS keys (AKIA[0-9A-Z]{16})
 *       - env-assigns matching *TOKEN*|*KEY*|*SECRET*|*PASSWORD*
 *       - credit-card patterns ([0-9]{13,16})
 *       - sshpass -p <pw>
 *       - git+https user:pw URLs
 *   (b) cmd_text (short TTL=7d, redacted) + cmd_signature (long TTL=90d,
 *       PII-free derived hash) split schema
 *   (c) DELETE+VACUUM on TTL trim — forensic test confirms deleted rows
 *       unrecoverable post-VACUUM
 *   (d) retention_hold BOOLEAN column — trim skips held rows
 *   (e) two retention knobs: hard TTL (age) + soft cap (size, sampling not deletion)
 *   (f) legal basis for retention documented in spec
 *   (g) verifier-loop approval hash recorded
 *
 * This file is RED — tests fail because Phase 4 impl missing.
 * GREEN agent must implement redaction + retention + schema split.
 *
 * Respects: OT30 (rank5 GDPR), OT10-G1, OT10-G4, OT10-G5.
 *
 * @file test/unit/pii-redaction-retention.test.ts
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { redact, computeSignature } from "../../src/parse/pii";
import { ingestBatch } from "../../src/storage/ingest";
import { trimExpired, enforceSoftCap } from "../../src/storage/retention";
import { openDb } from "../../src/storage/duckdb";

const DB_PATH = join(tmpdir(), `oas-cs-p4-${process.pid}-${Date.now()}.duckdb`);

afterEach(() => {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + ".wal"); } catch {}
});

describe("OT30 (a): PII redaction patterns", () => {
  it("bearer_token_redacted", () => {
    const r = redact("curl -H 'Authorization: Bearer abc123token' https://api.example.com");
    expect(r).not.toContain("abc123token");
    expect(r).toMatch(/\[REDACTED:token\]/);
  });

  it("aws_access_key_redacted", () => {
    const r = redact("export AWS_KEY=AKIAIOSFODNN7EXAMPLE");
    expect(r).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r).toMatch(/\[REDACTED:aws_key\]/);
  });

  it("env_assign_token_redacted", () => {
    const r = redact("export GITHUB_TOKEN=ghp_abc123def456");
    expect(r).not.toContain("ghp_abc123def456");
    expect(r).toMatch(/\[REDACTED:env_token\]/);
  });

  it("env_assign_secret_redacted", () => {
    const r = redact("FOO_SECRET=hunter2 cmd");
    expect(r).not.toContain("hunter2");
    expect(r).toMatch(/\[REDACTED:env_secret\]/);
  });

  it("env_assign_password_redacted", () => {
    const r = redact("DB_PASSWORD=s3cret pg_dump db");
    expect(r).not.toContain("s3cret");
    expect(r).toMatch(/\[REDACTED:env_password\]/);
  });

  it("credit_card_redacted", () => {
    const r = redact("echo 4111111111111111");
    expect(r).not.toContain("4111111111111111");
    expect(r).toMatch(/\[REDACTED:cc\]/);
  });

  it("sshpass_password_redacted", () => {
    const r = redact("sshpass -p hunter2 ssh user@host");
    expect(r).not.toContain("hunter2");
    expect(r).toMatch(/\[REDACTED:sshpass\]/);
  });

  it("git_https_user_password_redacted", () => {
    const r = redact("git clone https://alice:s3cret@git.example.com/repo.git");
    expect(r).not.toContain("s3cret");
    expect(r).not.toContain("alice:s3cret");
    expect(r).toMatch(/\[REDACTED:git_creds\]/);
  });

  it("multiple_pii_in_one_cmd_all_redacted", () => {
    const r = redact("TOKEN=x curl -H 'Authorization: Bearer abc' https://user:pw@host");
    expect(r).not.toContain("abc");
    expect(r).not.toContain("pw");
    expect(r).not.toContain("x");  // token value redacted
  });

  it("no_pii_passthrough_unchanged", () => {
    const cmd = "git status && echo done";
    expect(redact(cmd)).toBe(cmd);
  });
});

describe("OT30 (b): cmd_signature PII-free hash", () => {
  it("signature_is_sha256_of_redacted_cmd", () => {
    const cmd = "curl -H 'Authorization: Bearer secret123' https://api.example.com";
    const sig = computeSignature(cmd);
    // 32-char hex sha256 prefix
    expect(sig).toMatch(/^[a-f0-9]{32}$/);
    // signature stable: same cmd → same sig
    expect(computeSignature(cmd)).toBe(sig);
  });

  it("signature_does_not_leak_pii", () => {
    const cmd = "TOKEN=secretvalue cmd";
    const sig = computeSignature(cmd);
    // sha256 hash won't contain literal PII; verify hex-only
    expect(sig).toMatch(/^[a-f0-9]{32}$/);
    expect(sig).not.toContain("secretvalue");
  });

  it("signature_differs_when_pii_differs_but_cmd_same", () => {
    // Different secret values → different redacted cmd → different sig
    const sig1 = computeSignature("TOKEN=aaa cmd");
    const sig2 = computeSignature("TOKEN=bbb cmd");
    expect(sig1).not.toBe(sig2);
  });
});

describe("OT30 (c): DELETE + VACUUM forensic unrecoverable", () => {
  it("vacuumed_rows_not_recoverable_on_reopen", async () => {
    const db = await openDb(DB_PATH);

    // Ingest event with PII in raw_command (outbox keeps raw, cmd_text is redacted)
    const oldTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30d ago
    await ingestBatch(db, [
      {
        agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e-old",
        source_schema_version: "0.1.0", event_ts: oldTs,
        raw_command: "TOKEN=secretvalue cmd",
        cwd_hint: "/tmp", exit_code: 0, duration_ms: 1,
      },
    ]);

    // Verify row present pre-trim
    const pre = await db.all("SELECT COUNT(*) AS n FROM outbox");
    expect(pre[0].n).toBe(1);

    // Trim with 7d TTL (row is 30d old → expired)
    await trimExpired(db, { hard_ttl_days: 7 });

    // VACUUM (trim should do this, but enforce)
    await db.run("VACUUM");
    await db.close();

    // Reopen DB — confirm row unrecoverable
    const db2 = await openDb(DB_PATH);
    const post = await db2.all("SELECT COUNT(*) AS n FROM outbox");
    expect(post[0].n).toBe(0);

    // Forensic: scan raw file for PII string
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(DB_PATH, "utf8").toString();
    expect(raw).not.toContain("secretvalue");
    await db2.close();
  });
});

describe("OT30 (d): retention_hold skips trim", () => {
  it("held_row_survives_ttl_trim", async () => {
    const db = await openDb(DB_PATH);
    const oldTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    await ingestBatch(db, [
      {
        agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e-held",
        source_schema_version: "0.1.0", event_ts: oldTs,
        raw_command: "echo held", cwd_hint: "/tmp",
        exit_code: 0, duration_ms: 1,
      },
    ]);

    // Mark as held
    await db.run("UPDATE outbox SET retention_hold = TRUE WHERE event_id = 'e-held'");

    await trimExpired(db, { hard_ttl_days: 7 });

    const post = await db.all("SELECT COUNT(*) AS n FROM outbox WHERE event_id = 'e-held'");
    expect(post[0].n).toBe(1);  // survived
    await db.close();
  });
});

describe("OT30 (e): soft cap does not delete", () => {
  it("soft_cap_marks_for_sampling_not_delete", async () => {
    const db = await openDb(DB_PATH);
    const ts = new Date();

    // Ingest 10 rows
    const events = Array.from({ length: 10 }, (_, i) => ({
      agent: "pi" as const, alias: "t", session_id: "s1", event_id: `e-${i}`,
      source_schema_version: "0.1.0", event_ts: ts,
      raw_command: `echo cmd-${i}`, cwd_hint: "/tmp",
      exit_code: 0, duration_ms: 1,
    }));
    await ingestBatch(db, events);

    // Enforce soft cap = 5 (keep newest 5 unmarked, mark oldest 5 as sample_excluded)
    await enforceSoftCap(db, { max_rows: 5 });

    // All 10 rows still present (NOT deleted)
    const total = await db.all("SELECT COUNT(*) AS n FROM outbox");
    expect(total[0].n).toBe(10);

    // 5 oldest marked as sample_excluded=true
    const excluded = await db.all("SELECT COUNT(*) AS n FROM outbox WHERE sample_excluded = TRUE");
    expect(excluded[0].n).toBe(5);

    await db.close();
  });
});

describe("OT30 contract (b): cmd_events has cmd_text + cmd_signature cols", () => {
  it("cmd_events_schema_has_split_columns", async () => {
    const db = await openDb(DB_PATH);
    const cols = await db.all(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'cmd_events'
    `);
    const names = cols.map((c: any) => c.column_name);
    expect(names).toContain("cmd_text");
    expect(names).toContain("cmd_signature");
    await db.close();
  });

  it("cmd_events_cmd_text_is_redacted_version", async () => {
    const db = await openDb(DB_PATH);
    await ingestBatch(db, [
      {
        agent: "pi" as const, alias: "t", session_id: "s1", event_id: "e1",
        source_schema_version: "0.1.0", event_ts: new Date(),
        raw_command: "TOKEN=secret curl http://x",
        cwd_hint: "/tmp", exit_code: 0, duration_ms: 1,
      },
    ]);
    const rows = await db.all("SELECT cmd_text, cmd_signature FROM cmd_events");
    expect(rows[0].cmd_text).not.toContain("secret");
    expect(rows[0].cmd_signature).toMatch(/^[a-f0-9]{32}$/);
    await db.close();
  });
});
