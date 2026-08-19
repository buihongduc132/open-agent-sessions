Read-only review. `plan.md`/`progress.md` absent at given paths — design context came from task brief verbatim (cross-confirmed in `.pi-subagents/artifacts/88697cea-...reviewer_2_input.md:21-36`). Web probes (Datadog/Loki/Elastic/OpenSearch/Filebeat doc URLs) returned 200s; Splunk docs blocked (403). Findings below.

---

## Review — OPS / USE-CASE / QUERY batch

Scope: gotchas MISSED in LD1, LD3, OT4, OT10, OT13. Severity: Low/Med/High/Critical. Rank: sophistication scale (1=YAGNI…5=Sophisticated). `[X-CUT]` = cross-cutting.

### LD1 — programmatic-only-no-ui

**LD1-G1** [rank 5, severity High] [X-CUT:PII]
- **title**: Secrets/PII in command args have no redaction path; SQL-only surface makes masking unverifiable
- **what**: Bash invocations routinely embed secrets inline — `curl -H "Authorization: Bearer sk-..."`, `AWS_ACCESS_KEY_ID=AKIA...`, tokens in URLs (`?token=...`), `sshpass -p`, `git+https://user:pw@host`). Design stores `command` raw (LD3 "args for git" query). No PII classifier, no hash/redact stage. Datadog SDS ships Redact/Partially-redact/Hash/Mask on Logs/APM/RUM as first-class.
- **why_missed**: LD1 frames UI as the only out-of-scope surface; treats PII as a "later" concern. But masking is an ingestion concern, not a UI concern — decisions made before first row lands.
- **mitigation**: Add an ingestion-stage tokenizer-regex rule (credit-card / `Bearer \S+` / AKIA keys / env-assigns named `*TOKEN*|*KEY*|*SECRET*|*PASSWORD*`) with redact-on-write. Add `cmd_hash` column for joinable-but-reversible correlation. Document the redaction list in the spec.
- **sources**: `https://docs.datadoghq.com/security/sensitive_data_scanner.md` (Redact/Hash/Mask matrix, PII/credentials/credit-card coverage); Elastic ingest pipeline grok processors `https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html`; OpenSearch field-level masking `https://opensearch.org/docs/latest/im-plugin/ism/policies/`; Filebeat regex processors `https://www.elastic.co/guide/en/beats/filebeat/current/filebeat-input-log.html`; OWASP log-injection secrets guidance.

**LD1-G2** [rank 4, severity High]
- **title**: Schema migration = manual SQL scripts with no UI safety net; DuckDB DDL is limited
- **what**: "No UI" means every schema change (new column, new aggregate, type fix) is an out-of-band `ALTER TABLE`/migration script. DuckDB supports ALTER but has no built-in migration runner, no online-rebuild, no rollback UX. Compare ES aliases + ILM rollover (atomic index swap) or Splunk indexes (per-index isolation lets schema evolve by index). Operators hitting a bad migration cannot self-recover without SQL.
- **why_missed**: Design locks UI out without costing the migration-ergonomics loss. v1 schemas always drift by v2.
- **mitigation**: Define a `schema_version` table + `migrate()` entrypoint invoked on every ingest. Treat outbox (7d, OT10) as the rebuild source-of-truth so analytics can be dropped + re-derived. Add forward-compat: every query selects by name (never `SELECT *`).
- **sources**: Elastic ILM phases hot/warm/cold/frozen/delete (rebuild via alias swap) `https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html`; Loki per-stream/per-tenant retention isolation `https://grafana.com/docs/loki/latest/operations/storage/retention/`; DuckDB `ALTER TABLE` docs (limited online DDL); OpenSearch reindex `https://opensearch.org/docs/latest/im-plugin/ism/policies/`; Datadog index filters (per-index schema evolution) `https://docs.datadoghq.com/logs/log_configuration/indexes.md`.

