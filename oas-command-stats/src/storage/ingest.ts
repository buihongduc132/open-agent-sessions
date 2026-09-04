/**
 * ingestBatch — per-row poison isolation + single-tx outbox+cmd_events.
 *
 * Resolves:
 *   OT23 (rank5): per-row try/catch — poison row → cmd_quarantine, rest commit
 *   OT26: outbox + cmd_events in SAME DuckDB file, ONE tx per row
 *   OT45 (rank5): outbox UNIQUE is idempotency oracle, watermark is hint only
 *   OT48: ON CONFLICT (agent, alias, session_id, event_id) DO NOTHING
 *   OT49-X4: schema version gate, fail-loud
 *   OT22: parse_status (ok|partial|failed) + parser_version + parser_notes
 *
 * @file src/storage/ingest.ts
 */
import type { DbHandle } from "./duckdb";
import type { ExtractedEvent, IngestResult, ParsedCommand } from "../types/contract";
import { assertKnownSchemaVersion } from "./schema";
import { parseCommand, getParserVersion } from "../parse/mvdan";
import { deriveEffectiveCwd, deriveRepo } from "../parse/cwd";
import { redact, computeSignature } from "../parse/pii";
import { setWatermark } from "./duckdb";

/**
 * Ingest a batch of extracted events.
 *
 * Strategy:
 *   1. Pre-flight: validate ALL source_schema_versions are known. Throw
 *      SchemaVersionError BEFORE any insert if any unknown (fail-loud).
 *   2. For each event: parse → on success write outbox+cmd_events in single tx;
 *      on parse failure write outbox+quarantine in single tx. Poison rows
 *      isolated per-row (NO batch rollback).
 *   3. ON CONFLICT (agent, alias, session_id, event_id) DO NOTHING → dedupe.
 *   4. Update watermark to MIN ts of successfully-processed rows.
 */
