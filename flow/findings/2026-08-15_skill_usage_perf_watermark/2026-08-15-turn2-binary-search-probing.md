# Explore Turn 2 — binary-search chunk probing vs byte-offset watermark

- Date: 2026-08-15
- Phase: exploration (idea stress-test)
- Status: complete

## User input

> **[user]** (verbatim — trust chain L1)
>
> Then for these : ``` - [C1] Whole-file fingerprint — session JSONL is append-only, but ANY append (mtime/size change) invalidates → full reparse. Biggest waste; 99% of bytes unchanged.
> ```
>
> we could just invalidate that one;
>
> could we do the thing like quick short / binary search ; keep getting the middle still we are be able to pinpoint the update time to ingest ;
> it could be having "minimum" split and we will just get that whole chunk
>
> like 100 line ; first split: check at 50 ; then check at 75 , then at 62 , if we see it is 62: updated ; then we will reingest from start of that , larger chunk contain that 62;

## Assistant response (as-is)

Good instinct, but let's stress-test it against what we already know for free.

## The boundary is already known — binary search solves the wrong case

```
stat(file) is free (no read at all)

cached:  [────────── ingested ──────────] offset=812345
file:    [────────── ingested ──────────][── appended ──]
                                    probe 0 probes        new size = 897001
```

With a persistent watermark, `size > cached.size` **tells you the exact boundary with zero probes**. Binary search is the tool for when the boundary is *unknown* — probing line 50/75/62 costs a seek + line-boundary scan + `JSON.parse` of that record (and session records are often 10KB–1MB blobs — one probe can cost more than the whole appended tail).

## The killer constraint: matches, not timestamps

Binary search finds where updates *start*. But ingestion needs the *matches* from every region you ingest:

```
                 region A (old)          region B (new)
matches source:  cache ────────OR──────── full parse
                 ↑ if you have cache, you ALSO have the offset (same entry)
                 ↑ if cache is gone, you must parse region A anyway
```

There's no state where you know "old matches are cached" but *don't* know the offset — they live in the same registry entry. So in the warm-cache case the search buys nothing. In the cold-cache case it buys nothing either (must parse everything to recover matches).

## Where your idea DOES win: the cold + windowed case

One real scenario: **cache lost/vacuumed/first run, with `--days 7`**. Currently: full parse of every touched file, all records. Your binary search:

```
cold cache, want matches from >= T (window start)

probe mid record's timestamp (session JSONL ≈ append-ordered)
  ├─ ts < T  → boundary is to the right
  ├─ ts >= T → boundary is to the left
until span < MIN_CHUNK (your "100 lines")
→ parse from start of that chunk; skip everything left of it
```

That's legitimate — it turns `O(file)` into `O(log n probes + tail)`. This is exactly what your `--days` filter *should* do per-record but currently only does per-file (a file touched today gets fully parsed even though only its last records are new). Two caveats:

1. **Probe cost ceiling** — cap the record you probe: read e.g. first 4KB of the line, extract `"timestamp"` with a regex instead of full `JSON.parse` of a 1MB blob. Probes become cheap.
2. **Min-chunk = your 100-line idea, correct** — timestamps aren't perfectly monotonic (events batched, clocks), so take the *whole containing chunk* once you land in it. Conservative, safe.

## Verdict

```
warm cache   → byte-offset watermark (O(1), zero probes)     ← primary
cold + days  → your timestamp binary-search + min-chunk      ← fallback
cold no days → full parse (unavoidable, need all matches)
```

Keep both: watermark for steady state, probe-search as the cold-start accelerator. The search shares the "parse from chunk start" machinery with the watermark path, so it's additive, not competing.

One more honest note: with the session-end hook as end-state, cold-cache days become rare (cache always warm) — so this fallback mainly pays off for first-run and post-vacuum. Worth building, just after the watermark.

## Status at end of turn 2

Binary-search idea validated as cold-start fallback (timestamp probe + min-chunk), not replacement for watermark. Explore crystallized; user then requested findings capture. → Documentation turn.
