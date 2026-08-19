I have sufficient evidence. (Note: no web-search tool is available on this host — `sergnx`/`exa`/`bing` not on PATH — so citations are canonical doc titles + stable documentation URLs, which the task explicitly permits. The "250k/day" assumption is unvalidated: locally there are 9,350 pi JSONL sessions and a 2.97 GB zcode SQLite DB, yet the design cites no measurement.)

---

# Review — Storage / DB Architecture Gotchas

## OT2 — which-db-framework (DuckDB vs TimescaleDB / ClickHouse / SQLite)

### GOTCHA OT2-1 — DuckDB on-disk format is NOT backward/forward-stable across versions
- **rank**: 5
- **what**: DuckDB explicitly does not guarantee that a `.duckdb` file written by one release is readable by another. Upgrades routinely require `EXPORT DATABASE` / `IMPORT DATABASE` (or PRAGMA-based dump). For a retention system that keeps "90 days" (and the stated long-history drill-down use case), every `duckdb` npm major bump is a forced data migration.
- **why_missed**: Design treats DuckDB as a drop-in SQLite replacement and never evaluated multi-year file-format stability. It compared only on speed/size, not on storage-format lifecycle.
- **severity**: Fundamental for a long-lived analytics store — silent "file unreadable" on upgrade; data effectively locked to one binary version.
- **mitigation**: Plan a versioned migration path (export/import on upgrade), or store raw events in Parquet (format-stable, version-agnostic) and let DuckDB query it; keep DuckDB only for transient/derived tables.
- **sources**:
  - DuckDB Docs — "Importing Data / Storage format" / GitHub FAQ "Upgrading DuckDB / database version"
  - SQLite Docs — "Database File Format" (the "format is stable since 2004" guarantee, the inverse benchmark)
  - Apache Parquet Format Specification (parquet.apache.org)
  - M. Kleppmann, *Designing Data-Intensive Applications*, Ch.3 (evolvability / schema-on-read formats)

### GOTCHA OT2-2 — Outbox workload is OLTP (point UPDATEs) on an OLAP engine
- **rank**: 4
- **what**: The outbox table is a state machine: `status pending→processing→processed→failed`, `attempts++`, `last_error` updates, plus a `DELETE` prune every 7d. DuckDB is optimized for bulk append + analytical scan; per-row UPDATE/DELETE requires rewriting data and is its weakest operation. SQLite would be workload-appropriate here.
- **why_missed**: "Unified (one tool)" was optimized for developer simplicity, not for matching the engine to the workload. The trade-off between two storage engines vs. one misapplied engine was never stated.
- **severity**: Likely; ingestion runs continuously. Degraded point-update throughput, growing dead-tuple space, slowing prune.
- **mitigation**: Keep the outbox on SQLite (OLTP) and analytics on DuckDB (OLAP); or make the outbox append-only (immutable event log) so DuckDB's strength applies to both.
- **sources**:
  - DuckDB Docs — "DuckDB's execution model" / GitHub discussions on UPDATE/DELETE performance
  - SQLite Docs — "Write-Ahead Logging" (OLTP strengths)
  - *Designing Data-Intensive Applications*, Ch.3 (columnar vs row storage, OLAP vs OLTP)
  - microservices.io — "Transactional Outbox Pattern"

### GOTCHA OT2-3 — Parquet+DuckDB (the natural fit) was never considered
- **rank**: 3
- **what**: The user explicitly suggested "timeseries db, timescale…". A canonical low-ops pattern for this exact workload is append raw events to **Parquet** files (partitioned by date/agent) and query them with DuckDB — no server, format-stable, multi-process-safe appends (one writer file at a time), trivial archiving (just delete old files). The design jumped straight to a single mutable `.duckdb` file.
- **why_missed**: The "framework" exploration collapsed to "which single embedded DB" instead of "which storage primitives compose best".
- **severity**: Moderate; the single-file choice propagates into OT9/OT11/OT12 problems (locking, MV refresh, multi-process) that a Parquet-on-DuckDB design sidesteps.
- **mitigation**: Evaluate Parquet partitioned by `event_date` for raw storage; DuckDB for the (rebuildable) analytics/derived tables.
- **sources**:
  - DuckDB Docs — "Data Import / Parquet Import" and "Parquet" extensions
  - Apache Parquet — "Partitioning" guidance
  - TimescaleDB Docs — "Hypertable partitioning" (the relational equivalent of file partitioning)
  - dbt Docs — "External sources / external tables"