export async function ingestBatch(
  db: DbHandle,
  events: ExtractedEvent[],
): Promise<IngestResult> {
  // (1) Pre-flight schema version gate (OT49-X4) — fail loud before any write.
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  for (const evt of events) {
    if (!evt || typeof evt !== "object") {
      throw new TypeError("each event must be an object");
    }
    if (!evt.agent || !evt.alias || !evt.session_id || !evt.event_id) {
      throw new TypeError("event missing required identity fields (agent/alias/session_id/event_id)");
    }
    assertKnownSchemaVersion(evt.source_schema_version);
  }

  const parserVersion = await getParserVersion();
  let committed = 0;
  let failed = 0;
  let deduped = 0;
  let nextId = 0;
  {
    const maxIdRows = await db.all<{max_id: number | null}>(`SELECT COALESCE(MAX(outbox_id), 0) AS max_id FROM outbox`);
    nextId = (maxIdRows[0]?.max_id ?? 0) + 1;
  }
  const processedTs: Date[] = [];

  // (2) Per-row processing. Each row is its own tx; poison isolated (OT23).
  for (const evt of events) {
    // Check for existing event_id (idempotency pre-check via SELECT — also
    // enforced by UNIQUE constraint, this is just to count dedupes accurately).
    const existing = await db.all<{event_id: string}>(
      `SELECT event_id FROM outbox
       WHERE agent=? AND alias=? AND session_id=? AND event_id=?`,
      [evt.agent, evt.alias, evt.session_id, evt.event_id]
    );
    if (existing.length > 0) {
      deduped++;
      continue;
    }

    // Parse (or fail). Poison = parse failure, NOT batch failure.
    let parsed: ParsedCommand;
    try {
      parsed = await parseCommand(evt.raw_command ?? "");
    } catch (err: any) {
      // Unexpected parser crash — treat as failed (poison row).
      parsed = {
        program: null, subcommand: null, positional_args: [], flags: [],
        pipeline_depth: 0, statement_count: 0,
        parse_status: "failed",
        parser_notes: `parser_crash: ${err?.message?.slice(0, 200) ?? "unknown"}`,
      };
    }

    const myOutboxId = nextId++;
    const isFailed = parsed.parse_status === "failed";

    // Single-tx insert for this row. DuckDB transactions via BEGIN/COMMIT.
    try {
      await db.run("BEGIN TRANSACTION");

      if (isFailed) {
        // (a) Outbox row — raw event captured (OT22 contract: parse-fail
        // STILL writes outbox so the event is never silently lost).
        await db.run(
          `INSERT INTO outbox
             (outbox_id, agent, alias, session_id, event_id, source_schema_version,
              event_ts, raw_command, cwd_hint, exit_code, duration_ms,
              processing_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (agent, alias, session_id, event_id) DO NOTHING`,
          [
            myOutboxId, evt.agent, evt.alias, evt.session_id, evt.event_id,
            evt.source_schema_version, evt.event_ts, evt.raw_command,
            evt.cwd_hint, evt.exit_code, evt.duration_ms,
            "failed",
          ]
        );
        // (b) Quarantine row — parse failed, parser_notes set for forensics.
        await db.run(
          `INSERT INTO cmd_quarantine
             (agent, alias, session_id, event_id, raw_command,
              parse_status, parser_version, parser_notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (agent, alias, session_id, event_id) DO NOTHING`,
          [
            evt.agent, evt.alias, evt.session_id, evt.event_id,
            evt.raw_command, "failed", parserVersion, parsed.parser_notes,
          ]
        );
        failed++;
      } else {
        // (b) Outbox + cmd_events in same tx (OT26 atomicity). Outbox captures
        // raw event for replay; cmd_events is the analytics-ready projection.
        await db.run(
          `INSERT INTO outbox
             (outbox_id, agent, alias, session_id, event_id, source_schema_version,
              event_ts, raw_command, cwd_hint, exit_code, duration_ms,
              processing_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (agent, alias, session_id, event_id) DO NOTHING`,
          [
            myOutboxId, evt.agent, evt.alias, evt.session_id, evt.event_id,
            evt.source_schema_version, evt.event_ts, evt.raw_command,
            evt.cwd_hint, evt.exit_code, evt.duration_ms,
            "processed",
          ]
        );

        // Phase 3 (OT24): derive effective_cwd + repo BEFORE insert.
        const cwdInfo = deriveEffectiveCwd(evt.raw_command ?? "", evt.cwd_hint);
        const repo = cwdInfo.effective_cwd ? deriveRepo(cwdInfo.effective_cwd) : null;

        // Phase 4 (OT30): redact PII on write; cmd_signature = sha256(redact).
        const cmdText = redact(evt.raw_command ?? "");
        const cmdSignature = computeSignature(evt.raw_command ?? "");

        // VARCHAR[] columns bound as JSON-string + explicit cast —
        // duckdb-node does not auto-bind JS arrays to VARCHAR[] (CA).
        await db.run(
          `INSERT INTO cmd_events
             (agent, alias, session_id, event_id, event_ts,
              program, subcommand, positional_args, flags,
              pipeline_depth, statement_count, cwd_hint,
              effective_cwd, repo, cwd_scope, subshell_cwd,
              cmd_text, cmd_signature,
              parse_status, parser_version, parser_notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?::VARCHAR[], ?::VARCHAR[], ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (agent, alias, session_id, event_id) DO NOTHING`,
          [
            evt.agent, evt.alias, evt.session_id, evt.event_id, evt.event_ts,
            parsed.program, parsed.subcommand,
            JSON.stringify(parsed.positional_args ?? []),
            JSON.stringify(parsed.flags ?? []),
            parsed.pipeline_depth, parsed.statement_count, evt.cwd_hint,
            cwdInfo.effective_cwd, repo, cwdInfo.cwd_scope, cwdInfo.subshell_cwd,
            cmdText, cmdSignature,
            parsed.parse_status, parserVersion, parsed.parser_notes,
          ]
        );
        committed++;
        processedTs.push(evt.event_ts);
      }

      await db.run("COMMIT");
    } catch (err: any) {
      // Row-level failure — rollback THIS row's tx, isolate from rest (OT23).
      try { await db.run("ROLLBACK"); } catch {}
      // Treat as poison: retry as a quarantine insert (separate tx).
      try {
        await db.run("BEGIN TRANSACTION");
        await db.run(
          `INSERT INTO cmd_quarantine
             (agent, alias, session_id, event_id, raw_command,
              parse_status, parser_version, parser_notes)
           VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)
           ON CONFLICT (agent, alias, session_id, event_id) DO NOTHING`,
          [
            evt.agent, evt.alias, evt.session_id, evt.event_id,
            evt.raw_command, parserVersion,
            `row_error: ${err?.message?.slice(0, 200) ?? "unknown"}`,
          ]
        );
        await db.run("COMMIT");
        failed++;
      } catch {
        // Truly unrecoverable — surface.
        throw err;
      }
    }
  }

  // (3) Update watermark to MIN ts of processed rows (perf hint, OT45).
  if (processedTs.length > 0) {
    const minTs = processedTs.reduce((min, t) => t < min ? t : min);
    // Group watermark by first event's session (events typically span 1 session
    // per batch in Phase 2; multi-session batch is Phase 5+ scope).
    const firstEvt = events[0];
    if (firstEvt) {
      await setWatermark(
        db, firstEvt.agent, firstEvt.alias, firstEvt.session_id,
        minTs, firstEvt.source_schema_version
      ).catch(() => { /* watermark is hint, never block */ });
    }
  }

  return {
    attempted: events.length,
    committed,
    failed,
    deduped,
  };
}
