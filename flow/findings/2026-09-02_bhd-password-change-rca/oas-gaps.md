# OAS gaps hit during bhd-password RCA (2026-09-02)

Goal context demanded: use oas to find the sessions; if unable → it is an OAS problem →
fix and re-query. oas FAILED to find any of the involved sessions. Gaps, ranked:

## G1 — Multica-runtime pi sessions invisible (HIGH, hit directly) — ROOT CAUSE CONFIRMED

- Storage: `~/.multica/pi-sessions/*.jsonl` — FLAT dir, filename `<YYYYMMDDTHHmmSS.ns>.jsonl`
  (no session-id in name, no cwd-slug subdir). Content = standard pi session JSONL
  (message/toolResult records).
- pi adapter only scans subDIRECTORIES containing .jsonl files
  (`src/adapters/pi.ts` collectSessionDirs) → flat root files never read.
- Fix direction: pi adapter also reads flat `*.jsonl` files directly in the root
  (id = filename sans ext, title = first user message). Config gains
  `pi / alias=multica / path=~/.multica/pi-sessions`.

## G2 — Antigravity (agy) sessions entirely unindexed (HIGH, hit directly) — ROOT CAUSE CONFIRMED

- Storage: `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl`
  and `transcript_full.jsonl` (JSONL; fields: step_index, source USER_EXPLICIT/MODEL,
  type USER_INPUT/PLANNER_RESPONSE/GENERIC, created_at, content, tool_calls[].args).
- Adapter EXISTS (`src/adapters/antigravity.ts`) but is DOUBLY broken:
  1. Wrong default path `~/.gemini/antigravity` (real: `~/.gemini/antigravity-cli`);
     user config `oas.config.yaml` has the same wrong path → adapter throws
     `Antigravity path not found` on every call (swallowed as per-agent error).
  2. Even with the right path it is blind: listSessions/searchSessions/read use ONLY
     `overview.txt`, which does NOT exist in real brains (only transcript*.jsonl) →
     sessions list as 0-message uuid-stubs; content search can never match.
- Fix direction: default path → `~/.gemini/antigravity-cli` (fallback to legacy dir);
  parse transcript_full.jsonl for title/counts/search/detail.

## G3 — `oas session search` output has no matched-content context (MEDIUM)

- Output rows show title+id only; no snippet, no line number, no which-message matched.
  For forensics ("WHY did it change") you must then hand-parse raw JSONL anyway.
- Fix direction: `--context N` flag printing the matched chunk(s) per session.

## G4 — Content search misses agent kinds + title-only fallback noise (MEDIUM)

- `search --text <canonical>` surfaced many irrelevant grok verifier sessions (title/FTS
  partial matches) while the true actors scored nothing (G1/G2). Ranking gave no signal
  (no score, no matched-chunk count in text mode).
- Fix direction: show matched-chunk count / score in text output; boolean mode documented
  only in source (`search-boolean.ts`), not in `oas search --help` (USAGE string is 4 lines).

## G5 — `session list --until` rejects offsets without Z (LOW)

- `--until 2026-09-02T02:00:00` → "Time range cannot be in the future" (treated as... it
  requires explicit timezone; error message misleads). Accept `+07:00`/local or say
  "add timezone" explicitly.

## G6 — Search does not cover sibling transcript stores on same host (MEDIUM, design)

- Forensics span stores (multica chat tasks, antigravity brains, pi sessions, auth.log).
  oas covers per-agent session stores only; the chat→task→agent linkage
  (`~/.multica/*_workspaces*/<ws>/<task>/.task_owner` + `.gc_meta.json`) is what actually
  resolves "which session" — no oas command reads it.
- Fix direction: `oas task resolve <multica-task-id>` helper or a multica adapter reading
  .task_owner/.managed_env.json to map task→agent+session file.

## What oas DID do well

- `oas session search --text chpasswd` on indexed agents (grok/pi/omp) worked and its
  empty/wrong results were the signal that unindexed stores existed.

## Fixes shipped (2026-09-02, this RCA)

- RED tests: commit 9b1a8e2 (test/antigravity-adapter.test.ts, test/pi-adapter.test.ts)
- GREEN: commit 4c8a792 (antigravity path+transcript indexing; pi flat units; bin/oas
  createSearchService → shared createAllAgentFactories — antigravity/gemini/zcode/hermes
  were previously UNSEARCHABLE via the hardcoded chain; oas.config.yaml paths + pi:multica alias)
- Follow-up fix: commit ee9bddd (flat-file detail lookup unitSessionId + regression test)
- Verified: `oas session search --text chpasswd` → pi:multica + antigravity sessions top-ranked;
  `oas session read` works for both (agent:alias:id form); full suite baseline unchanged
  (4 pre-existing flakes only)
- G3/G4/G5/G6 remain open (matched-content context, ranking signals, --until UX, multica
  task-resolution helper)
