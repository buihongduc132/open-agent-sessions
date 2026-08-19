I have full design context from the sibling reviewer artifacts. The referenced `plan.md`/`progress.md` don't exist (this is a batched fan-out — the parent embedded all needed context in the task). No web-search tool is available in this environment, so sources are cited from canonical/established references rather than live-searched (flagged in acceptance report).

---

## Review — Command Stats Ingestion: DEPLOYMENT / SCOPE / INGESTION CORRECTNESS

Evidence base: `.pi-subagents/artifacts/88697cea-82e9-4395-bdc4-b559d2b0a386_reviewer_{0,1,2}_input.md` (outbox schema, cmd_events schema, watermark JSON, ingestBatch pseudocode, chunking params, multi-agent sources). Design constants referenced: `src/core/types.ts` (Adapter interface, per AGENTS.md).

---

### OT1 — separate-repo-vs-integrated

**OT1-G1 — oas Adapter surface is internal, not a versioned public SDK.** Rank 4 (Significant)
- **What:** `Adapter` / `SessionSummary` / `SessionDetail` / `SessionReadOptions` (in `src/core/types.ts`) are internal interfaces used by oas's own CLI. The user hedge ("oas is the common function / sdk that it can import") assumes a stable import boundary that does not exist today. Any internal refactor (rename, field drop, type narrowing) becomes a silent breaking change for the downstream `oas-command-stats` consumer.
- **Why missed:** Design treats "import oas" as a clean SDK contract; never carves out a public surface vs internal.
- **Severity:** Significant — adapter schema is volatile (3 external agent formats evolve independently); silent field drops in `SessionDetail` = silent data loss in analytics.
- **Mitigation:** Carve `@open-agent-sessions/sdk` subpackage with `exports` map; lock oas-stats to exact oas version; contract test in oas CI that fails on breaking `SessionDetail` change; store `adapter_version` per ingested batch.
- **Sources:** npm `"exports"` field + subpath restrictions (Node.js docs); Go `internal/` package convention; Pact consumer-driven contract testing; SemVer spec (semver.org); "Public API surface management" (Google API design guide).

**OT1-G2 — Cross-repo release coordination latency.** Rank 3 (Moderate)
- **What:** Bug fix in an oas adapter (e.g. hermes schema v6→v7) requires: ship oas patch → bump oas-stats dep → ship oas-stats. Latency hours-to-days vs single-PR monorepo. Two CI pipelines, two changelogs, two semver bumps per coupled fix.
- **Why missed:** "Cleaner separation" framing didn't model release-coupling cost.
- **Severity:** Moderate — slows incident response on ingestion-breaking adapter bugs.
- **Mitigation:** Monorepo `packages/` layout with workspace ref; OR automated renovate/dependabot bump + `npm link` local dev; OR git-submodule snapshot pin with explicit upgrade gate.
- **Sources:** Google SRE trunk-based dev / monorepo benefits; npm/yarn workspaces docs; Renovate/Dependabot; "Polyrepo release coupling" (ThoughtWorks Tech Radar).

**OT1-G3 — Drill-down workflow couples two binaries; version skew breaks UX.** Rank 3 (Moderate, cross-cutting LD3)
- **What:** Locked workflow is "stats for overview then oas to drill down to the exact session" (reviewer_2 verbatim). This requires BOTH `oas` and `oas-stats` installed and mutually compatible. Separate repo = user installs/updates them independently. If oas renames a session-id format and oas-stats emits the old format in its drill-down hint, the handoff 404s silently.
- **Why missed:** Ease-of-use (LD4) assumed within one tool; drill-down spans two.
- **Severity:** Moderate — silent broken drill-down under version skew.
- **Mitigation:** `oas-stats status` reports required oas version range; refuse drill-down emit if oas version mismatched; or ship as `oas stats` subcommand of the oas binary.
- **Sources:** CLI composability / "toolchain version alignment" (Unix philosophy pitfalls); ADR on binary coupling; npm `engines`/`peerDependencies`; "Versioned handoffs" (Stripe API design).