### GOTCHA OT2-4 — Dismissing TimescaleDB/Postgres ignores the MV + concurrency the design itself needs
- **rank**: 3
- **what**: The design later requires incremental materialized views (OT11) and concurrent readers (OT12) — both of which PostgreSQL/TimescaleDB provide natively (`REFRESH MATERIALIZED VIEW CONCURRENTLY`, MVCC multi-writer, continuous aggregates). The framework choice in OT2 is made before OT11/OT12 requirements are resolved, so the comparison is incomplete.
- **why_missed**: Open threads were evaluated in isolation; OT2's "server process = overhead" framing predates discovering that DuckDB lacks the very features OT11/OT12 need.
- **severity**: Moderate — the dismissed option is the one that solves two downstream open threads.
- **mitigation**: Re-run the framework comparison *after* OT11/OT12 are answered, scoring each option against the required MV and concurrency semantics.
- **sources**:
  - PostgreSQL Docs — "Materialized Views" + `REFRESH MATERIALIZED VIEW CONCURRENTLY`
  - TimescaleDB Docs — "Continuous Aggregates"
  - DuckDB Docs — (absence of) `CREATE MATERIALIZED VIEW`
  - ClickHouse Docs — "Materialized Views" (incremental, insert-driven)

### GOTCHA OT2-5 — bashlex dependency is Python; the stack is Node/DuckDB-native (cross-cutting OT2)
- **rank**: 2
- **what**: `bashlex` is a Python package; the rest of the stack is TypeScript + DuckDB. This reintroduces a Python runtime, per-parse subprocess overhead, and a packaging/version hazard (python3 + pip at deploy). Not a DB gotcha per se, but it inflates the framework surface the storage choice is supposed to *reduce*.
- **why_missed**: "DuckDB = single dependency, simple" claim is undermined by dragging in a Python interpreter.
- **severity**: Minor — works, but contradicts the simplicity justification and adds an operational moving part.
- **mitigation**: Prefer a Node-native parser (`mrmissed`-class shell-tokenizer) or parse inside DuckDB/SQL UDFs; reserve Python+bashlex for a background accuracy-verification job.
- **sources**:
  - bashlex — PyPI/docs (Python-only AST library)
  - POSIX.1-2017 — "Shell Command Language" (the grammar a tokenizer must handle)
  - Node ecosystem — `shell-quote` / `split-cmd` tokenizers
  - DuckDB Docs — "Function APIs / UDFs" (in-DB parsing)

---

## OT3 — scale-target (250k/day → 90M/year)

### GOTCHA OT3-1 — The 250k/day figure is unvalidated; the whole architecture is sized to it
- **rank**: 4
- **what**: No measurement supports 250k events/day. Real local footprint: 9,350 pi JSONL sessions + a 2.97 GB zcode SQLite DB on a single machine, with no per-event count. If true volume is 10× (multi-agent, every tool call, every subagent), single-writer DuckDB + per-row idempotent insert saturates; if 0.1×, the MV/outbox/cron machinery is unjustified complexity.
- **why_missed**: A target was assumed rather than instrumented; the design has no "measure first" phase.
- **severity**: Significant — the central sizing, retention, and concurrency decisions all rest on this one unverified number.
- **mitigation**: Add a measurement step (count candidate events across all adapters for a representative week) *before* locking the stack; design for a 10× headroom only if measured volume justifies it.
- **sources**:
  - *Designing Data-Intensive Applications*, Ch.1 ("First principles / describe the load before choosing tech")
  - Google SRE Book — "Service Level Objectives" (measure, then size)
  - SQLite / DuckDB benchmark docs — write-throughput vs dataset size curves
  - Martin Fowler — "Capacity planning / YAGNI vs measure-first"

