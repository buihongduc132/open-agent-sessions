# Skill Usage Analyzer: Performance + Correctness

> Plan ID: `skill-usage-perf-correctness`
> Created: 2026-08-15 · Last reconciled: 2026-08-15
> Status: pending
> Items: 20 total (0 implemented, 20 pending)
> Branch: (to be created)
> Location: flow/plans/skill-usage-perf-correctness.md

## Requirement (verbatim)

Source: `flow/findings/2026-08-15_skill_usage_perf_watermark/` (turns 1–2 + gotcha coverage appendices turn1a/turn2a).

Improve user-side performance of the skill-usage analyzer (`src/skill-usage/` + `scripts/skill-usage-heatmap.ts`) via byte-offset watermark registry (parse only appended bytes, not full files) + fix cache eviction semantics. Also fix correctness bugs surfaced by gotcha coverage: `--days` window filters files by mtime but never filters matches by timestamp → long-running sessions pollute "7-day" reports; vacuum cannot work as sketched (`sessionPath` never persisted); parser carry-state breaks under incremental parse.

Root architectural decision (OT7, gotcha-coverage dominant finding): cache payload must be **inventory-independent tokens + read-events with per-token time bounds**, aggregate at query time. This single choice dissolves selective-invalidation impossibility (OT2), aggregation non-mergeability (OT3), and dedup-inflation under incremental scans. Must be decided FIRST.

Recommendation order from turn 1: watermark registry → vacuum fix → token memo + set-based T1–T3 → session-end hook (deferred). Correctness fixes (OT11 timestamp filtering, OT8 offset byte-unit + boundary spec) parallel to perf.

## DOD (Definition of Done)

Plan done when ALL below true:
- [ ] Weekly `--days 7` scan parses only bytes appended in last 7 days (O(delta), not O(full files)).
- [ ] Widening `--days 7` to `--days 30` does NOT trigger full reparse of weeks 2–4 (vacuum preserves out-of-window entries).
- [ ] Report `--days N` filters matches by timestamp >= cutoff (NOT just file mtime) → long-running sessions contribute only in-window matches.
- [ ] Token matching runs against distinct-token set (NOT every token occurrence × every skill) via memoization.
- [ ] Cache schema supports incremental/partial ingestion (coverage field, sessionPath persisted, dedup vocab stored).
- [ ] Zero rank-4 gotchas remain unaddressed (OT7–OT12 mitigations applied).

## Tasks

### Root decision (gates everything)

- [ ] ot7-payload: Cache stores per-file deduped token vocab + read-tool events (inventory-agnostic), NOT raw SkillMatch[] or aggregated counts. Aggregate at query time. Per-token time bounds (first/last seen) persisted for window re-queries.
  - **Probe:** `src/skill-usage/cache.ts` entry shape includes `{tokens: Map<string, {first, last}>, readEvents: [...]}` instead of `matches: SkillMatch[]`.
  - **Why root:** Dissolves OT2 (selective invalidation impossible for new skills unless tokens cached), OT3 (aggregation not mergeable / temporal collapse), G6/G6.3 (dedup state not persisted). Blocks all other items until decided.

### Watermark registry (OT1 + offset correctness OT8)

- [ ] ot1-watermark: Registry entry per session stores `{path, offset, tail, size, mtimeNs, parserVersion}`. `offset` = byte index after last complete record's terminating newline. `tail` = residual partial-record bytes (raw, base64-encoded). Rescan logic: size==cached → skip; size>cached → seek(offset), parse tail, merge; size<cached → full reparse (truncation).
  - **Probe:** `src/skill-usage/cache.ts` registry schema includes `offset` + `tail` fields. `analyzer.ts` rescan code paths use seek+incremental parse when size increases.

- [ ] g2-offset-bytes: `offset` field measured in BYTES (not chars). Parser uses `Buffer` + `StringDecoder` for multi-byte-char safety. `tail` persisted as base64 (raw bytes, never normalized string).
  - **Probe:** `cache.ts` persists `tail` as `Buffer.from(tail).toString('base64')`. `parser.ts` incremental-read uses `Buffer` + `decoder.write()`.