---

### LD2 — per-session-watermarks

**LD2-G1 — High-watermark by `last_event_ts` permanently drops late/out-of-order events.** Rank 5 (Sophisticated)
- **What:** Watermark advances `last_event_ts` per session; "fully-ingested sessions skipped." Any event with `ts < watermark` arriving later (NTP clock correction, retroactive JSONL edit, append-after-compaction with earlier ts, cross-source clock skew) is never re-scanned. This is the canonical CDC high-watermark trap.
- **Why missed:** Assumes monotonic `event_ts` within a session. Three sources, three ts formats (ISO-8601 / epoch-ms / epoch-ms), some produced on skew clocks — monotonicity is not guaranteed.
- **Severity:** Sophisticated — silent, undetectable data loss; watermark itself hides the gap.
- **Mitigation:** Don't use ts as the skip-predicate. Use the outbox `UNIQUE(agent, alias, session_id, event_id)` as the idempotency oracle; keep watermark only as a perf hint (scan-start bound), not a skip decision. Add a lookback window (rescan N hours below watermark). Track `(session_id, max_event_id)` not just `last_event_ts`.
- **Sources:** Debezium Outbox Event Router docs (CDC ordering); Apache Flink "Event Time & Watermarks" + allowed-lateness; Confluent "Idempotent Producer" / EOS; Stripe "Idempotent Requests"; microservices.io Transactional Outbox.

**LD2-G2 — Watermark JSON file is not crash-safe; concurrent PromisePool workers race on it.** Rank 4 (Significant)
- **What:** Watermark is a JSON file. `MAX_CONCURRENT_SESSIONS=10` via PromisePool = up to 10 workers updating per-session entries concurrently. No atomic-write strategy (temp+fsync+rename) specified; no serialization. Mid-write crash → truncated/partial JSON → either watermark too high (skip events) or rolled back (infinite re-ingest).
- **Why missed:** LD4 "in-memory watermarks" hand-waves persistence; LD2 never specifies write atomicity.
- **Severity:** Significant — silent corruption of the skip oracle.
- **Mitigation:** Move watermark into DuckDB as a table (transactional with ingest, ACID with the batch commit). OR atomic temp+fsync+rename + single-writer mutex around the file. Never partial-field JSON mutation under concurrency.
- **Sources:** POSIX `rename(2)` atomicity + `fsync(2)` ordering; DuckDB ACID/transactional DDL docs; SQLite WAL mode for metadata; "Atomic file writes" (SQLite/WAL design rationale); POSIX stdio buffering pitfalls.

**LD2-G3 — `session_id` reuse / non-unique mapping invalidates skip logic.** Rank 4 (Significant)
- **What:** "Fully-ingested sessions skipped" assumes 1:1 `session_id` ↔ content. UUIDs can be reused by: agent reinstall restoring old session files, test fixtures, file copies, zcode `sess_<uuid>` regenerated after DB reset, pi `<ts>_<id>.jsonl` where `<id>` collides. Prior-incarnation watermark skips the new content.
- **Why missed:** Watermark key is `(agent, alias, session_id)` only; no content fingerprint.
- **Severity:** Significant — silent stale-data skip on reuse.
- **Mitigation:** Add session fingerprint to watermark key: `(session_id, first_event_hash, event_count_range, file_inode+mtime)`. On fingerprint mismatch, re-ingest from scratch. Treat as a new epoch.
- **Sources:** UUID collision/reuse literature; "Idempotency key design" (Stripe API); CDC source fingerprinting (Debeium `source` block); file-inode CDC (rsync/lsyncd); "Natural vs surrogate keys."