### GOTCHA OT3-2 — Per-row `INSERT … ON CONFLICT (id) DO NOTHING` is an OLTP anti-pattern on DuckDB at scale
- **rank**: 4
- **what**: The idempotency loop does a point lookup against a `TEXT PRIMARY KEY` index for each of 90M rows. DuckDB's strength is bulk `COPY`; per-row UPSERT with a text-hash PK is the slow path. Sustained 250k/day of single-row idempotent inserts will not keep up, and `--force` backfills will take far longer than expected.
- **why_missed**: The transaction code was written for correctness, not throughput; no insert-throughput estimate accompanies the 90M-row projection.
- **severity**: Significant for correctness-of-SLO (ingestion falls behind real time → stale stats).
- **mitigation**: Batch-dedupe in memory before insert; prefer bulk `COPY` into a staging table + set-based dedupe; or rely on per-session watermarks (no re-ingest) to avoid UPSERT entirely.
- **sources**:
  - DuckDB Docs — "Data Ingestion / Bulk Insert vs INSERT" (COPY benchmark)
  - *Designing Data-Intensive Applications*, Ch.3 (LSM-trees / point lookups vs scans)
  - SQLite Docs — "INSERT ON CONFLICT / UPSERT" (the engine this pattern was designed for)
  - ClickHouse Docs — "INSERT performance" (why OLAP engines batch)

### GOTCHA OT3-3 — "Archive analytics > 90d" has no defined archive destination
- **rank**: 3
- **what**: Retention says prune outbox 7d, "archive analytics > 90d" — but archive to where? If deleted, the use case ("stats overview → drill down to the exact session") loses older history; the design simultaneously implies long history is valuable. The retention choice and the use case are in tension.
- **why_missed**: Retention was listed as an "open question" but its interaction with the documented drill-down use case wasn't reconciled.
- **severity**: Moderate — silently loses data the user later asks for, or grows unbounded if "archive" means "keep forever".
- **mitigation**: Define the archive target (cold Parquet on disk / object store / re-derivable from source logs) and tie retention to a concrete recovery path.
- **sources**:
  - microservices.io — "Event Sourcing / retention & compaction"
  - *Designing Data-Intensive Applications*, Ch.11 (log compaction, retention)
  - TimescaleDB Docs — "Data retention / compression policies"
  - Apache Parquet — "Columnar archival storage"

### GOTCHA OT3-4 — Hourly MV recompute cost is O(table size), not bounded (cross-cutting OT11)
- **rank**: 4
- **what**: `cmd_stats_hourly` and `cmd_flag_stats` are `CREATE TABLE … AS SELECT … GROUP BY` over the full `cmd_events`. At 90M rows, an hourly full-scan + GROUP BY (and `unnest(flags)` row-explosion in the second MV) is not a cheap cron job; the design gives no cost estimate. Recompute cost *grows every day* with no ceiling.
- **why_missed**: "Recompute hourly via cron" was presented as a one-liner workaround, not costed.
- **severity**: Significant at the stated scale — the MVs meant to *speed up* queries become the slowest operation in the system.
- **mitigation**: Windowed recompute (only `event_ts > last_mv_ts`), time-partitioned tables, or an engine with real incremental MVs.
- **sources**:
  - PostgreSQL Docs — `REFRESH MATERIALIZED VIEW CONCURRENTLY` (incremental contrast)
  - TimescaleDB Docs — "Continuous Aggregates" (incremental, bounded refresh)
  - ClickHouse Docs — "Materialized Views" (insert-triggered, incremental)
  - dbt Docs — "Incremental models" (watermark-based incremental)
  - *Designing Data-Intensive Applications*, Ch.11 (incremental aggregation)

