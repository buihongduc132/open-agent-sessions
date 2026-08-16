# Gotcha Coverage — Batch A: watermark registry / inventory / cache payload

> Source: flow/findings/2026-08-15_skill_usage_perf_watermark/ (turn 1, OT1–OT3)
> Mode: findings
> Sub-agent: reviewer (batch A)
> Units reviewed: OT1, OT2, OT3
>
> Rank distribution: rank 5 — none found; rank 4 — G1,G2,G3,G6,H1,H2,I1,I2,I3; rank 3 — G4,G5,G7,G8,G10,H3,H4,H5,I5,X1,X3; rank 2 — G9,G11,I4,X2,X4; rank 1 — G12.
> Full findings below, organized by unit (severity inline per gotcha + summary table at end).

---

# Gotcha Scout — Batch A (OT1/OT2/OT3 + cross-cutting)

Scope: watermark-registry redesign of skill-usage analyzer. Only MISSED items; no re-analysis of stated design. Grounded in `src/skill-usage/{parser,cache,analyzer,inventory}.ts`.

---

## OT1 — Watermark registry schema (offset/tail/truncation)

### G1. Corrupt record absorbs all subsequent records → permanent silent zero-yield
- **What**: parser accumulates lines until `JSON.parse` succeeds (parser.ts `parseJsonl`). A permanently invalid record never parses, and the buffer then swallows every following valid record (`{...}\n{...}` concatenated is not valid JSON). Watermark offset never advances past it; from the corrupt point on, the file yields zero matches forever, silently. Old fingerprint scheme was equally silent per-file, but incremental mode makes the poison point permanent and invisible.
- **Why missed**: design assumes tail buffer only ever holds an *incomplete-but-eventually-complete* record. No invalid-vs-incomplete distinction, no give-up heuristic.
- **Severity**: 4
- **Mitigation**: max-tail-size / max-lines-accumulated cap → treat as dead record, skip to next line boundary (log), advance offset. Track `deadRecords` counter in registry entry for diagnostics.

### G2. Byte-offset vs decoded-string mismatch (UTF-8, surrogates, chunk boundaries)
- **What**: parser reads file as utf-8 string and splits on `"\n"`. Watermark offsets are bytes. If offset derived from string length/indices (chars) instead of Buffer byte length, resume reads the wrong position whenever multi-byte chars precede it. Also: incremental read sliced mid-multi-byte-char or mid-surrogate-pair corrupts the tail; storing tail as a JS string destroys those bytes (replacement chars) and breaks resume.
- **Why missed**: schema names `offset` with no unit; existing code is string-based throughout.
- **Severity**: 4
- **Mitigation**: define offset in bytes; read with Buffer + `StringDecoder` for partial-char-safe chunk boundaries; persist `tail` as base64 (raw bytes), never normalized string.