**LD2-G4 — JSONL rotation/truncation/compaction breaks watermark assumptions.** Rank 4 (Signistic)
- **What:** pi JSONL is append-only in the happy path, but pi has a `compaction` event type (per AGENTS.md agent taxonomy) and tools rotate/truncate. After compaction the file has fewer lines, different offsets, possibly different first-line hash. Watermark's `event_count` and `last_event_id` no longer correspond → infinite rescan loop (count never matches) OR silent skip (count appears satisfied).
- **Why missed:** Design assumes immutable append-only session files; compaction is real and in the data model.
- **Severity:** Significant — either stuck loop or silent skip; both degrade ingestion correctness.
- **Mitigation:** Track `file_size + mtime + first_line_hash` alongside watermark; drift triggers full re-ingest of that session. Treat compaction as a new session epoch (new watermark entry).
- **Sources:** Kafka log compaction; Grafana Loki retention/chunk rotation; file-fingerprint CDC (fswatch/inotify); "Append-only ledger immutability" assumption critique; rsync rolling-checksum.

**LD2-G5 — `cmd_events` idempotency key ambiguous; `ON CONFLICT DO NOTHING` target unspecified.** Rank 3 (Moderate)
- **What:** ingestBatch does `INSERT INTO cmd_events ON CONFLICT DO NOTHING`. cmd_events schema has surrogate `id` + `(agent, alias, session_id, ...)` but NO `event_id` column (only outbox has `event_id`). If conflict target is surrogate `id` (hash of cmd+ts), two identical commands in the same session-second get deduped (false positive). If no explicit target, DuckDB behavior is ambiguous.
- **Why missed:** Outbox `UNIQUE(agent, alias, session_id, event_id)` exists but the cmd_events dedup key was never aligned to it.
- **Severity:** Moderate — silent dedup of legit repeats OR silent dups.
- **Mitigation:** Add `event_id` column to cmd_events; explicit `ON CONFLICT (agent, alias, session_id, event_id) DO NOTHING`. Document the idempotency key. Test with two identical commands in one session.
- **Sources:** PostgreSQL/SQLite `ON CONFLICT` target semantics; DuckDB `INSERT ... ON CONFLICT` docs; "Idempotency keys" (Stripe); natural-key dedup in ETL (Kimball); "Surrogate vs natural key" CDC.

---

### LD4 — perf-caching-ease-of-use

**LD4-G1 — DuckDB has no native materialized views; "MV for common aggregations" is a misnomer.** Rank 3 (Moderate, cross-cutting OT11)
- **What:** LD4 lists "materialized views for common aggregations" as a first-class feature. DuckDB does not support `CREATE MATERIALIZED VIEW` (only plain `VIEW`). Workaround (per OT11) = cron-recompute into a table. Undeclared: recompute frequency, full-refresh cost over 90d×250k/d, staleness window between refreshes, and that an analyst querying during a refresh sees partial data.
- **Why missed:** LD4 states MV as if native; OT11 (different batch) flags the gap — cross-batch inconsistency the user hasn't reconciled.
- **Severity:** Moderate — UX/staleness surprise; full-refresh cost may exceed hourly budget at scale.
- **Mitigation:** Pre-aggregate at ingest time (write to `cmd_events` + `cmd_stats_hourly` in the same txn). OR incremental refresh keyed on `event_date ≥ max(processed_date)`. Document max staleness. Benchmark recompute cost before locking.
- **Sources:** DuckDB SQL dialect (no MATERIALIZED VIEW); PostgreSQL `CREATE MATERIALIZED VIEW` + `REFRESH CONCURRENTLY`; ClickHouse `AggregatingMergeTree` (incremental agg); dbt incremental models; "Pre-aggregation in OLAP" (Kylin/Druid).