### GOTCHA OT3-5 — 10× compression / 500B-per-event are optimistic, unvalidated estimates
- **rank**: 2
- **what**: 45 GB raw → 4.5 GB relies on ~10× compression and a flat ~500B/event. But `raw_command` (full command strings) and high-cardinality `cwd`/`session_id` compress poorly; a single 2KB command blows the per-event average. The sizing feeds disk/retention decisions.
- **why_missed**: Compression ratio was asserted, not measured on real payloads; columnar compression depends heavily on cardinality, which is unknown.
- **severity**: Minor to moderate — wrong sizing → wrong retention thresholds → premature pruning.
- **mitigation**: Measure real per-event bytes and DuckDB compression on a representative sample before sizing retention.
- **sources**:
  - DuckDB Docs — "Compression" (per-column encoding; depends on cardinality)
  - Apache Parquet — "Encodings / Dictionary / RLE"
  - *Designing Data-Intensive Applications*, Ch.3 (column compression vs cardinality)
  - Zstd/RLE literature (compression ratio vs entropy of data)

---

## OT9 — outbox-storage-choice (DuckDB unified)

### GOTCHA OT9-1 — "Single unified file" contradicts the repository layout (two files) and breaks the one-transaction claim
- **rank**: 4
- **what**: The idempotency code wraps outbox-UPDATE + analytics-INSERT in a *single* `db.transaction()`, which only works if both tables are in one DB/connection. But the repo structure lists `outbox.duckdb` and `cmd_events.duckdb` as **two separate files**. Cross-file transactions are impossible in DuckDB → either the atomicity claim is false or the layout is wrong. The two artifacts disagree.
- **why_missed**: Code sample and file layout were written separately; no one verified a cross-file transaction is achievable.
- **severity**: Significant — correctness: a crash between the two stores can mark outbox `processed` without the analytics row (or vice-versa), defeating the outbox guarantee.
- **mitigation**: Either merge into one file (and accept OT9-3 contention) or make the two-phase update explicitly idempotent + reconcilable (replay-safe across files).
- **sources**:
  - DuckDB Docs — "Transactions" (per-connection, single-DB scope)
  - microservices.io — "Transactional Outbox Pattern" (atomicity requirement)
  - *Designing Data-Intensive Applications*, Ch.7 (atomicity & two-phase concerns)
  - PostgreSQL/SQLite Docs — ATTACH/`PRAGMA` cross-DB limitations

### GOTCHA OT9-2 — `status='processing'` has no lease/owner → crash orphans rows forever
- **rank**: 4
- **what**: A row set to `status='processing'` and never updated (process killed mid-batch) is stuck forever: the cleanup only prunes `status='processed'`, and re-ingestion sees nothing new (watermark unchanged or partially advanced). There is no `processing_started_at` lease, no owner id, no reaper.
- **why_missed**: Failure path of the state machine was omitted; only the happy path (pending→processing→processed) was modeled.
- **severity**: Significant for correctness — silently stuck events under any crash.
- **mitigation**: Add a lease (`processing_started_at` + timeout) and a reaper that resets stale `processing` rows back to `pending`.
- **sources**:
  - microservices.io — "Outbox / message relay with lease & retry"
  - *Designing Data-Intensive Applications*, Ch.11 (consumer offsets, idempotent retry)
  - RabbitMQ/Kafka Docs — "dead-letter / visibility timeout" (the same lease concept)
  - SQLite Docs — "Async processing / crash recovery"