**LD1-G3** [rank 3, severity Medium]
- **title**: SQL-only query surface is hostile to ops-under-pressure; no saved queries / history / autocompletion
- **what**: Real incident workflow ≠ `oas-stats query --last 24h --by program` typed cold. Ops reach for muscle memory: saved searches, command history, aliases, `!!`-reruns. SQL-only erases that. Datadog "Saved Views", Kibana "Saved Objects", Splunk "Saved Searches" all exist precisely because ad-hoc SQL is wrong when on call.
- **why_missed**: LD3 lists 6 example queries but no stateful shell — `oas-stats query` is stateless each invocation.
- **mitigation**: Add `oas-stats query --save <name>` / `--list` / `--rerun` and a `~/.config/oas-stats/history.jsonl`. Cheap; pays back first incident.
- **sources**: Datadog Saved Views in Log Explorer `https://docs.datadoghq.com/logs/explorer/live_tail.md`; Kibana Saved Objects (well-known ES feature); Splunk Saved Searches; Loki LogQL macros; Honeycomb saved queries `https://docs.honeycomb.io/configure/datasets/manage/`.

### LD3 — sysops-query-tailoring

**LD3-G1** [rank 4, severity High] [X-CUT:PII]
- **title**: Time-of-day histogram has no defined timezone or bin size
- **what**: "time-of-day histogram for cmd X" buckets hour-of-day — but hour-of-day needs a tz (UTC vs host-tz vs analyst-tz vs DST). pi logs use local-time filenames + ISO UTC `nowIso()` (mixed!). zcode/hermes store epoch-ms (UTC-implied but host-clock dependent). Without an explicit tz policy, the histogram silently buckets wrong. Grafana ships explicit per-dashboard tz selector (UTC/browser/named) — design has none.
- **why_missed**: "time-of-day" treated as obvious; the mixed-format source-timestamp reality (ISO-8601 pi vs epoch-ms zcode/hermes, per reviewer_3_input.md:41) was not carried into query semantics.
- **mitigation**: Persist `ts_utc` (canonical) + `host_tz_offset`. Histogram query takes `--tz UTC|local|<IANA>`. Default to UTC, document DST handling.
- **sources**: Grafana dashboard timezone setting `https://grafana.com/docs/grafana/latest/dashboards/use-dashboards/` (UTC/browser/named, `timezone=Europe/Madrid` URL param); Elastic date_histogram `time_zone` param; Datadog log timestamp canonicalization; Loki UTC-mandated ingestion; OpenSearch `time_zone` in aggregations.