- [ ] g3-rewrite-anchor: On resume, verify `tail` bytes at `offset - tail.length` match stored value before trusting offset. Mismatch (in-place rewrite / inode replace) → full reparse.
  - **Probe:** Rescan code reads `tail.length` bytes at `offset - tail.length`, compares to stored `tail` before incremental parse. Mismatch triggers full reparse.

- [ ] g5-boundary-spec: Offset boundary = byte after terminating `\n` of last complete record. Round-trip test: `parse(file) === parse(file[0..offset]) ⊕ parseIncremental(file[offset..])` (no double-count, no loss).
  - **Probe:** Unit test verifies incremental parse produces identical aggregates as full parse (given same file, split at arbitrary complete-record boundaries).

- [ ] g1-corrupt-escape: Parser caps tail-buffer accumulation (max 1MB or 100 lines). Exceeds cap → treat as corrupt record, log, skip to next `\n`, advance offset. Registry entry tracks `deadRecords` counter.
  - **Probe:** Parser rejects infinite accumulation. `cache.ts` entry includes `deadRecords` field. Test with malformed JSONL verifies skip + counter increment.

### Cache schema extensions (OT8/OT9/OT12)

- [ ] g4.1-sessionpath: `JsonCache.set()` persists `sessionPath` (actual file path being parsed) in entry, NOT `existing?.sessionPath ?? ""`. Enables unlink-check vacuum.
  - **Probe:** Fresh cache entry (no prior) has non-empty `sessionPath` field matching parsed file's realpath.

- [ ] g5.4-coverage: Registry entry includes `coverage: {fromOffset, partial}` field. Partial-parse results (cold-start binary-search) marked `partial: true`. Full-parse cache hits reject partial entries.
  - **Probe:** `cache.ts` entry shape includes `coverage` field. Analyzer refuses partial-entry hits for full-parse requests.

- [ ] g6.3-dedup-vocab: Per-file token dedup vocabulary persisted in registry entry (ties to OT7 token payload). Incremental scans union with stored vocab before matching.
  - **Probe:** Cache entry `tokens` map carries all tokens seen across all incremental parses of that file. Mention counts stable across append-only file growth.

### Vacuum fix (OT4/OT12)

- [ ] g4.1-unlink-vacuum: Vacuum eviction uses unlink-check (stat each cached path; entry for non-existent file → evict) instead of `existingFps` set-membership. Unlink-check recomputed at `close()` time (not scan start). Growth-bound decision (one line: TTL floor vs byte cap, trigger = measured cache growth) documented in `cache.ts` — machinery itself deferred.
  - **Probe:** After deleting a session file, next analyzer run evicts its cache entry. Widening `--days` window does NOT evict out-of-window entries.

### Report correctness (OT11)

- [ ] g4.5-timestamp-filter: Aggregation filters matches by `timestamp >= cutoff` before counting. `--days N` window applies to matches, not just files. Includes firstSeen/lastSeen semantic definition (G6.8: first = first ingested timestamp, documented in aggregation code; folded here — no separate item).
  - **Probe:** Long-running session (1 month old matches + 1 new match today, file mtime=today) in `--days 7` run contributes only the 1 new match, not all 31. Aggregation code documents firstSeen semantics.

### Parser carry-state (OT9)

- [ ] g5.5-sessionid: Incremental/mid-file parse back-scans file head (first 16KB) for `session` event, extracts `sessionId`, threads it as initial parse state.
  - **Probe:** Parsing from byte offset 1MB (skipping head) still produces matches with correct non-empty `sessionId`.

### Token memoization (turn-1 recommendation, OT7 impl)

- [ ] c3-token-memo: Per-run `Map<token, MatchResult>` memoizes `matchTier` calls. Matching runs against distinct-token set (hundreds), not all token occurrences (millions) × all skills.
  - **Probe:** Analyzer maintains memo map. Instrumentation shows `matchTier` invocations = O(distinct tokens × skills), not O(all tokens × skills).