### GOTCHA OT9-3 — Outbox prune (`DELETE … age>7d`) on DuckDB doesn't reclaim space without explicit rebuild
- **rank**: 3
- **what**: DuckDB `DELETE` marks rows removed but does not automatically shrink the file; without `CHECKPOINT`/`VACUUM` the outbox file keeps dead tuples and grows. The 7-day prune runs continuously, so dead-tuple accumulation is steady. SQLite has the same need but its VACUUM story is well-understood; DuckDB's checkpointing-on-delete semantics are murkier.
- **why_missed**: Prune was added without a compaction/cleanup step.
- **severity**: Moderate — disk bloat, and possibly slower scans over dead regions.
- **mitigation**: Schedule explicit `CHECKPOINT`/`VACUUM` after prune, or partition the outbox by day (drop old partitions instead of DELETE).
- **sources**:
  - DuckDB Docs — "Statements / Checkpoint", "VACUUM"
  - SQLite Docs — "VACUUM", "Free pages"
  - PostgreSQL Docs — "VACUUM" (the OLTP analogue)
  - *Designing Data-Intensive Applications*, Ch.3 (compaction in LSM/columnar stores)

### GOTCHA OT9-4 — "Decouples extraction from transformation" is undermined when outbox + analytics share one writer
- **rank**: 3
- **what**: The outbox's stated benefit is decoupling scan (extract) from process (transform). But with both tables in DuckDB under the single-writer model, a long processor transaction holding the write lock blocks concurrent scans/writes to the outbox — so extraction cannot proceed in parallel. The decoupling is logical, not operational.
- **why_missed**: Decoupling was argued at the *pattern* level without checking the *engine's* concurrency support actually delivers it.
- **severity**: Moderate — under load, extraction stalls behind transformation (or vice-versa).
- **mitigation**: Separate files/processes with a real queue, or an engine with multi-writer MVCC.
- **sources**:
  - microservices.io — "Transactional Outbox" (independent consumer pacing)
  - DuckDB Docs — "Concurrency" (single-writer limitation)
  - *Designing Data-Intensive Applications*, Ch.11 (decoupling via log/queue)
  - Kafka Docs — "Consumer groups / independent throughput"

### GOTCHA OT9-5 — Outbox row `id = hash(agent:alias:session_id:event_id)` — collision & determinism unstated
- **rank**: 2
- **what**: `id` is a hash over 4 fields and serves as PRIMARY KEY + idempotency key. The hash algorithm, length, and collision policy are unspecified. A weak/fast hash over long concatenated strings risks collisions (two distinct events → same `id` → silent drop via `ON CONFLICT DO NOTHING`). Also, if any input field encoding is inconsistent (e.g. session_id case/path normalization drift across adapters), the same event hashes differently and gets ingested twice.
- **why_missed**: `id` design was treated as an implementation detail, not as the correctness foundation of idempotency.
- **severity**: Minor normally, but a single collision = silent data loss — exactly the failure the outbox exists to prevent.
- **mitigation**: Specify the hash (e.g. SHA-256, truncated with documented bits), canonicalize inputs before hashing, and prefer a natural composite key.
- **sources**:
  - NIST FIPS 180-4 — SHA-2 (collision-resistance guarantees)
  - *Designing Data-Intensive Applications*, Ch.6 (idempotency keys, hash distribution)
  - DuckDB/SQLite Docs — composite UNIQUE constraints as an alternative to hashing
  - microservices.io — "Idempotent consumer / message deduplication"

---

## OT11 — incremental-materialized-views (recompute hourly via cron)

