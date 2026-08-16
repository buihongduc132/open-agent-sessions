# Gotcha Coverage — Batch B: vacuum / binary-search probe / session-end hook

> Source: flow/findings/2026-08-15_skill_usage_perf_watermark/ (turns 1–2, OT4–OT6)
> Mode: findings
> Sub-agent: reviewer (batch B)
> Units reviewed: OT4, OT5, OT6
>
> Rank distribution: rank 5 — none found; rank 4 — G4.1,G4.4,G4.5,G5.1,G5.2,G5.4,G5.5,G6.1,G6.2,G6.3,G6.4; rank 3 — G4.2,G4.3,G5.3,G5.6,G6.5,G6.6,G6.7,G6.8,GX.1,GX.2; rank 2 — G5.7,G5.8.
> Full findings below, organized by unit (severity inline per gotcha + summary table at end).

---

# Gotcha Scout — Batch B (OT4 / OT5 / OT6)

Source: `flow/findings/2026-08-15_skill_usage_perf_watermark/` (turns 1–2, open-threads.yaml) + live code
`src/skill-usage/{cache,parser,analyzer}.ts`. Only MISSED items — everything already covered by the
source (vacuum window-kill, warm-cache probe futility, 4KB cap, min-chunk for local non-monotonicity,
partial-tail buffer, truncation detect, flush throttle, at-least-once dupes) is excluded.

Severity: 1=YAGNI · 2=minor · 3=moderate/plausible · 4=significant correctness impact · 5=fundamental

---

## OT4 — Vacuum semantics fix (keep out-of-window entries)

**G4.1 — Unlink-check is impossible with current cache entries: `sessionPath` is never populated on write.**
- What: `JsonCache.set()` writes `sessionPath: existing?.sessionPath ?? ""`. Fresh entries always get
  `""` — the path is only inherited from a pre-existing entry, never set from the actual file being
  parsed. An unlink-check vacuum needs path→entry mapping; today entries (except legacy ones) carry an
  empty path.
- Why missed: source analyzed vacuum at the set-membership level (`vacuum(existingFps)`), never
  inspected what the entry payload actually contains.
- Severity: 4 (the proposed fix as sketched cannot work; silent no-op eviction)
- Mitigation: schema change — persist `sessionPath` (and ideally parsed-offset/coverage, see G5.4) in
  `set()`; migrate/ignore legacy entries; add reverse index path→fingerprint for unlink checks.

**G4.2 — Keeping entries removes the only cache-size bound; nothing replaces it.**
- What: today vacuum caps cache at "files in current window". Keeping out-of-window entries makes the
  cache monotonically growing (every session ever parsed, forever, each with full `SkillMatch[]`).
  Sessions accumulate over months/years.
- Why missed: fix framed as pure win; growth coupling only considered via the (unrelated) TTL option.
- Severity: 3
- Mitigation: pair the fix with either aggregated-counts payload (OT3), TTL floor, or total-bytes cap
  with LRU eviction. Lock this in the same decision, not later.

**G4.3 — Age-TTL eviction reintroduces the exact reparse storm it exists to prevent.**
- What: TTL from cache-write time: machine idle 60 days (vacation) + 30d TTL + next run `--days 30`
  → every entry expired → full reparse of a month of sessions. The "widen window without reparse" goal
  silently fails for any gap > TTL. TTL vs max-window relationship never defined.
- Why missed: TTL presented as an equivalent alternative to unlink-check; expiry-vs-idle interaction
  not modeled.
- Severity: 3
- Mitigation: TTL must be ≥ max supported window, or keyed on session-file mtime (not cache-write
  time) so still-on-disk files never expire — i.e., unlink-check is the primary, TTL only as garbage
  collection for gone files.

**G4.4 — Unlink-check eviction has a TOCTOU + concurrency hole once OT6 lands.**
- What: no locking anywhere in the cache. Weekly scan lists dir → decides entry orphan → deletes at
  `close()`; a session-end hook (OT6) writing that entry in between gets its file unlinked /
  overwritten (last-writer-wins shard writes, lost updates). Also: entry for a file created after the
  scan's readdir but before vacuum is wrongly treated as orphan.
- Why missed: source treats cache as single-process; OT6 makes it multi-writer by design.
- Severity: 4 (post-OT6; latent before)
- Mitigation: per-shard or global lock file, or unlink-check recomputed at `close()` time, or move to
  the already-reserved sqlite backend (single-file, transactional) before OT6.