- [ ] c3-set-lookup: Precompute `exactSet`, `canonicalMap`, `aliasSet` from inventory. T1/T2/T3 become O(1) map lookups before falling to T4 fuzzy (DL distance). Length-bucket index optional.
  - **Probe:** `fuzzy.ts` exports precomputed lookup structures. `matchTier` checks maps before running DL loop.

### Multi-writer safety (OT10, post-OT6)

- [ ] g6.4-atomic-writes: Cache writes use tmp+rename atomic pattern. Each shard file written to `.tmp` suffix, then renamed. Prevents torn JSON.
  - **Probe:** `cache.ts` `writeFile` calls write to `${path}.tmp`, then `rename()`.

### Deferred (OT6 session-end hook)

- [ ] ot6-hook-defer: Session-end hook deferred until watermark + fallback + multi-writer safety land. Hook = accelerator (real-time incremental), NOT replacement for scan (scan = reconciliation for crashed/killed sessions per G6.1).
  - **Probe:** Decision documented. Hook implementation NOT started.

### Binary-search cold-start fallback (OT5, optional)

- [ ] ot5-probe-design: Cold-start `--days N` path (cache lost/vacuum nuked): binary-search over records by timestamp (4KB capped regex extraction from record prefix), land in min-chunk (100 lines or 4MB), parse from chunk start. Probes must handle content-injection (G5.1), structural position verification (G5.2), multi-line boundary (G5.3), systematic disorder (G5.6 post-landing sanity check).
  - **Probe:** Analyzer `--cold-start` mode implements probe fallback. Tests verify correct boundary with adversarial timestamps (content-injected, disordered).

### Added by gotcha coverage 2026-08-16 (unowned gaps — see skill-usage-perf-correctness-gotcha.md)

- [ ] store-unification: SINGLE store keyed by canonical resolved path; per-path REPLACE on write (never accumulate versions); fingerprint demoted to advisory fast-path hint (mtime-touch on size-equal file never forces full parse); coverage/deadRecords/dedup-vocab/tokens live INSIDE the cache entry (no separate registry↔cache join). Unifies G-P1 cluster: per-append fingerprint churn, mutation orphans, per-path winner rule, DOD-1/DOD-2 provability.
  - **Probe:** Append to session file twice → entry count for that path == 1 (replaced, not duplicated). Same-size mtime-touch → no full reparse. Registry/cache join-miss impossible (single store).

- [ ] ts-capture-semantics: Parser dedups mention COUNTS, not timestamps — every occurrence updates `last = max(last, ts)` (and `first = min`) even when token already in `seen` set; monotonic merge on incremental union. Fixes: g4.5 window-filter false-negatives on repeat-within-one-segment (token day1+day46 same file → `--days 7` MUST count it).
  - **Probe:** Token occurring twice in one segment, second occurrence ≥ cutoff, first < cutoff → counted. Parser version bumped (match shape change).

- [ ] single-stream-owner: ONE incremental parse pass feeds BOTH extractors (`parseSegment(buffer, state) → events` consumed by reads + mentions); exactly ONE owner of offset/tail advancement; eliminates pre-existing double full-file read.
  - **Probe:** Incremental scan reads file bytes exactly once per run (instrumentation/read counter). Single watermark write after both consumers finish.

## Idempotency

Re-running `/10-plan-declarative` on same requirement reconciles to THIS plan.
Implemented items auto-marked `- [x]`. Pending items surface as work-remaining.
DO NOT rewrite item prose on re-run (status flips only).

## Open Threads

_(populated by /20-plan-verify-gotcha + re-runs)_