### GOTCHA OT11-1 — "Materialized views" are actually plain tables → no freshness contract (cross-cutting OT3)
- **rank**: 3
- **what**: DuckDB has no `CREATE MATERIALIZED VIEW`; the design uses `CREATE TABLE … AS SELECT`. So they are static snapshots, refreshed only by cron. Queries like "what ran in the last 24h" would hit up-to-1h-stale data — meaning the MV is useless for the very "recent" use cases; users must query the raw table anyway, so the MV adds maintenance cost without freshness.
- **why_missed**: DuckDB lacks native MVs, so a `TABLE` was substituted without re-examining whether stale snapshots serve the documented "recent commands" queries.
- **severity**: Moderate — MVs exist but don't serve the primary (recent) queries; their value is unclear.
- **mitigation**: Define which queries use the snapshot vs. the raw table; make the cron interval match the freshness those queries need.
- **sources**:
  - DuckDB Docs — "Views" (only logical views, no materialized)
  - PostgreSQL Docs — "Materialized Views"
  - ClickHouse Docs — "Materialized Views" (live, insert-driven)
  - TimescaleDB Docs — "Continuous Aggregates" (real-time)

### GOTCHA OT11-2 — Refresh has no atomic swap → empty/missing MV window during recompute
- **rank**: 3
- **what**: Recomputing via DROP/CREATE or `CREATE OR REPLACE` leaves a window where the MV is absent or empty; concurrent query processes hit missing/empty tables. No `RENAME`-swap or shadow-table pattern is described, and DuckDB table redefinition isn't transactional w.r.t. concurrent readers.
- **why_missed**: Concurrency during refresh wasn't considered; recompute was assumed to be instantaneous and isolated.
- **severity**: Moderate — intermittent empty-result queries, hardest class of bug to reproduce.
- **mitigation**: Build into a shadow table, then atomic `ALTER TABLE … RENAME` in a transaction.
- **sources**:
  - PostgreSQL Docs — `REFRESH MATERIALIZED VIEW CONCURRENTLY` (atomic refresh)
  - DuckDB Docs — "ALTER TABLE / RENAME", "Transactions"
  - dbt Docs — "Snapshots / atomic model replacement"
  - *Designing Data-Intensive Applications*, Ch.5 (atomic switchover)

### GOTCHA OT11-3 — `unnest(flags)` row-explosion makes `cmd_flag_stats` recompute cost opaque
- **rank**: 3
- **what**: `unnest(flags)` multiplies rows (an event with N flags → N rows). At 90M events with avg several flags each, the flag-stats aggregation works over several-hundred-million rows hourly. Also events with *no* flags vanish entirely under `unnest` (CROSS semantics), skewing any "fraction of commands with flags" query.
- **why_missed**: UNNEST cost and empty-set semantics weren't analyzed.
- **severity**: Moderate — refresh cost underestimated + subtle counting bias.
- **mitigation**: Pre-aggregate flags per insert; use `LEFT JOIN ... unnest` or a separate `has_flags` count to preserve zero-flag events.
- **sources**:
  - DuckDB Docs — "UNNEST / list & struct functions"
  - PostgreSQL Docs — "UNNEST / lateral" (same explosion caveat)
  - ClickHouse Docs — "arrayJoin" (analogous row-explosion)
  - *Designing Data-Intensive Applications*, Ch.11 (pre-aggregation)

### GOTCHA OT11-4 — No MV-level watermark → true incremental refresh is impossible
- **rank**: 3
- **what**: To do incremental refresh you need the MV to remember its own "last processed event_ts". The design has ingestion watermarks but no MV watermark, and the refresh is full-recompute. So the "Alternative: dbt incremental models" is mentioned but the data model gives dbt nothing to increment on cleanly (no reliable monotonic column on the derived table).
- **why_missed**: Ingestion watermark ≠ MV watermark; conflating the two skipped the MV bookkeeping.
- **severity**: Moderate — locks the system into full-recompute forever.
- **mitigation**: Persist a `mv_last_event_ts` per MV; refresh only `event_ts > mv_last_event_ts` and merge.
- **sources**:
  - dbt Docs — "Incremental models (watermark/unique-key strategy)"
  - TimescaleDB Docs — "Continuous Aggregates" (built-in watermark)
  - ClickHouse Docs — "AggregatingMergeTree / state retention"
  - *Designing Data-Intensive Applications*, Ch.11 (incremental view maintenance)

---

## OT12 — multi-process-safety (single-writer, multi-reader)