### G3. `size < offset` misses in-place rewrites and atomic replaces at size ≥ offset
- **What**: truncation detection is only `size < offset`. (a) Compaction rewrite where new size happens to be ≥ stale offset; (b) file replaced via rename (new inode) with larger/different content — path key unchanged. In both, resume reads unrelated bytes at stale offset → garbage records or, worse, *plausible* records → wrong matches, no error.
- **Why missed**: only the shrink case was modeled; same-size/larger rewrites and inode replacement unconsidered. No content verification at the resume point.
- **Severity**: 4
- **Mitigation**: store anchor — hash (or raw copy, it's already there) of last K bytes before offset; on resume, verify anchor before trusting offset. Cheap: the stored `tail` doubles as this anchor (see G4). Optionally track `{dev, ino}` to detect replace.

### G4. `tail` semantics undecided — resume-from vs validation-anchor (dual purpose)
- **What**: schema stores both `offset` (end of last complete record) and `tail` (partial bytes after it). On next scan, does the reader start at `offset` (tail redundant — re-read covers it) or at `offset - tail.length` (double-parse risk for completed records)? Undecided. Meanwhile `tail` is exactly the content anchor needed to detect G3 — a use the sketch never mentions.
- **Why missed**: tail treated as resume buffer only; its value as rewrite-detector unexploited.
- **Severity**: 3
- **Mitigation**: define: resume always reads from `offset`; `tail` used solely to (a) cap re-read of dead partials and (b) anchor-verify bytes at `offset - tail.length .. offset` match — mismatch ⇒ full reparse. Must store raw (see G2).

### G5. "End of last complete record" boundary ambiguity → double-count of last record
- **What**: if offset lands on `}` rather than past the trailing `\n`, next incremental read re-ingests the last complete record; read-tool `loads` counts and matchedVariants increment twice. Opposite off-by-one (past the next record's first line) loses a record. Blank lines between records make the "right" boundary non-obvious.
- **Why missed**: boundary defined as "end of record" without byte-exact spec.
- **Severity**: 3
- **Mitigation**: spec offset = byte index immediately after the terminating newline of the last complete record (or of the last consumed line, including skipped blanks). Add a round-trip test: parse(file) === parse(file[0..offset]) ⊕ parseIncremental(file[offset..]).

### G6. Per-file token dedup (`seen` set) not persisted → incremental mention counts inflate
- **What**: `extractSkillMentions` dedupes tokens per file per parse call. Under incremental scans, a token first seen in segment 1 and re-seen in segment 2 is counted again — `mentions` drift upward every append. Old whole-file reparse made the set implicit; watermark mode breaks that assumption.
- **Why missed**: parser state assumed stateless-per-file; incrementalization makes parser state part of cache state.
- **Severity**: 4
- **Mitigation**: persist deduped token vocabulary in the registry entry (it's small — see I4) and union on each segment; or move dedup to a mergeable key (file, token) at aggregation.

### G7. Two-store consistency: registry (offset) vs matches cache — no commit-point rule
- **What**: watermark + cached matches live in separate structures; crash between their writes yields (a) offset advanced, matches lost → gap never healed, or (b) matches written, offset stale → re-parse overlap → double-append if any store appends. Existing cache flushes only on `close()` (cache.ts) — long crash window.
- **Why missed**: single-store thinking; ordering/atomicity of the two writes unspecified.
- **Severity**: 3
- **Mitigation**: rule: write matches first, watermark last (watermark = commit record); both via tmp+rename atomic writes; re-parse overlap must be idempotent (replace segment, never append).

### G8. Concurrent analyzer runs race the registry
- **What**: cron weekly + manual invocation overlap → both scan, both rewrite registry/entries, last-writer-wins, offsets/matches from one run lost or interleaved.
- **Why missed**: single-instance assumption.
- **Severity**: 3
- **Mitigation**: lockfile (with staleness takeover) around scan+flush.

### G9. Registry rewrite churn & unbounded growth
- **What**: entry embeds matches + tail; single registry file rewritten wholesale each run (or sharded rewrites). Deleted/aged-out session paths accumulate unless vacuumed; vacuum keyed to *current scan set* also nukes entries for files merely outside the mtime window (existing behavior) → later wider query = full cold.
- **Why missed**: lifecycle (prune policy, retention vs window) unspecified.
- **Severity**: 2 (3 if registry is single-file JSON at ~1500 entries with payloads)
- **Mitigation**: separate hot watermark metadata from bulky match data; prune by registry-entry age, not scan-window membership; atomic per-entry files (existing sharded layout) over one monolith.

### G10. Migration from fingerprint cache
- **What**: existing on-disk entries have `{fingerprint, matches}` — no offset. Redeploy with watermark scheme: undefined whether old entries are reused, ignored, or cause mismatched reads.
- **Why missed**: redesign assumes greenfield registry.
- **Severity**: 3
- **Mitigation**: one-time migration rule: old entries readable as full-file aggregates with offset=undefined ⇒ treat as cold, vacuum old format in same run; version the registry file itself.

### G11. mtimeNs fast-path fragility
- **What**: Bun Stats lack mtimeNs — analyzer synthesizes `mtimeMs*1e6` (analyzer.ts:81) → 1ms granularity; some FS/mounts (network, coarse timestamps, `cp -p`/rsync preserving times) yield same size+mtime with different content → false "unchanged". Also: nothing changed but mtime touched (editor, indexer) → wasted incremental read, and if registry stores latest mtimeNs each pass, churn.
- **Why missed**: fast-path spec leans on stat fidelity it doesn't have everywhere.
- **Severity**: 2
- **Mitigation**: anchor check (G4) as cheap second gate on size-equal+mtime-equal hits is overkill; instead accept, but make anchor verification run when size equal & mtime equal & anchor stored cheaply (hash only, no read) — or document accepted risk.

### G12. Parser accepts non-object JSON lines as "complete records"
- **What**: a line that is itself valid non-object JSON (`123`, `"x"`, `true`) makes `parseJsonl` yield and reset the buffer mid-logical-record in pathological multi-line content; typed as `Record` but isn't.
- **Why missed**: yield-on-parse-success has no object-shape guard.
- **Severity**: 1 (theoretical in real session logs)
- **Mitigation**: `typeof obj === "object" && obj !== null` guard before yield; else keep accumulating.

---

## OT2 — inventoryHash semantics

### H1. OT2 and OT3 are coupled — aggregated payload forecloses selective invalidation
- **What**: "new/renamed skill should only invalidate matching entries" requires re-evaluating cached *tokens* against the new inventory. If OT3 picks aggregated counts, the raw evidence is gone → any inventory change degenerates to full reparse. The two "unresolved decisions" are not independent; deciding OT3 first silently decides OT2.
- **Why missed**: units reviewed separately; dependency unstated.
- **Severity**: 4
- **Mitigation**: decide jointly. See H2 for the option that dissolves the decision.

### H2. Selective invalidation is impossible for NEW skills even with raw matches cached — only raw *tokens* work
- **What**: cached `SkillMatch[]` records what matched the OLD inventory. A newly added skill `foo` would have fuzzy-matched previously-unmatched tokens (`fooo`, `fob`) — those tokens are absent from the cache, so "invalidate only entries that mention affected skills" can never fire for additions; every entry is potentially affected. Only inventory-independent data (deduped token vocab + read-tool events) permits cheap selective re-match.
- **Why missed**: cache payload assumed to be matches; the inventory-independent layer (tokens) was never considered as the cache unit.
- **Severity**: 4 (this is the fundamental gap — and the fix)
- **Mitigation**: cache deduped tokens + read-events per file (inventory-agnostic); match against inventory at aggregation time (CPU-cheap, ~hundreds of tokens/file). Then `inventoryHash` becomes unnecessary — inventory is just a query-time input. Kills OT2 entirely.

### H3. Rename orphans history; heatmap can retroactively kill a heavily-used skill
- **What**: rename `old-x`→`new-x`: read-tool matches (exact path) for old name stop being produced; text mentions survive only via fuzzy/alias luck. If report/curator treats new name as a new skill with zero history, a heavily used skill looks unused.
- **Why missed**: invalidation framed as cache correctness, not report continuity.
- **Severity**: 3
- **Mitigation**: rename detection (same SKILL.md dir path-similarity, or explicit alias `formerly:` field); merge old-name aggregates into new with a `renamedFrom` note; or minimum-history grace period before a skill is considered unused.

### H4. inventoryHash must be canonical or it self-invalidates
- **What**: inventory loading is order-dependent (first-dir-wins dedup, hidden-dir skip). Hash of an unsorted, traversal-order-derived structure flips on readdir order → spurious full invalidation storms.
- **Why missed**: hash stability assumed.
- **Severity**: 3
- **Mitigation**: hash = sha256 of sorted `${name}|${sorted aliases}` lines only (drop descriptions/paths from the hash — they don't affect matching).

### H5. Silent empty inventory poisons everything
- **What**: `loadSkillInventory` returns `[]` on unreadable/typo'd dirs without error. inventoryHash("") → every cached match matches nothing → empty report, cache possibly vacuumed. User sees "no usage", not "bad inventoryDir".
- **Why missed**: failure mode of inventory load unexamined in invalidation design.
- **Severity**: 3
- **Mitigation**: hard-fail (or loud warning + skip cache write) when inventoryDirs yield zero entries; never vacuum/overwrite on empty inventory.

---

## OT3 — Cache payload: raw matches vs aggregated counts

### I1. Aggregation is not incrementally mergeable
- **What**: proposed aggregated counts assume `agg(seg1) + agg(seg2) = agg(whole)`. False for: per-file token dedup (G6), `sessions` union (same session in both segments double-counted), `mentionedInSessions`/`loadedInSessions` lists, matchedVariants under dedup. Only loads-count, firstSeen/lastSeen, and mentions-without-dedup are additive. Incremental appends + per-entry aggregates = counts that drift per scan.
- **Why missed**: aggregation treated as associative/commutative merge; it isn't for its dedup-based fields.
- **Severity**: 4
- **Mitigation**: persist mergeable primitives (token vocab per file, read-event list, session id) and aggregate only at report time.

### I2. Aggregated counts = regression vs today for window re-queries and cold-start
- **What**: current cache stores full `SkillMatch[]` with timestamps — a `--days` change re-aggregates from cache, no IO. Aggregated counts lose timestamps → any different window ⇒ full reparse of every file (the exact cost the redesign exists to avoid), and the "binary-search cold-start path" has nothing to binary-search over.
- **Why missed**: current capability taken as baseline-free; no comparison of what raw matches already enable.
- **Severity**: 4
- **Mitigation**: same as H2/I1: tokens + per-token time bounds; aggregation at query time supports any window.

### I3. Token dedup collapses time — one timestamp per token per file
- **What**: parser keeps only the FIRST timestamp per deduped token. Skill mentioned on day 1 and day 6: cache carries day-1 ts only → a `--days 2` window query drops it; a `--days 7` includes it. Window re-query results depend on run history, not truth. Redesign inherits this; OT3's "re-aggregation semantics" cannot fix it because the data was discarded at parse time.
- **Why missed**: per-file dedup conflated identity with occurrence; temporal multiplicity never modeled.
- **Severity**: 4
- **Mitigation**: store per-token `{first, last}` (cheap) or per-(token, day-bucket) counts if intra-window counts must be exact.

### I4. The "smaller cache" rationale is weak
- **What**: deduped token vocabulary per session is already tiny (hundreds of entries); the bulk of today's cache is `SkillMatch` objects + matchedVariants, which the token-payload also eliminates. Aggregated counts save little versus a token set and give up everything (H1/H2/I1/I2).
- **Why missed**: size estimate made against raw matches, not against the third option (tokens).
- **Severity**: 2
- **Mitigation**: adopt token payload; size argument evaporates.

### I5. Compaction rewrite retroactively shrinks history
- **What**: on truncation/rewrite the correct action is full reparse of the new file, REPLACING the entry — pre-compaction matches vanish from the report. Weekly totals for a compacted session silently decrease on later runs; trend lines wobble downward. Not a correctness bug (new file is the truth) but an unmodeled report semantic.
- **Why missed**: rewrite handling framed purely as cache-consistency, not data-loss visibility.
- **Severity**: 3
- **Mitigation**: keep `eventsLostOnRewrite` counter / preserve prior aggregates with `asOf` marker instead of dropping; report compaction-affected sessions.

---

## Cross-cutting / global

### X1. Live-session TOCTOU between stat and read
- **What**: active pi session appending while analyzer runs: stat(size) then read may capture more bytes than stat reported (fine if offset tracks parsed truth, not stat size) or the file truncates mid-read (slice misaligned). Registry `size` field must record *observed-at-scan* size, never used as resume truth.
- **Why missed**: interleaving of stat/read/parse not sequenced in design.
- **Severity**: 3
- **Mitigation**: resume truth = offset+tail only; size/mtime purely fast-path hints; tolerate short reads / re-stat on parse anomaly.

### X2. Path keying hazards: symlinks, case, moved sessionsDir
- **What**: registry keyed by path: same file reachable via two paths (symlink, nested discovery overlap) → two entries → double-count in report; sessionsDir moved/renamed → all entries orphaned, vacuum deletes history, full cold rebuild.
- **Why missed**: path assumed stable + unique.
- **Severity**: 2
- **Mitigation**: `realpath()` keys; orphan entries grace-period (retire, don't vacuum immediately); optionally key by content-hash of first record (session id) instead of path.

### X3. Newline normalization on resume
- **What**: parser normalizes `\n`→space before parse. Tail must be persisted RAW (pre-normalization); storing the normalized form corrupts resumed parsing of multi-line string fields (byte counts off, JSON shape altered differently than fresh parse). Also `\r\n` files: split on `\n` leaves `\r` (JSON-legal whitespace, benign) but tail/offset math must count those bytes.
- **Why missed**: normalization is an implementation detail invisible at schema level.
- **Severity**: 3
- **Mitigation**: persist raw bytes (base64); normalization applied per-parse-attempt, never persisted. (Merges with G2.)

### X4. parserVersion bump semantics unstated
- **What**: entries will hold mixed parserVersions after a bump; rule "bump ⇒ discard offset, full reparse" is implied but unwritten, and mixed-version registries need filtering on load.
- **Severity**: 2
- **Mitigation**: one line of spec + registry-level `minParserVersion` gate; on bump, keep old entries until replaced (lazy) or purge (eager) — pick one.

---

## Summary table

| ID | Sev | One-liner |
|----|-----|-----------|
| G1 | 4 | Corrupt record poisons all subsequent records, offset never advances |
| G2 | 4 | Char-vs-byte offset, UTF-8 boundary, tail must be raw bytes |
| G3 | 4 | size≥offset rewrites & inode replace undetected — need content anchor |
| G4 | 3 | tail dual-purpose (resume vs anchor) undecided |
| G5 | 3 | Offset boundary off-by-one → double-count |
| G6 | 4 | Per-file token dedup state not persisted → incremental inflation |
| G7 | 3 | Registry/cache two-write crash consistency, commit point |
| G8 | 3 | Concurrent runs race registry |
| G9 | 2 | Registry churn/growth; vacuum-vs-window coupling |
| G10 | 3 | Fingerprint→watermark migration undefined |
| G11 | 2 | mtimeNs synth granularity / timestamp-preserving copies |
| G12 | 1 | Non-object JSON line yields as record |
| H1 | 4 | OT2–OT3 coupled; aggregated payload forecloses OT2 |
| H2 | 4 | Selective invalidation impossible for new skills unless tokens cached |
| H3 | 3 | Rename orphans usage history |
| H4 | 3 | inventoryHash needs canonicalization |
| H5 | 3 | Silent empty inventory nukes report |
| I1 | 4 | Aggregation not incrementally mergeable (dedup/session fields) |
| I2 | 4 | Aggregated counts regress window re-query vs current cache |
| I3 | 4 | Token dedup keeps first timestamp only — temporal collapse |
| I4 | 2 | Size rationale weak vs token-payload option |
| I5 | 3 | Compaction rewrite retroactively shrinks history |
| X1 | 3 | Live-session stat/read TOCTOU |
| X2 | 2 | Path keys: symlinks/moves double-count or orphan |
| X3 | 3 | Persisted tail must be pre-normalization raw |
| X4 | 2 | parserVersion bump semantics unstated |

**Dominant finding**: severities cluster on one root decision — cache inventory-independent per-file token vocab + read-events (with per-token time bounds) instead of matches or counts. That single choice dissolves H1, H2, I1–I4, G6, and makes inventoryHash unnecessary.
