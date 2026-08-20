# References

> Sources consulted during this explore session.

## Source files
- `src/skill-usage/analyzer.ts` — pipeline orchestration: discovery, mtime filter, fingerprint loop, vacuum, aggregate. Source of C1/C2/C5 cost analysis.
- `src/skill-usage/cache.ts` — JSON sharded filesystem cache; fingerprint = sha256(path|size|mtimeNs|parserVersion); eager full load; vacuum drops non-existent fingerprints. Source of C2.
- `src/skill-usage/parser.ts` — parseJsonl multi-line accumulation (O(k²) re-parse risk), extractSkillReads (read toolCall SKILL.md path match), mention tokenizer (words + hyphen/space bigrams).
- `src/skill-usage/fuzzy.ts` — 4-tier matchTier (exact/normalized/alias/restricted-DL), canonicalize. Source of C3 (no memoization, per-skill loop).
- `src/skill-usage/types.ts` — SkillMatch/SkillUsageOptions surface; `cacheFormat: "sqlite"` reserved; parserVersion invalidation knob.
- `scripts/skill-usage-heatmap.ts` — weekly runner invoking analyzer (referenced; not read this session).
- `~/.pi/agent/prompts/_references/10-ospx-explore/search-strategies.md` — explore-mode search playbook followed.

## Documents
- https://www.elastic.co/docs/reference/beats/filebeat/how-filebeat-works — harvester/registry model; state = last offset per file, flushed to registry; at-least-once delivery.
- https://www.elastic.co/docs/reference/beats/filebeat/file-identity — file identity strategies (path/native/fingerprint); growing fingerprint (9.5); rename/truncation handling.
- https://www.elastic.co/docs/reference/beats/filebeat/configuration-general-options — registry backends (memlog/bbolt), registry.flush, fsync tradeoffs.
- https://www.elastic.co/blog/introducing-filestream-fingerprint-mode — fingerprint mode perf numbers; open/close cost dominates hashing; inode-reuse skip risk.
- https://github.com/elastic/beats/issues/30279 — registry.flush default change; per-event checkpointing = CPU/SSD killer (used to justify once-at-close flush).
- https://github.com/elastic/beats/issues/33382 — registry growth with huge file counts; checkpoint size hardcode perf issues.

## Code patterns
- Filebeat filestream registry pattern — per-file offset watermark + partial-state persistence + truncation detection → adapted for session JSONL ingest (turn 1).
- Append-only tailing with seek(offset) — parse only appended bytes; guard against boundary-split multi-line JSON records (turn 1 watermark design).
- Binary search over append-ordered timestamps with min-chunk landing — cold-start window accelerator (turn 2), capped-probe (4KB regex timestamp extraction).