### GOTCHA OT12-1 — "Single ingestion process" is unenforced — no flock/PID file/advisory lock
- **rank**: 4
- **what**: Nothing prevents two `oas-stats ingest` runs overlapping (cron overlap, manual + scheduled, zombie process). DuckDB does NOT serialize writers via OS file locking the way SQLite's WAL does — concurrent writers from different processes raise errors or, depending on version/mode, risk the file. The design relies on operator discipline, not enforcement.
- **why_missed**: "Single ingestion process" was stated as an architectural *assumption* but never backed by a *mechanism*.
- **severity**: Significant — concurrency bugs under overlap, exactly when ops is most likely to double-run (retries, cron drift).
- **mitigation**: `flock` / PID file / advisory lock around the whole run; or an engine with real cross-process write locking.
- **sources**:
  - DuckDB Docs — "Concurrency" (cross-process write semantics)
  - SQLite Docs — "File Locking" / "How To Corrupt" (what proper locking prevents)
  - Linux `flock(2)` man page / POSIX advisory locks
  - *Designing Data-Intensive Applications*, Ch.8 (distributed locks / single-writer enforcement)

### GOTCHA OT12-2 — Query processes open read_write by default → they contend for the write lock
- **rank**: 4
- **what**: DuckDB opens a file read_write unless `access_mode='read_only'` is set. A "query process" opened normally competes for the single write lock and can block ingestion or fail. The design says "multiple query processes" but never mandates `read_only` connections for them.
- **why_missed**: The read-only requirement for readers wasn't translated into connection config.
- **severity**: Significant — readers silently degrade/contend with the writer; intermittent "database locked"-style errors.
- **mitigation**: Force `access_mode='read_only'` (or `read_only=true`) for every query connection; document it as a hard rule.
- **sources**:
  - DuckDB Docs — "Configuration / access_mode" and "Read-only connections"
  - SQLite Docs — "Read-only database connections"
  - PostgreSQL Docs — "Hot standby / read-only replicas" (read-only pattern)
  - DuckDB GitHub Issues — concurrent access/locking behavior by version

### GOTCHA OT12-3 — DuckDB concurrency semantics are version-dependent; the design treats them as a stable contract
- **rank**: 3
- **what**: DuckDB's cross-process read/write behavior has shifted across versions (which connections can coexist, checkpoint-vs-reader behavior, error types). The design asserts "single-writer, multi-reader" as fixed, but the actual guarantees depend on the installed `duckdb` version + access mode. With the npm client pinned to `^0.10.0` (allows minor/patch drift), behavior can change between installs.
- **why_missed**: Version-pinning was loose (`^0.10.0`) while assuming stable concurrency semantics.
- **severity**: Moderate — subtle behavior change on an `npm update` → hard-to-diagnose locking failures.
- **mitigation**: Pin exact DuckDB version; add a concurrency-contract test that fails on regression; document the required access modes per connection type.
- **sources**:
  - DuckDB Docs/GitHub — per-version concurrency changelog
  - SQLite Docs — "WAL mode" (the stable baseline for comparison)
  - *Designing Data-Intensive Applications*, Ch.1 (versioning & stability of primitives)
  - npm semver docs — `^` caret range semantics

### GOTCHA OT12-4 — Writer `CHECKPOINT` vs active readers interaction unaddressed (cross-cutting OT9)
- **rank**: 3
- **what**: DuckDB checkpoints (auto and manual) rewrite the DB file and merge the WAL. A checkpoint while read-only readers are attached can stall them or error; conversely long readers can prevent checkpointing, letting the WAL grow (disk + memory pressure). At 250k/day sustained writes, WAL growth between checkpoints is non-trivial and the design gives no checkpoint policy.
- **why_missed**: WAL lifecycle and checkpoint/readers interaction weren't part of the performance table.
- **severity**: Moderate — WAL bloat or reader stalls under load.
- **mitigation**: Define a checkpoint policy (e.g., force checkpoint after each ingest run when no readers, or off-peak), monitor WAL size.
- **sources**:
  - DuckDB Docs — "Statements / Checkpoint", "WAL"
  - SQLite Docs — "Write-Ahead Logging" + "checkpoint starvation"
  - PostgreSQL Docs — "Checkpoints and WAL" (the OLTP analogue)
  - *Designing Data-Intensive Applications*, Ch.3 (LSM/WAL compaction)