**G4.5 — The `--days` window the vacuum fix preserves is file-mtime-only; per-match timestamps are never filtered.**
- What: analyzer filters files by mtime, then aggregates ALL cached/parsed matches with no timestamp
  check against the cutoff. Long-running sessions touched today contribute months-old matches to a
  "--days 7" report. So the thing vacuum protects ("windowed cache entries") and the thing the report
  claims ("usage in window") are different semantics. Widening `--days` doesn't just avoid reparse —
  it changes what the numbers mean in a way unrelated to cache state.
- Why missed: turn 2 notes the parse-waste side ("file touched today gets fully parsed") but not the
  counting side.
- Severity: 4 (report correctness, independent of perf)
- Mitigation: filter matches by `timestamp >= cutoff` at aggregation; decide explicitly whether
  sessions list or matches list defines the window.

---

## OT5 — Timestamp binary-search probe (cold-start fallback)

**G5.1 — Regex timestamp extraction is content-injection-prone.**
- What: `"timestamp"` appears verbatim inside session *content* (assistant messages discussing JSONL,
  logs, quoted session data — this analysis domain is exactly that). A naive first-match regex over
  the capped read grabs an inner, content-owned timestamp, not the record's own. Escaped
  `\"timestamp\"` inside string values defeats naive unescaped-quote assumptions too.
- Why missed: source capped the read but assumed the first regex hit is the record timestamp.
- Severity: 4 (wrong probe value → boundary lands in wrong chunk → silently skipped/over-parsed range)
- Mitigation: extract timestamp only from the record *prefix* (top-level field order is stable in the
  writer), or require match at a structural position (after `{` at line start, minimal nesting depth),
  or bail to full parse on ambiguity.

