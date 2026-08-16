# Gotcha Coverage — Plan `skill-usage-perf-correctness`

> Source: flow/plans/skill-usage-perf-correctness.md
> Mode: plan
> Sub-agents: reviewer ×5 (batches 1–5, parallel)
> Units reviewed: all 17 task items + 6 DOD criteria (post-scope-reduction state)
> Prior rounds: 48 known gotchas (findings turn1a/turn2a) — fed as context, excluded from rediscovery

## Findings (ranked, consolidated across 5 batches)

### Rank 5 (Sophisticated)

- **P3-G1 / B4-G2 — unlink-vacuum self-destructs; cold-start poisons DOD-2**
  - What: `cache.set()` writes `sessionPath: ""` for every new entry — unlink-check `stat("")` → evict-everything → cache hit rate 0 forever; the stated probe ("deleted file → evicted") passes **vacuously**. Separately: DOD-2 claims vacuum preserves out-of-window entries, but current `vacuum(existingFps)` already deleted them every weekly run — DOD-2 asserts a property no plan item creates. Cold-start partial parses then poison the cache as full-file entries (re-scored G5.4 at 5 given DOD-2 interaction).
  - Why missed: plan specified eviction mechanism, not the prerequisite (`set()` signature must persist sessionPath); DOD treats vacuum-preservation as existing.
  - Mitigation: `set(fingerprint, sessionPath, ...)` signature change folded into g4.1-sessionpath (it already owns this — probe must add cache-hit-rate>0-on-second-run assertion); DOD-2 provable only after g4.1-unlink-vacuum lands.

### Rank 4 (Significant)

- **B1-G1 — "terminating newline" ≠ record boundary (multi-line records)**
  - offset must be "byte after end of last parser-accepted complete record", newline-agnostic; g5 round-trip test must derive boundaries from parser acceptance, not `\n` scan, or it passes by construction while real multi-line records poison offsets. Covers `\r\n`.
- **B1-G2 — `size==cached → skip` bypasses anchor check; mtimeNs is a dead field**
  - Same-length rewrite hits skip branch, never tail-verified. mtimeNs stored but consulted by no branch. Mitigation: anchor compare on EVERY cached scan (cheap, bounded), or gate skip on size+mtime equality; same-size-rewrite fixture must trigger reparse.
- **B1-G4 — tail must be ⊕-prepended through ONE decoder instance**
  - "parse tail, merge" read as two steps is a category error. Incremental parse = `decode(tail ⊕ newBytes)` via a single `StringDecoder`; fresh decoder per read discards buffered continuation bytes (split multibyte char lost). Probe: round-trip where old EOF splits a multibyte char AND a record.
- **B1-G5 / B5-G-P5 — `Map` doesn't serialize: JSON.stringify(Map) === "{}"**
  - ot7's probe demands `Map` in a JSON.stringify cache — unimplementable as written; type-shape probe passes while on-disk cache is empty every week. Mitigation: on-disk encoding = entries array `[k,v]` or plain object w/ revive; probe = write/read round-trip asserting token count.
- **B1-G1(batch2) G-49 — corrupt-record cap false-positives legitimate records**
  - Session records regularly exceed 1MB (base64 images). Cap = safety valve, not corrupt criterion: on cap-exceed attempt completion-parse; only JSON syntax failure ⇒ dead. Probe needs valid 2MB record → parsed, deadRecords==0.
- **G-51 — resync-to-next-`\n` cascades / fabricates records**
  - Multi-line corrupt record: skip lands mid-record → cascade of deadRecords, or continuation fragments + following lines form accidentally-valid JSON → phantom records/tokens. Resync rule = next line beginning `{` at col 0. Probe: corrupt mid-record followed by valid multi-line records → exactly the valid ones, zero fabricated. (Also B5-G-P4.)
- **G-60 — g6.3 stability probe passes on frozen/broken emitter**
  - Negative assertion only. Probe must include new skill-mentioning token in appended segment → count increases by exactly expected amount.
- **B3-G2 — mutation orphans never evicted**
  - Edited session file: old fingerprint entry (file still exists → unlink-check keeps) + new entry → unbounded same-path duplicates; no per-path winner rule for aggregation (double-count or stale). Ties to B5-G-P1.
- **B5-G-P1 — two key spaces never reconciled (ROOT gap)**
  - Registry path-keyed vs cache fingerprint-keyed; every append mints new fingerprint (size+mtime change) → one entry per scan-observed state per session (~52/yr); mtime-touch forces full parse violating DOD-1; aggregation has no per-path winner rule. DOD-1/DOD-2 unprovable until unified. Mitigation: single store keyed by realpath, per-path REPLACE on write, fingerprint demoted to advisory hint.
- **B3-G5 — ISO-string vs number cutoff → silent empty report**
  - `ts >= cutoffMs` coerces → NaN → false → empty report. Spec: `Date.parse(ts) >= cutoffMs`; probe needs both older-dropped AND newer-kept assertions.
- **B3-G6 / B5-G-P2 — dedup keeps FIRST timestamp only → active skills undercounted**
  - Token at day1, day40, day46 (day40+46 same segment): stored {first:day1,last:day40}; `--days 7` (cutoff day43) drops it — day46 mention invisible. g4.5's own probe expectation is WRONG under current parser semantics. Mitigation: dedup counts, not timestamps — update last=max(occurrence ts) even when token seen; monotonic merge on union. Probe: repeat-within-one-segment case.
