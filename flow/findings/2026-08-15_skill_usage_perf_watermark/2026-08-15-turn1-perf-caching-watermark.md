# Explore Turn 1 — perf / caching / high-watermark on user side

- Date: 2026-08-15
- Phase: exploration (explore mode, `/10-ospx-explore`)
- Status: complete

## User input

> **[user]** (verbatim — trust chain L1)
>
> a. how to improve performance of this on user side; what are caching / highwatermark that we can do ?

Context: question targets the skill-usage analyzer (`src/skill-usage/`) + weekly runner `scripts/skill-usage-heatmap.ts`.

## Assistant response (as-is)

**Explored against real evidence** (code read: `analyzer.ts`, `cache.ts`, `parser.ts`, `fuzzy.ts` + Filebeat filestream design docs/issues — the canonical "incremental file tailing with high-watermark" reference).

## Current cost model

```
weekly run (user side)
  readdir 1-level            → cheap
  stat × every file (×3: discover, mtime filter, fingerprint loop)
  ── mtime filter (days)     → coarse pre-cut, good
  per surviving session:
    fingerprint = sha256(path|size|mtimeNs|parserVer)
    hit  → load cached matches        ✅ zero read of session file
    miss → readFileSync FULL file → parseJsonl → tokenize ALL text
           → matchTier × every token × every skill (T1..T4)
```

## Where time actually goes [E1]

- [C1] **Whole-file fingerprint** — session JSONL is append-only, but ANY append (mtime/size change) invalidates → full reparse. Biggest waste; 99% of bytes unchanged.
- [C2] **Vacuum kills out-of-window cache** — `vacuum(existingFps)` keeps only sessions in the `--days` window. Run `--days 7` then `--days 30` → full reparse of week 2–4. Cache self-destructs.
- [C3] **No token memoization** — `matchTier` runs T1–T4 vs every skill for every token occurrence. Natural language repeats tokens massively; distinct-token set is small. Also T1/T2/T3 are re-computed per skill per token instead of O(1) map lookups.
- [C4] **`parseJsonl` O(k²) on multi-line records** — buffer re-`JSON.parse`d (plus regex replace over whole buffer) after every appended line until it validates.
- [C5] **Fully sequential** — no concurrency across sessions (I/O + parse embarrassingly parallel).

## High-watermark design (the real ask)

Cherry-picked from Filebeat filestream (registry = offset store per file, `file_identity.fingerprint` = first-N-bytes content hash instead of unstable metadata):

```
Registry entry per session (replace whole-file fp):
{
  path, parserVersion, inventoryHash,
  offset,        // ← watermark: byte offset AFTER last complete JSON record
  tail,          // residual partial-line buffer (or its byte length)
  size, mtimeNs, // fast-path compare
  matches        // or aggregated counts (smaller cache)
}

Rescan logic per file:
  stat(file)
  ├─ size == cached.size && mtime equal  → SKIP, no open at all
  ├─ size >  cached.size                 → seek(offset), parse TAIL only,
  │                                         merge new matches
  ├─ size <  cached.size                 → rewrite/compaction → full reparse
  └─ parserVersion/inventoryHash changed → full reparse
```

Key details stolen from Filebeat's battle log:
- **Watermark = end of last *complete* record**, keep the partial tail buffer — your `parseJsonl` accumulation makes cross-offset multi-line JSON records a real case (session text with literal `\n`). Without this you get boundary-split records → lost/dup matches. Duplicates matter here: they inflate counts (Filebeat tolerates at-least-once; heatmap counts don't).
- **size < offset = truncation signal** — pi compaction rewrites files; must detect, not silently skip.
- **Content fingerprint not needed** — Filebeat needs it for rename/inode-reuse across millions of files; you have ~1.5k stable per-machine paths. path+size+mtime is fine. Don't import complexity you don't have.
- **Flush throttle** — registry.write once at `close()`, not per session (Filebeat issue #30279: per-event checkpointing = CPU/SSD killer). You already do this. ✅

Expected effect: steady-state weekly run parses only bytes appended in the last 7 days. From "rescan every touched session in full" → O(delta).

## Caching wins beyond watermark

| Fix | Cost | Gain |
|---|---|---|
| Stop vacuuming out-of-window entries; vacuum only on `unlink` check or age TTL [C2] | trivial | `--days` changes stop nuking cache |
| Precompute `exactSet` / `canonicalMap` / `aliasSet`; per-run `Map<token, MatchResult>` memo [C3] | small | matching ~distinct tokens instead of ~all tokens × all skills |
| Length-bucket fuzzy index (candidate len ± maxDistance) | small | skips DL for 95%+ tokens |
| Store **aggregated counts** per session in cache instead of raw `SkillMatch[]` | small | cache shrinks, `allMatches` memory drop |
| Parallel parse (p-limit 4–8) [C5] | small | wall-clock ×N |
| Brace-count pre-scan in `parseJsonl` before `JSON.parse` attempt [C4] | small | kills O(k²) |
| SQLite backend (already reserved in `types.ts`) | medium | single-file cache, lazy load vs eager-every-entry; only worth it if cache grows |

## Biggest user-side win (zero-scan)

Watermark optimizes the scan. Event-driven eliminates it: **pi session-end hook** appends matches for the just-closed session incrementally. Weekly heatmap = pure read of precomputed aggregates. That's the end-state; watermark is the right intermediate since hooks need the same offset-correctness logic anyway.

```
now:      scan --days 7 → reparse every touched session fully
watermark:scan --days 7 → parse only appended tails
hook:     session close → update in real time; weekly run ≈ free
```

## Recommendation

1. Watermark registry (offset + tail + truncation detect) — biggest structural win.
2. Fix vacuum semantics (keep out-of-window entries) — trivial, do immediately.
3. Token memo + set-based T1–T3 — biggest per-parse win.
4. Session-end hook — end state, defer until 1–3 land.

Want to capture as a change? `/opsx:new` or `/opsx:ff` — else this stays as thinking.

## Status at end of turn 1

Explored perf causes C1–C5, watermark design from Filebeat, caching table, end-state hook proposal. No decisions locked. → Turn 2 (user proposes invalidating C1 via binary search).