**LD3-G2** [rank 4, severity High]
- **title**: "Most-run" ranking semantics undefined — raw vs distinct, include failures? include no-ops?
- **what**: "most-run cmds ranking" — count raw invocations, or distinct `(session, cwd)`, or distinct days? Exclude non-zero exits (no atuin-enrichment here, so can't)? Strip `cd`, `ls`, `pwd` (chaff that dominates any real ranking)? Include `sudo`/`env` prefix variants as same? Different answers → wildly different "top 10".
- **why_missed**: LD3 enumerates queries as surface names without semantics. The cmd-usage classify.ts (flow/plans/2026-07-24:Phase2) strips prefixes & normalizes args — but that pipeline is not referenced by this design, so "most-run" ranking is underspecified.
- **mitigation**: Define 3 ranking modes (raw-count / distinct-day / weighted-by-failure-when-enriched) + a "noisy-command denylist" (`cd`, `pwd`, `ls`, `clear`). Make mode a CLI flag, not a hidden default.
- **sources**: Honeycomb group-by vs count-distinct semantics `https://docs.honeycomb.io/configure/datasets/manage/`; Datadog "Patterns"/"Transactions" clustering (dedup + count) `https://docs.datadoghq.com/logs/log_configuration/indexes.md`; Elastic cardinal aggregationations; Splunk `stats count vs dc(field)`; OpenSearch terms aggregation.

**LD3-G3** [rank 4, severity High] [X-CUT:temporal]
- **title**: "Recent" is undefined across heterogeneous agent hosts (clock skew + format skew)
- **what**: `query --last 24h` — recent relative to what clock? pi host vs zcode host vs hermes host vs analyst host. Reviewer_3_input.md:41 confirms 3 different timestamp formats. No monotonicity: epoch-ms from a drifted clock can produce "future" events that the 24h window silently drops, or "past" events that pollute it.
- **why_missed**: LD3 assumed a single timeline. OT4 frames live/batch but neither establishes a clock authority.
- **mitigation**: Store `ingested_at` separately from `event_ts`. Add `host_clock_skew_check` (compare max event_ts to wall-clock at ingest; flag if >300s). `--last 24h` documented as "wall-clock at query time, not event_ts".
- **sources**: Filebeat `ignore_older` + `close_inactive` mtime-based tailing pitfalls `https://www.elastic.co/guide/en/beats/filebeat/current/filebeat-input-log.html`; OTel clock-skew correction (well-known); Datadog timestamp precedence rules; Loki `entry.timestamp` ordering requirements; Splunk `MAX_DIFF_SECS_AGO`/`_time` strptime precedence.

**LD3-G4** [rank 3, severity Medium] [X-CUT:PII]
- **title**: "args for git" query leaks paths/refs/tokens — no normalization or privacy boundary
- **what**: Sample query "args for git" returns raw argv. Contains repo paths (reveal project layout), ref names (reveal branch state), sometimes `https://<token>@github.com/...`. A "brief-view first, drill-down via oas" UX (workflow verbatim) means the brief itself may leak.
- **why_missed**: LD3 treats args as display text; the classify.ts normalization (`<path>`, `<hash>`, `<ref>`, `<ver>` — flow/plans/2026-07-24 Phase2 normalizeArgs) was not inherited by this design.
- **mitigation**: Reuse normalizeArgs: store `args_normalized` (PII-safe) as the default display column, gate raw `args` behind `--raw` with a PII warning. Datadog's "partial redact" mode is the template.
- **sources**: Datadog Partially-redact SDS mode `https://docs.datadoghq.com/security/sensitive_data_scanner.md`; Elastic ingest pipeline grok normalize; OpenSearch ingest pipelines; Splunk `SEDCMD` anonymize; Filebeat `processors.dissect`.

**LD3-G5** [rank 3, severity Medium]
- **title**: Histogram aggregation silently undercounts when agents are offline
- **what**: time-of-day / by-day buckets assume continuous ingestion. If zcode host was down days 5–6, the histogram looks like a "weekend dip" with no flag. No `coverage_gaps` column.
- **why_missed**: "6 query examples" presented as static views; observability tools (Splunk `metadata`/`type=rtindex`, Datadog uptime monitors) carry coverage/gap signals alongside the data.
- **mitigation**: Emit per-source coverage (`agent × day × last_seen_ts`); histogram CLI prints a coverage ribbon ("zcode: no data 2026-08-02..08-03").
- **sources**: Datadog uptime/usage monitors `https://docs.datadoghq.com/logs/log_configuration/indexes.md` (3-day ingestion visibility); Loki compactor table-per-day granularity; Filebeat `clean_inactive` registry cleanup; Splunk `metasearch`/`type=rtindex`; OpenSearch ISM per-index health.

### OT4 — live-or-batch

**OT4-G1** [rank 4, severity High] [X-CUT:temporal]
- **title**: Ad-hoc query has no freshness indicator — ops can't tell stale from live
- **what**: `oas-stats query --last 24h` returns rows but not "data is 6h old". If ingest died silently (watermark file corrupt, OOM, etc. — reviewer_3_input OT), the query lies without lying. Datadog Live Tail explicitly separates "near real time" indexed + non-indexed streams; Kibana shows "latest event" per index pattern.
- **why_missed**: OT4 frames live-vs-batch as a feature decision; neither branch established the freshness contract.
- **mitigation**: Query output always prints `last_ingested_at` + `max_event_ts` + `stale=true/false` banner. CLI exit code 0 even when stale (don't break pipelines) but stderr warning.
- **sources**: Datadog Live Tail "near real time" indexed + non-indexed `https://docs.datadoghq.com/logs/explorer/live_tail.md`; Kibana index-pattern latest timestamp; Loki query range freshness; OpenSearch ISM managed-index health; Filebeat registry offsets.

**OT4-G2** [rank 4, severity High]
- **title**: Materialized views can outlive the 7d outbox — stale aggregation without invalidation either way
- **what**: Design mentions "materialized views for common aggregations" (review context). With ad-hoc, no refresh trigger means MVs can hold a snapshot older than outbox TTL (7d). The live-vs-batch decision is irrelevant: both need a refresh/invalidation policy, and neither was specified.
- **why_missed**: OT4 reduced the problem to "polling layer vs ad-hoc" — but the real issue is view-freshness independent of access pattern.
- **mitigation**: Each MV carries `refreshed_at`; query refuses (or warns) if `now - refreshed_at > outbox_ttl`. Refresh on `oas-stats ingest` completion (incremental). DuckDB supports `CREATE OR REPLACE VIEW` + manual refresh — make it explicit.
- **sources**: ES ILM rollover with alias swap (atomic freshness) `https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html`; Loki compactor compaction cadence `https://grafana.com/docs/loki/latest/operations/storage/retention/`; OpenSearch ISM state transitions; Datadog index retention + usage monitoring `https://docs.datadoghq.com/logs/log_configuration/indexes.md`; ClickHouse/DuckDB MV refresh semantics.

**OT4-G3** [rank 3, severity Medium]
- **title**: No streaming/`watch` ergonomics — ad-hoc model forces `query` reruns under fire
- **what**: Incident workflow needs `tail -f`/`watch`-equivalent. `oas-stats query` re-emits a full snapshot each call — no diff, no follow mode. Datadog Live Tail, Loki `logcli follow`, `kubectl logs -f` all confirm follow is table-stakes for ops.
- **why_missed**: LD1 killed UI; OT4 killed polling dashboard; nothing left but one-shot CLI.
- **mitigation**: `oas-stats query --follow --interval 5s` (re-run + diff against last). Cheap; composes with `watch`. Avoids full polling-layer scope.
- **sources**: Datadog Live Tail streaming model `https://docs.datadoghq.com/logs/explorer/live_tail.md`; Loki `logcli --tail`; Filebeat live harvesters; OpenSearch async-search/scroll; ES `tail` via Async Search.

**OT4-G4** [rank 3, severity Medium]
- **title**: Ad-hoc aggregations can block ingestion (DuckDB single-writer)
- **what**: DuckDB is single-writer/multi-reader (reviewer_0_input.md:30). A heavy `GROUP BY` aggregation query against a 90d store can hold the writer lock long enough to back-pressure ingestion or trigger SQLITE_BUSY-style retries.
- **why_missed**: OT4 framed live-vs-batch as access model; did not address concurrency between the access model and the ingestion writer.
- **mitigation**: Document the read/write lock contract. Either (a) periodic COPY-TO-read-only-snapshot pattern, (b) explicit `--read-only` connection for queries, or (c) bound query cost with statement_timeout.
- **sources**: DuckDB concurrency docs (single-writer); SQLite WAL reader/writer concurrency (analog); ES near-real-time refresh interval tradeoff; OpenSearch ISM managed-index read load; Filebeat `close_inactive` to release file handles.

### OT10 — retention-policy

**OT10-G1** [rank 5, severity Critical] [X-CUT:PII]
- **title**: 90d retention of command text (PII/secrets) collides with GDPR storage-limitation + purpose-limitation
- **what**: OT10 proposes 90d analytics retention of raw command text. If commands contain secrets/PII (LD1-G1), storing 90d past the sysops-diagnosis purpose = GDPR Art. 5(1)(e) storage-limitation breach + Art. 5(1)(b) purpose-limitation overreach. Same issue for CCPA/sectoral (PCI 3.1 track-data rules). Loki's default is "logs live forever" only because it's the operator's call — design here is making the call *for* the operator at 90d with no PII carve-out.
- **why_missed**: OT10 framed retention as a disk-usage knob; never framed it as a data-protection knob.
- **mitigation**: Separate `cmd_text` (short TTL, redacted) from `cmd_signature` (long TTL, derived & PII-free). Default signature 90d, raw text 7d. Document the legal basis for retention in the spec.
- **sources**: Datadog SDS redaction on ingest + per-index retention `https://docs.datadoghq.com/security/sensitive_data_scanner.md`, `https://docs.datadoghq.com/logs/log_configuration/indexes.md`; ES ILM tier-based retention (hot/cold/delete) `https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html`; GDPR Art. 5(1)(e) (well-known); Loki per-tenant retention override `https://grafana.com/docs/loki/latest/operations/storage/retention/`.

**OT10-G2** [rank 4, severity High] [X-CUT:temporal]
- **title**: Outbox 7d < analytics 90d — bug found after day 8 = unrecoverable
- **what**: If a parser/classifier bug is discovered on day 8 (e.g., misclassified `mise.run`), the 7d outbox is already trimmed — analytics cannot be re-derived from raw source. Outbox must outlive the analytics it feeds, or be coextensive.
- **why_missed**: OT10 picked two independent TTLs with no reprocessing algebra.
- **mitigation**: Outbox TTL ≥ analytics TTL + bug-detection-window (recommend outbox ≥ analytics, both 90d). Or: re-derive analytics from original agent session files (pi JSONL, zcode/hermes SQLite) which are the real source of truth — outbox becomes optional cache.
- **sources**: ES ILM delete phase only after cold/frozen searchable `https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html`; Datadog rehydrate-from-archive requires archive ≥ index retention; Loki compactor per-tenant retention `https://grafana.com/docs/loki/latest/operations/storage/retention/`; Filebeat `clean_inactive` registry trimming tradeoff; OpenSearch snapshot/restore.

**OT10-G3** [rank 3, severity Medium]
- **title**: "Tune based on disk usage" is the wrong governing metric
- **what**: Disk is a cost signal, not a value/privacy/legal signal. Tying TTL to disk means a quiet week silently extends secret retention. Observability tools decouple: ES ILM by age (max_age) + size (max_size) + delete phase; Loki by `retention_period` per-tenant; Datadog by per-index retention + quotas.
- **why_missed**: OT10 recommendation treated disk as primary lever.
- **mitigation**: Two knobs: hard TTL (age, default for privacy) and soft cap (size, for cost). Cap triggers sampling not deletion.
- **sources**: Loki `retention_period` + per-stream granular override `https://grafana.com/docs/loki/latest/operations/storage/retention/`; ES ILM max_age + max_size + delete `https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html`; Datadog per-index quotas + retention `https://docs.datadoghq.com/logs/log_configuration/indexes.md`; OpenSearch ISM transition conditions; Splunk `maxDataSize`+`frozenTimePeriodInSecs` dual knobs (well-known).

**OT10-G4** [rank 4, severity High]
- **title**: No PII purge guarantee on deletion — DuckDB `DELETE` doesn't scrub pages
- **what**: `DELETE FROM commands WHERE ts < cutoff` marks rows free; pages remain on disk until rewrite/VACUUM. Forensic recovery possible. For PII/secrets (LD1-G1), "retention" must mean physical removal. ES forces segment merge / `_delete_by_query` + forceMerge; Loki compactor rewrites chunks; DuckDB needs `VACUUM`/`CHECKPOINT` + rewrite.
- **why_missed**: OT10 specifies retention horizon, not retention enforcement.
- **mitigation**: Document that TTL trim runs `DELETE` + `VACUUM`. For high-sensitivity, prefer storing only the PII-free `cmd_signature` so purge is moot.
- **sources**: DuckDB VACUUM/CHECKPOINT docs; ES `_delete_by_query` + forceMerge (segment rewrite); Loki compactor chunk rewrite `https://grafana.com/docs/loki/latest/operations/storage/retention/`; OpenSearch ISM delete action; SQLite VACUUM analog.

**OT10-G5** [rank 3, severity Medium]
- **title**: No legal-hold / eDiscovery path
- **what**: If a legal hold or incident forensics case requires freezing retention, the design has no per-record/per-source hold flag — TTL trim is global. Splunk has `frozen` buckets, ES has searchable snapshots + index freeze.
- **why_missed**: v1 scoped to sysops diagnosis; litigation/forensics not considered.
- **mitigation**: Add `retention_hold BOOLEAN` column or `holds` table; trim skips held rows. Cheap schema addition, expensive to retrofit later.
- **sources**: Splunk frozen buckets (well-known); ES searchable snapshots + freeze phase `https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html`; OpenSearch ISM policy freeze; Datadog Online Archive (cold hold) `https://docs.datadoghq.com/logs/log_configuration/indexes.md`; Loki per-tenant retention override.

### OT13 — next-step-choice

**OT13-G1** [rank 4, severity High]
- **title**: Three-path menu has no decision criteria — user cannot pick without an eval matrix
- **what**: Paths (OpenSpec capture / DuckDB spike / keep exploring) are orthogonal concerns treated as alternatives. The actual decision is gated on (a) data shape (cross-agent × time-series × variable-arity args → columnar is right but engine choice is open: DuckDB vs ClickHouse vs Parquet-on-Loki-style), (b) write concurrency (single-host vs multi-host ingest), (c) privacy surface (PII redaction must be settled BEFORE spec). No matrix maps criteria → path.
- **why_missed**: OT13 presents options without selection function.
- **mitigation**: Convert to decision tree: PII policy first → schema (signatures vs raw) → spike on real 7d data with success criteria → THEN OpenSpec. Sequence, not menu.
- **sources**: ES ILM design-first (phases planned before ingest) `https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html`; Datadog index/retention design-first `https://docs.datadoghq.com/logs/log_configuration/indexes.md`; Loki retention/compactor design-first `https://grafana.com/docs/loki/latest/operations/storage/retention/`; OpenSearch ISM policy templates; Datadog SDS redaction policy first `https://docs.datadoghq.com/security/sensitive_data_scanner.md`.

**OT13-G2** [rank 4, severity High]
- **title**: "Spike DuckDB on real data" has no success criteria — unverifiable spike
- **what**: Path 2 ("spike DuckDB") without defining what proves success = wasted cycle. Need: row count from 7d real ingest, p50/p99 latency for the 6 LD3 queries under concurrent read+write, content-loss invariants, re-ingest idempotency check.
- **why_missed**: Path 2 phrased as activity, not outcome.
- **mitigation**: Define spike exit: ingest 7d from 3 sources; measure (a) ingest throughput rows/s, (b) query p99 for each of the 6 examples ≤200ms, (c) single-writer contention under parallel `query`+`ingest`, (d) on-disk bytes/row. No pass = path rejected.
- **sources**: DuckDB benchmarks + concurrency docs; ClickHouse vs DuckDB for analytics (well-known comparisons); ES ILM phase latency tradeoffs; OpenSearch ISM load considerations; Datadog index usage-monitoring metrics `https://docs.datadoghq.com/logs/log_configuration/indexes.md`.

**OT13-G3** [rank 3, severity Medium]
- **title**: OpenSpec capture before schema/PII freeze = lock-in amplifies LD1-G2 migration pain
- **what**: Capturing as `/opsx:new oas-command-stats` codifies a schema that — per LD1-G2 + LD3-G1 + LD3-G2 — is not yet stable (tz, ranking semantics, PII normalization all unresolved). Once in OpenSpec, schema changes become change-requests, multiplying migration cost.
- **why_missed**: Path 1 offered before the unresolved LD3/OT10 items.
- **mitigation**: Order: resolve PII (LD1-G1), tz (LD3-G1), ranking modes (LD3-G2), TTL model (OT10-G2/G3) → spike proves schema → THEN OpenSpec. Don't spec what you haven't tested.
- **sources**: ES ILM schema evolution via aliases (avoid premature lock) `https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html`; Datadog index-filter design (deferred schema binding); OpenSearch reindex as migration cost; Loki versioned schemas `https://grafana.com/docs/loki/latest/storage/`; Filebeat `processors` (post-ingest schema mutation).

---

## Cross-cutting summary
- **[X-CUT:PII]** LD1-G1, LD3-G4, OT10-G1, OT10-G4 — secrets/PII redaction absent end-to-end (ingest → query display → retention → purge). Highest aggregate severity.
- **[X-CUT:temporal]** LD3-G1, LD3-G3, OT4-G1, OT10-G2 — clock/tz/freshness/reprocessing-window all underspecified; "recent" and "live" have no defined authority.
- **Highest individual**: OT10-G1 (GDPR × 90d PII retention) — Critical.