| Thread | Sev | Status | Resolution |
|--------|-----|--------|------------|
| Store key-space unification (G-P1 cluster) | 4 | ADDRESSED — new item `store-unification` | flow/plans/skill-usage-perf-correctness-gotcha.md |
| Timestamp capture on dedup-skip (G-P2/B3-G6) | 4 | ADDRESSED — new item `ts-capture-semantics`; g4.5 probe expectation corrected in appendix | same |
| Offset = parser-accepted-record boundary, NOT `\n` (B1-G1/B4-G4/G-P4) | 4 | OPEN — spec amendment to ot1/g5 needed before implementation | same |
| Anchor check on skip-path + fixed-size anchor (B1-G2/G3) | 4 | OPEN — rescan spec amendment | same |
| Tail⊕prepend single-decoder (B1-G4) | 4 | OPEN — incremental-parse spec amendment | same |
| Map→entries serialization for ot7 (B1-G5/G-P5) | 3 | OPEN — ot7 on-disk encoding amendment | same |
| Corrupt-cap false-positive + resync rule (G-49/G-51) | 4 | OPEN — g1 spec amendment | same |
| g6.3 stability probe needs positive control (G-60) | 4 | OPEN — probe amendment | same |
| DOD-2 asserts vacuum property no item creates (B4-G1) | 4 | ADDRESSED — provable only after g4.1-unlink-vacuum + store-unification | same |
| ISO-vs-number cutoff + mixed timestamp formats (B3-G5/B4-G6) | 4 | OPEN — g4.5 spec: epoch-ms normalization + both-side probe | same |
| readEvents need per-event ts (B1-G9) | 3 | OPEN — ot7 payload spec amendment | same |
| Legacy-entry tri-states (G-56/G-57), refusal after-effects (G-58), join-default (G-59), registry atomicity (G-62), tmp-name/sweep (G-63), stat-error taxonomy (B3-G3), empty-ts policy (B3-G7), memo skill-tuple + tie-break (B3-G9), collision first-wins (B3-G11), head-slice UTF-8/fallback (B3-G12), single-stream refactor (G-P3), gating split (G-P6) | 3 | OPEN — consolidated in appendix rank-3 section; resolve during implementation | same |
| ot7 gating over-broad — g4.5/c3-set-lookup/g6.4 payload-independent (G-P6) | 2 | OPEN — sequencing note | same |
| Hook deferral missing G6.2/G6.7 preconditions (G-P8) | 2 | OPEN — one-line addition at OT6 trigger | same |
| DOD-4 probe unfalsifiable (G-P7) | 2 | OPEN — probe rewrite: global-distinct bound + memo-hit counter | same |

## Deferred (scope-reduced 2026-08-15 — rank-3 items below DOD rank-4 bar)

- `g4.2-growth-bound` (TTL/LRU machinery) — trigger: measured cache growth (decision line kept in g4.1-unlink-vacuum)
- `g4.3-ttl-mtime` — trigger: TTL chosen as growth bound
- `i5-compaction-marker` — trigger: users report downward-trending totals
- `g6.4-lock` — trigger: OT6 hook work starts (origin: lock "before OT6 ships")
- `gx.2-close-isolation` — trigger: partial-flush incident observed, or OT6

## Trace to findings

| Item | Source |
|------|--------|
| ot7-payload | OT7 (turn1a appendix, H2/I1/I2/I3) |
| ot1-watermark | OT1 (turn1) |
| g2-offset-bytes | G2 (turn1a appendix) |
| g3-rewrite-anchor | G3 (turn1a appendix) |
| g5-boundary-spec | G5 (turn1a appendix) |
| g1-corrupt-escape | G1 (turn1a appendix) |
| g4.1-sessionpath | G4.1 (turn2a appendix) |
| g5.4-coverage | G5.4 (turn2a appendix) |
| g6.3-dedup-vocab | G6.3 (turn2a appendix) + OT7 |
| g4.1-unlink-vacuum | OT4 + G4.1 (turn2a) |
| g4.5-timestamp-filter | G4.5 (turn2a) + OT11 + G6.8 folded |
| g5.5-sessionid | G5.5 (turn2a) + OT9 |
| c3-token-memo | C3 (turn1) |
| c3-set-lookup | C3 (turn1) |
| g6.4-atomic-writes | G6.4 (turn2a) + OT10 |
| ot6-hook-defer | OT6 (turn1, updated turn2a G6.1) |
| ot5-probe-design | OT5 (turn2) + G5.1/G5.2/G5.3/G5.6 (turn2a) |