**G5.2 — Capped read can miss the timestamp entirely (field position not guaranteed early).**
- What: if the timestamp field sits past 4KB into a large record (records run 10KB–1MB per the
  source's own numbers), the capped regex read returns nothing → probe "unknown". Repeated unknowns
  degrade the search; undefined behavior (skip? treat as <T?).
- Why missed: cap chosen for cost, not for where timestamps actually live in real records; no
  distribution evidence cited.
- Mitigation: verify field position over a real corpus; make "no timestamp found" an explicit probe
  outcome that falls back to chunk-scan, not a guess.

**G5.3 — Probe boundaries vs multi-line records: seeking to a byte/line offset lands mid-record.**
- What: binary search over lines is incoherent when one JSON record spans many lines — the "middle
  line" may be a continuation line with no timestamp of its own, and record starts can't be found
  without back-scanning. Line-indexed and byte-indexed search both need a record-boundary resolver
  the current parser doesn't expose.
- Why missed: source acknowledged multi-line records for the watermark tail but not for probe seeks.
- Severity: 3
- Mitigation: seek to byte offset, discard to next `\n{`-at-column-0 pattern; treat continuation
  lines as "probe miss, shift right".

**G5.4 — Partial-parse result cached under a whole-file fingerprint = poisoned cache.**
- What: cold-start path parses only from chunk K onward, but there is one fingerprint per file. If
  that partial result is stored like today's full-parse results, a later cache hit serves partial
  matches as if complete — permanently, until the file changes again. Cache entries have no
  coverage/parsed-from field.
- Why missed: cache fingerprint model (path|size|mtimeNs) never revisited when introducing partial
  ingestion.
- Severity: 4
- Mitigation: cache entry gains `coverage: {fromOffset, fromLine}` (or "partial" flag); hits for
  full-parse requests must not treat partial entries as valid; same fix needed by OT1 watermark.

**G5.5 — Mid-file start loses parser carry-state: `sessionId` is only set by the `session` event at file head.**
- What: `extractSkillReads`/`extractSkillMentions` initialize `sessionId = ""` and only update on a
  `session` event. Parsing from chunk K yields matches with empty `sessionId` until another session
  event appears (never, in most files) → aggregation's `loadedInSessions`/`mentionedInSessions`/
  `sessions` all silently wrong for the cold-start path.
- Why missed: parser assumed to always run from byte 0.
- Severity: 4
- Mitigation: scan back for the file-head session event (cheap: first N bytes) before tail parsing;
  thread it in as initial state.

**G5.6 — Systematic (not local) timestamp disorder breaks the search invariant.**
- What: min-chunk absorbs *local* jitter (batched events, clock steps). It does not absorb a file
  where an early record carries a later timestamp than a middle one (resumed sessions, compaction
  rewrites, events emitted with backdated timestamps). Binary search then prunes the half containing
  in-window records → silent undercount.
- Why missed: source's caveat was "not perfectly monotonic (batched, clocks)" — noise model only.
- Severity: 3 (4 if compaction rewrites preserve old timestamps in reordered records)
- Mitigation: post-landing sanity check — verify chunk-start timestamp is actually ≥ T before
  discarding the left half; else fall back to full parse. Cheap, closes the hole.

**G5.7 — Cross-host clock skew when window start T is compared to record timestamps.**
- What: sessions may originate on machines other than the analyzer host (copied/synced session dirs).
  T computed from local clock vs record timestamps from a skewed producer clock shifts the boundary
  by the skew.
- Why missed: single-machine assumption ("~1.5k stable per-machine paths") baked in without checking
  whether sessionsDir can ever be a synced/foreign tree.
- Severity: 2
- Mitigation: pad the boundary by one min-chunk; acceptable given heatmap tolerance.

**G5.8 — Min-chunk in lines vs chunk cost in bytes: 100 lines of 100KB records = ~10MB parse.**
- What: for blob-heavy sessions the "min chunk" costs as much as a meaningful fraction of the file;
  the O(log n + tail) win degenerates. Chunk size should be byte-bounded, not line-bounded.
- Severity: 2
- Mitigation: cap chunk in bytes (e.g. 1–4MB) and/or adaptive chunking.

---

## OT6 — Session-end hook as end-state

**G6.1 — Sessions that never "end" cleanly bypass the hook forever.**
- What: SIGKILL, power loss, crash, terminal close → no session-end event fires → that session's
  matches are never ingested unless the scan fallback still runs. The claim "hook eliminates scan
  entirely" is false for exactly the sessions users care about (aborted/lost work).
- Why missed: source framed hook vs scan as alternatives; coverage gap of the trigger itself unmodeled.
- Severity: 4
- Mitigation: keep the periodic scan as reconciliation (it can be cheap + watermark-driven); hook is
  an accelerator, not a replacement. Lock this explicitly.

**G6.2 — Hook may read a tail that isn't flushed yet.**
- What: session-end hook fires while the session writer may still have buffered bytes (or the final
  record's trailing newline) not yet on disk. Hook advances the watermark offset past what it read;
  the unflushed bytes land below the watermark later and are never ingested.
- Why missed: offset-correctness discussed for the *reader* side only; writer-side flush ordering vs
  hook trigger never considered.
- Severity: 4
- Mitigation: hook must verify `size == cached.size` after parse and refuse to advance past
  non-newline-terminated tails (reuse the partial-tail buffer rule); or trigger on file-idle rather
  than session-end event.

**G6.3 — Incremental ingest breaks the parser's per-file token dedup → inflated mention counts.**
- What: `extractSkillMentions` dedupes tokens via a per-parse `seen` set (whole file). Both the
  watermark path and the hook parse only appended chunks with a *fresh* `seen` set — a token that
  appeared earlier (deduped then) and reappears in new text is now counted again, once per chunk.
  Mention counts become chunk-count-dependent, not file-deduped. Distinct from the boundary-split
  duplicate case the source did cover.
- Why missed: dedup lives inside the parser as parse-local state; never modeled across incremental
  invocations.
- Severity: 4 (numbers change semantics silently)
- Mitigation: persist the per-file `seen` set (or per-token first-seen offset) in the cache entry;
  dedup against the union. Payload cost — intersects OT3 (raw matches vs counts).

**G6.4 — Concurrent writers: hook + weekly scan on the same cacheDir with zero locking.**
- What: same as G4.4 but now guaranteed, not hypothetical — hook fires mid-scan routinely (sessions
  close while the weekly run is in flight). Eager full load at `open`, last-writer-wins shard writes,
  vacuum deletions racing hook inserts → lost entries, torn JSON (corrupt entries are silently
  skipped by `load()`'s catch → data loss disguised as cache miss).
- Why missed: single-process mental model throughout.
- Severity: 4
- Mitigation: atomic writes (tmp+rename) at minimum; lock or sqlite backend before OT6 ships.

**G6.5 — Corrupt-entry swallow converts corruption into silent wrong data.**
- What: `load()` `catch {}` skips unparseable entries. Under concurrency (G6.4) or partial writes, a
  corrupt entry for a live session = permanent cache miss → that session silently re-parsed each run
  (or, worse with hook, its matches re-derived with different dedup state per G6.3). No signal ever
  surfaces.
- Why missed: benign-looking error handling; no counter/logging path.
- Severity: 3
- Mitigation: count and expose skipped-corrupt entries in report/stats; write atomically.

**G6.6 — Parser logic now ships in two artifacts → version/behavior drift.**
- What: hook bundles its own copy of the parser/matcher (or imports a version frozen at deploy time);
  the analyzer library evolves separately. Same session parsed by hook vN and scan vN+1 can yield
  different match sets under one cache keyed by `parserVersion` — fine only if version is bumped
  rigorously on *any* behavioral change, including fuzzy-threshold or tokenizer tweaks.
- Why missed: version treated as a magic string, not a compatibility contract.
- Severity: 3
- Mitigation: derive `parserVersion` from a content hash of parser+matcher sources, or CI assert both
  artifacts import the same module version.

**G6.7 — Do subagent/forked/compacted sessions fire the hook? Coverage perimeter undefined.**
- What: sessions spawned as subagents/delegations (a first-class concept in this environment) may
  close without running user-configurable end hooks, or run them with a different cacheDir env.
  Compaction-created files may never see a "close" event at all. Unknown coverage = unknown blind
  spots.
- Why missed: hook modeled against "session" generically; no enumeration of session *kinds*.
- Severity: 3
- Mitigation: enumerate session lifecycle kinds (normal, subagent, crashed, compacted, resumed) and
  verify hook firing for each before declaring end-state; fall back to scan for uncovered kinds.

**G6.8 — First-seen/last-seen aggregation is undefined under partial ingestion.**
- What: `aggregate()` computes firstSeen/lastSeen over ingested matches only. With incremental
  ingest, early records are never parsed (by design) → `firstSeen` drifts to the watermark epoch for
  every skill. Reports comparing across runs will see phantom "first seen" jumps.
- Why missed: aggregation assumed to see whole-file matches.
- Severity: 3
- Mitigation: define firstSeen as "first ingested" or persist min-timestamp separately from matches;
  document it in report semantics.

---

## Cross-cutting (interacts with all three units, none owned)

**GX.1 — No crash-safety on the cache write path at all.**
- What: `close()` writes many shard files sequentially; crash mid-close leaves a half-updated cache
  (some entries new, some old) with no marker. Not atomic across shards, no manifest. Combined with
  G5.4's coverage fields this can persist a mixed old/new view.
- Severity: 3
- Mitigation: tmp+rename per file, plus a small manifest (epoch/generation) checked at load.

**GX.2 — `close()` failure mode: any single `writeFile` rejection aborts the loop, silently dropping all remaining dirty+deleted flushes.**
- What: no try/catch inside `close()`; one ENOSPC/EACCES throws, remaining dirty entries never
  written AND deleted entries never unlinked — and the exception propagates into the analyzer run
  after parsing already completed.
- Severity: 3
- Mitigation: per-file error isolation + surfacing a write-failure count.

---

## Summary

| Unit | Count | Sev 4 | Sev 3 |
|---|---|---|---|
| OT4 | 5 | 3 (G4.1, G4.4, G4.5) | 2 (G4.2, G4.3) |
| OT5 | 8 | 4 (G5.1, G5.2, G5.4, G5.5) | 2 (G5.3, G5.6) |
| OT6 | 8 | 4 (G6.1, G6.2, G6.3, G6.4) | 4 (G6.5–G6.8) |
| Cross | 2 | 0 | 2 |

Dominant themes the source missed entirely:
1. **Cache schema adequacy** — entries lack the fields (path, coverage, dedup state) that all three
   fixes require; every fix silently degrades or corrupts without a schema bump.
2. **Multi-writer reality** — OT6 makes the cache concurrent by design; nothing (locks, atomic
   writes, transactional backend) exists for it.
3. **Parser carry-state** — sessionId propagation and per-file dedup are parse-local assumptions that
   incremental/partial parsing violates.
4. **Report semantics vs cache mechanics** — the --days window is file-mtime only; counts and
   firstSeen semantics change under every proposed optimization.