### GOTCHA OT12-5 — `watermarks.json` is a non-atomic single file → crash corrupts the ingestion cursor
- **rank**: 4
- **what**: The high watermark is the correctness-critical cursor, but it's stored as a plain JSON file written in-place. A crash/power-loss during write → truncated/partial JSON → on restart ingestion resumes from a wrong point → either re-processes (wasteful, relies on idempotency) or, worse, *skips* events if the file parses as a stale-but-valid value. No atomic write (temp+rename), no checksum, no backup.
- **why_missed**: Watermark durability was treated as a trivial "persist to disk", not as the single source of truth it actually is.
- **severity**: Significant for correctness — silent data loss or duplication on any unclean exit.
- **mitigation**: Atomic write (write `.tmp` then `fsync` + `rename`); consider storing watermarks inside the DB transaction alongside the data they protect, so they commit together.
- **sources**:
  - SQLite Docs — "How To Corrupt / Atomic Write" / `rename(2)` durability
  - POSIX `rename(2)` / `fsync(2)` man pages (atomic replace semantics)
  - *Designing Data-Intensive Applications*, Ch.7 (atomic commit / write-ahead for state)
  - PostgreSQL Docs — "commit log / clog durability" (why cursors belong in the DB)

### GOTCHA OT12-6 — No defined behavior when watermark advances but analytics insert partially failed
- **rank**: 3
- **what**: The flow updates the watermark *after* the batch, using `events[last].ts`. If the batch partially committed (some rows ok, some `failed`), the watermark still jumps past events whose analytics rows were never written. The `attempts`/`failed` retry path exists, but the watermark has already moved — there's no reconciliation between "events past the watermark" and "events stuck in `failed`".
- **why_missed**: Watermark and outbox-status were designed independently; their interaction on partial failure wasn't traced.
- **severity**: Moderate — permanently lost events on partial failure (the failed rows sit forever, never re-scanned because watermark passed them).
- **mitigation**: Advance watermark only to `min(ts)` of *successfully processed* rows; reconcile `failed`/`pending` rows explicitly on each run.
- **sources**:
  - microservices.io — "Outbox relay / exactly-once with offset commits"
  - Kafka Docs — "Consumer offset commit semantics" (offset vs delivery)
  - *Designing Data-Intensive Applications*, Ch.11 (consumer offsets & idempotent processing)
  - dbt/ETL patterns — "watermark = last committed, not last seen"

---

## Cross-cutting gotchas (apply to multiple OTs)
- **CC-1 DuckDB file-format instability** (OT2-1, OT3): affects any multi-year retention built on a mutable `.duckdb` file.
- **CC-2 OLTP workload on OLAP engine** (OT2-2, OT9-1/9-3, OT12): point updates, deletes, pruning, UPSERTs are all DuckDB's weak path; the whole outbox lifecycle is OLTP.
- **CC-3 Crash recovery gaps** (OT9-2, OT12-5, OT12-6): no lease on `processing`, no atomic watermark write, no partial-failure reconciliation — three independent crash-corruption paths.
- **CC-4 Unvalidated scale number** (OT3-1, OT3-5, OT11): 250k/day, 500B/event, 10× compression, MV recompute cost — all sized to one unmeasured figure.
- **CC-5 Concurrency is assumed, not enforced** (OT12-1, OT12-2, OT9-4): single-writer is an assertion with no lock, and readers default to read_write.

---