**LD4-G2 — BATCH_SIZE×concurrency OOM risk; 500B/event is stored size, not working-set.** Rank 3 (Moderate)
- **What:** `BATCH_SIZE=10_000` × `MAX_CONCURRENT_SESSIONS=10` = 100k events in memory per ingest run. 500B/event is the *stored* row; the manual parser builds intermediate token arrays, `flags[]`, `positional_args[]`, AST-ish structures → realistic working set 2–5KB/event → 200–500MB live. Plus outbox row objects + DuckDB batch buffers. Node/Bun default heap 1.5–4GB; a single fat session (pi 147k/day) can blow this.
- **Why missed:** "500 bytes/event" conflates persisted size with parse-time residency.
- **Severity:** Moderate — OOM crash mid-batch; on restart, idempotent re-ingest (if LD2-G5 fixed) but wasted work + partial-progress opacity.
- **Mitigation:** Stream events via generators (don't hold full batch); cap concurrent *memory* not just session count; backpressure on heap high-water; set `--max-old-space-size`; measure working set per event before locking BATCH_SIZE.
- **Sources:** Reactive Streams backpressure spec; Node.js `--max-old-space-size` + V8 heap; p-limit / promise-pool concurrency control; "Memory pressure in batch ETL" (Spark tuning); DuckDB Appender batch sizing.

**LD4-G3 — DuckDB single-writer + no file lock = corruption if ingest runs twice or DB on NFS.** Rank 3 (Moderate, cross-cutting OT12)
- **What:** DuckDB is single-writer, multi-reader (OT12). LD4's "single CLI" ease-of-use doesn't address: cron-ingest overlapping a manual `oas-stats ingest`, two machines writing the same DB file (NFS/synced folder), or a stale writer process not yet released. No `flock`, no busy-retry, no "already running" guard. DuckDB on NFS is explicitly unsupported.
- **Why missed:** Single-CLI assumed single-invocation; concurrent invocation scenario ignored.
- **Severity:** Moderate — DB corruption (not just error); recovery = full re-ingest.
- **Mitigation:** `flock(LOCK_EX|LOCK_NB)` on DB file at startup; refuse if held; document single-writer + no-NFS; pidfile + staleness check.
- **Sources:** DuckDB concurrency model docs; SQLite "database is locked" / WAL; POSIX `flock(2)`; DuckDB "network filesystem unsupported" warning; "Single-writer embedded DB" ops runbooks.

**LD4-G4 — In-memory watermark checkpoint frequency undefined; crash = unbounded re-ingest.** Rank 3 (Moderate, cross-cutting LD2-G2)
- **What:** LD4 says "in-memory watermarks." Crash loses in-memory state; recovery reads the on-disk JSON. If checkpointed every N batches, crash re-ingests up to N batches. Acceptable IF outbox is idempotent (LD2-G5) — but wasteful, and if idempotency is broken (LD2-G5) it's data corruption.
- **Why missed:** "In-memory" framed as perf win without checkpoint contract.
- **Severity:** Moderate — wasted work (or worse, compounds LD2-G5).
- **Mitigation:** Checkpoint watermark per-batch inside the same DuckDB txn as the ingest commit (zero extra cost, atomic). Document crash-recovery semantics explicitly.
- **Sources:** Flink/Spark checkpointing; write-ahead logging; "at-least-once vs exactly-once"; DuckDB transactional DDL; "Idempotent retry" (AWS DynamoDB).

---

### OT13 — next-step-choice

**OT13-G1 — Decision dependency: OT1 (repo topology) is a precondition for OT13 path (1) OpenSpec change.** Rank 3 (Moderate)
- **What:** Path (1) "Capture as OpenSpec change (`/opsx:new oas-command-stats`)" presupposes a repo to put the change in. If OT1 is unresolved (separate repo vs integrated subcommand), the OpenSpec changeset target is ambiguous — can't write the change spec without knowing where the code lives.
- **Why missed:** OT1 and OT13 treated as independent threads; dependency unmodeled.
- **Severity:** Moderate — blocks path (1); rework if OT1 decided later.
- **Mitigation:** Resolve OT1 first. Decision DAG: OT1 → OT13.
- **Sources:** "Decision dependency graph" in design review (ADR literature); RFC process (Rust/IETF); "Set-based concurrent engineering" (Lean); "Last Responsible Moment" (Poppendieck).

**OT13-G2 — Locked decisions (LD2/LD4/LD5) pre-spike contradict path (2) "Spike DuckDB on real data."** Rank 3 (Moderate)
- **What:** Path (2) is empirical validation — but LD2 (watermarks), LD4 (perf/MV/batch), LD5 (outbox) are already LOCKED. The spike could reveal DuckDB lacks incremental MVs (OT11), single-writer limits (OT12), OOM at 100k concurrent (LD4-G2) — each contradicting a locked decision, yet the spike has no authority to unlock.
- **Why missed:** Decision ordering inconsistency — locking before validating.
- **Severity:** Moderate — wasted spike or forced redesign mid-build.
- **Mitigation:** Re-scope LD2/LD4/LD5 as "locked pending spike"; spike explicitly tests each locked assumption with pass/fail criteria; ADR per assumption.
- **Sources:** "Spike before commitment" (Agile); "Last Responsible Moment" (Lean); Real Options theory (software); ADR (Nygard); "Validation before lock" (Design-by-Contract).

**OT13-G3 — No exit criteria / timebox for path (3) "keep exploring."** Rank 2 (Minor)
- **What:** Path (3) has no termination condition. Could explore viz/args-semantics/cross-agent indefinitely. Decision debt accumulates; OT1 stays unresolved.
- **Why missed:** Exploration framed as open-ended.
- **Severity:** Minor — process drift.
- **Mitigation:** Time-box exploration (e.g. 1 sprint); define decision-trigger metrics (e.g. "explore until top-3 query patterns validated"); convert to ADR.
- **Sources:** "Time-boxed spikes" (XP/Agile); "Set-based concurrent engineering" (Lean); "Decision debt" (software eng); Real Options expiry; ADR status lifecycle.

**OT13-G4 — OpenSpec single-change format mismatch for a 13-OT + 5-LD system.** Rank 2 (Minor)
- **What:** OpenSpec `/opsx:new` targets one coherent change. This system has 13 open threads + 5 locked decisions spanning storage, parsing, ops, deployment — too large for one changeset. Forcing one spec = either a giant unreviewable change or loss of per-decision traceability.
- **Why missed:** Tool-shape mismatch with problem size.
- **Severity:** Minor — process friction, reviewability loss.
- **Mitigation:** Multiple OpenSpec changes (one per phase: ingestion-core, parsing, query/ops, deployment); or epic with linked changesets.
- **Sources:** OpenSpec changeset conventions; RFC decomposition (Rust RFCs); "Epic vs story" (Agile); ADR grouping; "Small batch changes" (Accelerate / Forsgren).

---

### Cross-cutting gotchas (apply to ≥2 items)

**X1 — Outbox retention (7d) < processing lag = silent data loss; no DLQ, no alerting.** Rank 4 (Significant, cross-cutting LD2/LD4/OT13/OT10)
- **What:** Outbox retention 7d (OT10). If processor is down >7d (machine off, crash loop, OOM per LD4-G2), pending rows age out before processing → permanent loss. No DLQ for `attempts`-capped failed rows; no alert when outbox depth grows.
- **Why missed:** Retention tuned for disk, not for availability SLA.
- **Severity:** Significant — silent permanent data loss; no detection signal.
- **Mitigation:** Outbox depth alert; DLQ for poison rows; retention > max-tolerable-downtime; reconcile scan (outbox pending vs analytics present) on startup.
- **Sources:** Debezium error handling / DLQ; Kafka retention vs consumer-lag; microservices.io outbox + "inbox pattern"; "Poison message" handling (SQS); AWS DLQ design.

**X2 — Partial-batch retry policy absent; `attempts` cap = stuck rows with no replay path.** Rank 3 (Moderate, cross-cutting LD2/OT13)
- **What:** ingestBatch: txn failure → "mark batch failed + increment attempts." No max-attempts defined, no backoff, no per-row isolation (one bad row fails whole batch forever), no manual replay command, no partial-success. A single malformed `raw_command` (e.g. binary garbage) blocks its entire 10k batch indefinitely.
- **Why missed:** All-or-nothing batch txn assumed rows are uniformly well-formed.
- **Severity:** Moderate — head-of-line blocking; one bad row stalls 10k.
- **Mitigation:** Per-row try/catch inside batch (quarantine bad row, commit rest); max-attempts + DLQ; `oas-stats replay --batch <id>`; exponential backoff; circuit-breaker on repeated failure.
- **Sources:** "Poison message" / DLQ (SQS/RabbitMQ); Debezium error-handling SMT; batch ETL partial-failure patterns (Spark); "Idempotent retry with backoff" (AWS SDK); Spring Batch skip/retry policies.

**X3 — Clock skew across 3 agents + 3 ts formats breaks both watermarks and time-of-day histograms.** Rank 4 (Significant, cross-cutting LD2/LD4/LD3)
- **What:** pi (ISO-8601, may lack tz offset), zcode (epoch-ms), hermes (epoch-ms) — on potentially different machines with NTP skew. Watermark comparison (`last_event_ts`) across formats is apples-to-oranges; "time-of-day histogram for cmd X" (LD3) mixes local-clock hours across machines; "above watermark" re-scan predicate misfires on skew.
- **Why missed:** Single `event_ts` field treated as uniformly comparable; no normalization layer documented.
- **Severity:** Significant — wrong histograms, wrong watermarks, wrong "recent" across agents.
- **Mitigation:** Normalize ALL ts to UTC epoch-ms at ingest boundary (single chokepoint). Detect skew (`event_ts` vs `ingest_ts` delta > threshold → flag). Store both `event_ts` (source) and `ingested_at` (UTC). Never order across agents by source clock.
- **Sources:** Google Spanner TrueTime / clock-skew in distributed systems; NTP skew bounds; "Event-time vs processing-time" (Flink/Beam); CDC ordering across sources (Debezium); Lamport clocks / "Time, Clocks, and the Ordering of Events" (Lamport).

**X4 — Adapter schema drift upstream (pi/zcode/hermes bump format) silently breaks parser.** Rank 4 (Significant, cross-cutting OT1/LD2/OT13)
- **What:** Three external sources evolve independently: pi adds event types (e.g. compaction), zcode schema bumps, hermes v6→v7. No schema-version pinning at ingest, no drift detection. When upstream changes, the adapter/parser either throws (good — loud) or silently produces wrong/missing fields (bad — silent data quality decay). Compounds OT1-G1 (if separate repo, oas-stats lags oas adapter fix).
- **Why missed:** Sources treated as stable; no version handshake.
- **Severity:** Significant — silent analytics corruption; the kind of bug that surfaces months later.
- **Mitigation:** Store `source_schema_version` per batch; validate incoming shape against a pinned schema; fail-loud on unknown fields (don't drop silently); schema registry / contract per agent; smoke-test ingest after any oas adapter bump.
- **Sources:** Schema registry (Confluent); "Backward/forward compatibility" (Avro/Protobuf); Pact consumer contracts; "Fail loud, not silent" (SRE postmortem culture); Debezium schema evolution.

---

## Residual risks
- LD2-G1 (rank 5) is the highest-leverage gap: ts-based watermark is architecturally unsound for non-monotonic multi-source data; without re-grounding on event_id idempotency, ingestion correctness is not provable.
- X3 (clock skew) + LD2-G1 compound: cross-source ts comparison is invalid a priori.
- LD2-G2 + LD4-G4 compound: watermark persistence is the SPOF for both correctness (skip oracle) and recovery (crash window).
- No end-to-end reconciliability: nothing in the design lets an operator answer "did I lose events?" — outbox depth vs analytics count vs source-file line count should reconcile; design has no such invariant.

---