- **B4-G1 — DOD-2 asserts vacuum behavior the code doesn't have** (see rank 5)
- **B4-G3 — O(delta) unreachable under fingerprint key without rekeying** (subset of G-P1)

### Rank 3 (Moderate)

- **B1-G3** — degenerate anchor: empty/short tail = zero-strength verification; use fixed-size anchor (last K bytes or hash of last complete record) independent of tail.
- **B1-G6** — prototype-colliding token keys (`__proto__`, `constructor`) poison vocab merges/lookups; entries-array encoding or `Object.create(null)`.
- **B1-G9** — `readEvents` shape unspecified: no per-event timestamp ⇒ window re-query for read-tool usage unsatisfiable. Spec `{ts, skill}` up front.
- **G-52** — deadRecords>0 must imply coverage.partial=true (gapped-full ≠ clean-full).
- **G-54** — resolve() vs realpath() conflation: unlink-check keys on a path discovery never produces (symlinked sessionsDir → false orphans every run). Pick canonical form = resolve() (matches fingerprint input).
- **G-55** — g4.1-sessionpath probe verifies the field, not the vacuum behavior it enables.
- **G-57** — legacy entries: missing coverage field tri-state undefined → treat as partial (safe).
- **G-58** — refusal after-effects: partial→full must overwrite entry (else re-reject storm) and NOT merge (double-count). Multi-run probe.
- **G-59** — registry↔cache dual-store join for refusal: miss-default undefined → put coverage INSIDE cache entry (ties G-P1) or define join-miss = refuse.
- **G-62** — registry writes excluded from atomic-write guarantee (g6.4 covers cache shards only).
- **G-63** — fixed `.tmp` name collides under overlap; no stale-tmp sweep; probe asserts mechanism not outcome.
- **B3-G3** — stat-error conflation: evict only on ENOENT/ENOTDIR; other errors keep + log.
- **B3-G7 / B4-G5** — empty-timestamp matches: filter drops them silently; binary search mis-lands. Explicit policy (fallback file mtime / keep-and-flag) + probe.
- **B3-G9** — memo value lacks skill attribution; MatchResult={tier,distance} — memo must store best {skill,tier,distance} + reproduce tie-break (inventory order).
- **B3-G11** — canonical/alias collisions → last-wins nondeterminism; first-wins build + collision fixture.
- **B3-G12** — 16KB head-slice can split multibyte char / miss session event; trim to last `\n`, define fallback, probe session-event-at-64KB.
- **B4-G4** — watermark must be record-aligned + torn-write tolerant (offset after last successfully-parsed complete object — permanent loss otherwise).
- **B4-G6** — lexicographic ISO compare breaks on mixed formats/offsets (`Z` vs `+07:00`, ms vs s); normalize to epoch ms at parse.
- **B5-G-P3** — two extractors × two full-file reads; no item owns the single shared incremental stream / single offset owner. Refactor `parseSegment(buffer,state)→events`.
- **B5-G-P6** — ot7 gating over-broad: g4.5 / c3-set-lookup / g6.4 are payload-independent; serializing them delays the only report-correctness fix. Split gate.

### Rank 2 (Minor)

- B1-G7 (round-trip never exercises tail⊕suffix path), B1-G8 (aggregate assertions unspecified — pin deep equality), B1-G10 (probe covers 1 of 3 rescan branches), B1-G11 (overbroad blocking claim — same as G-P6), G-50 (1MB-or-100-lines disjunction), G-53 (permanent loss on offset advance; log claim unprobed), G-56 (legacy ""-sessionPath semantics), G-61 (stability claim scope), B3-G4 (vacuum count vs close() timing), B3-G8 (firstSeen definition contradicts filter — window-relative doc), B3-G10 (distinct-token magnitude off ~10³ — memo still profitable, correct estimate), B3-G13 (first-vs-last-wins sessionId divergence), B4-G7 (watermark has no owning unit — superseded by G-P1 new item), B5-G-P7 (DOD-4 probe unfalsifiable — memo removable while green; assert global-distinct bound + memo-hit counter), B5-G-P8 (hook deferral omits G6.2/G6.7 preconditions at trigger).

### Rank 1 (YAGNI)

- B1-G11 (duplicate of G-P6), sequencing note (c3-set-lookup first, memo residual T4-only — advisory).

## Cross-references
- G-P1 ⊃ B3-G2, B4-G1, B4-G3, G-59, G-62 (all collapse under single-store unification)
- G-P2 ⊃ B3-G6 (same root: dedup-discard of occurrence timestamps)
- B1-G1 ↔ B4-G4 ↔ B5-G-P4 (record-boundary correctness — one spec: parser-accepted-complete-record)
- B1-G5 = B5-G-P5 (Map serialization)
- B1-G2 ↔ B1-G3 (anchor strength + skip-path bypass — fixed-size always-on anchor solves both)

## Verdict on reviewed units
- [ot7-payload] core decision SOUND (only payload satisfying H2/I1/I2); probe + gating breadth need fix (G-P5, G-P6, G-P1).
- [g6.3-dedup-vocab] stable counts YES, stable time-bounds NO (G-P2) — probe blind.
- [ot6-hook-defer] sound today; add G6.2/G6.7 precondition line (G-P8).
- DOD-1/2/3 NOT provable until store unification + vacuum fix land (G-P1, B4-G1).
