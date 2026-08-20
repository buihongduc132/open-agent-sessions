# Skill Usage Perf Watermark

> Date range: 2026-08-15 → 2026-08-15
> Status: explore-ongoing

## Topics

### perf / caching / high-watermark (2026-08-15)
Explored user-side perf of skill-usage analyzer (`src/skill-usage/`). Found 5 cost causes C1–C5 (whole-file fingerprint invalidation, vacuum self-destruct, no token memo, O(k²) parseJsonl, sequential scan). Designed byte-offset watermark registry adapted from Filebeat filestream (offset + partial-tail buffer + truncation detect). Turn 2 stress-tested user's binary-search idea: rejected as primary (boundary free via size compare; warm-cache probes buy nothing), accepted as cold-start fallback (timestamp probe + min-chunk landing). Recommendation order: watermark → vacuum fix → token memo → session-end hook.

### gotcha coverage (2026-08-15)
Two reviewer batches over OT1–OT6 (appendices turn1a + turn2a). Zero rank-5, but 21 rank-4 + 16 rank-3 gotchas; consolidated into OT7–OT14. Dominant finding: cache payload must be inventory-independent tokens + read-events w/ per-token time bounds (OT7) — dissolves OT2/OT3 and gates everything else. Also surfaced: OT11 report-correctness bug (--days filters files by mtime, never filters matches by timestamp) independent of perf work. No locked decisions to supersede (none exist).

## Pick up next time
1. `2026-08-15-turn1-perf-caching-watermark.md` — causes C1–C5 + watermark design + caching table
2. `2026-08-15-turn2-binary-search-probing.md` — binary-search verdict (fallback, not primary)
3. Open: OT4 (vacuum semantics fix — trivial, do first), OT2 (inventoryHash semantics), OT3 (cache payload: raw matches vs aggregated counts)
4. Capture as change when ready: `/opsx:new` or `/opsx:ff`
