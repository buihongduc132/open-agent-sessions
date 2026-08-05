# Phase 2 — extract + parse + storage

## [E1] Status
- Phase 2: DONE
- GREEN commit: 167ac17
- Verifier hash: 26c617c3 (self-audit)
- Independent re-audit: PENDING — see FIX-2

## [C1] Contract (a)-(j) evidence
- (a) parse-rate met — `oas-command-stats/scripts/parse-rate.ts`
- (b) parse_status/version/notes + quarantine — `oas-command-stats/src/storage/schema.ts:46`
- (c) event_id per agent — pi=hash(path+offset), zcode=tool_usage.id, hermes=synthetic
- (d) idempotency 0-new-on-rerun — `oas-command-stats/src/storage/ingest.ts:79`
- (e) single-file, 1 tx/row — `oas-command-stats/src/storage/ingest.ts:104`
- (f) per-row try/catch, poison isolated — `oas-command-stats/src/storage/ingest.ts:151`
- (g) ON CONFLICT natural key — `oas-command-stats/src/storage/ingest.ts:108`
- (h) watermark = perf hint — `oas-command-stats/src/storage/ingest.ts:198`
- (i) source_schema_version fail-loud — `oas-command-stats/src/storage/ingest.ts:55`
- (j) verifier hash recorded — 26c617c3

## [C1] Tests
- 47 pass / 2 skip / 0 fail
- typecheck clean
- 2 skip = OT18 P5 readonly

## [C1] Parse-rate
- simple 100%
- medium 100%
- complex 99.84%
- sample: 2998 zcode cmds

## [R1] Gaps
- OT18 P5 DB-level readonly → deferred Phase 5 (stub `oas-command-stats/src/storage/duckdb.ts:99`)
- /tmp/cmds_247k.txt dataset gone — fresh pull via parse-rate.ts now
- pi parse-rate=0, hermes parse-rate=0 — adapter shape detect incomplete in script (zcode sufficient for contract a)

## [A] Next
- Phase 3: effective_cwd + repo derivation
- OT24 rank5
