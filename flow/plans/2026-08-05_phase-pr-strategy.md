# oas-cs Multi-Phase PR Strategy

## [E1] Current state (as of 2026-08-05)
- Repo: `buihongduc132/open-agent-sessions`
- HEAD: `a581dd9` (detached — see [CA1])
- Local branch `feat/oas-command-stats`: `b4ceecd` (1 commit BEHIND detached HEAD)
- Remote: NO `origin/feat/oas-command-stats` yet (unpushed)
- Ahead of `origin/main`: **27 commits**
- Behind `origin/main`: **0 commits** → no rebase needed NOW

## [C1] PR strategy decision

**Single squash PR after all phases complete.**

### Why single squash (NOT per-phase)
- All phases gated on prior verifier hash → atomic ship keeps TDD chain intact
- Per-phase PRs would re-trigger bot cycles (gemini/cubic) on shared schema files (`schema.ts`, `ingest.ts`) → noise cascade
- Phase 5 GREEN in-progress + Phase 6 not started → per-phase today = broken intermediate state
- pr-creation skill mandates verifier-loop approval BEFORE push → defer until green across all phases

### Why NOT per-phase
- Would expose half-baked schema churn mid-flight to bot reviewers
- Phase 2 schema is reused by Phase 3/4/5 → diff churn on every per-phase PR

## [F1] PR draft (fill hashes when phases land)

### Title
```
feat(oas-cs): multi-phase ingestion system for CLI agent bash command stats
```

### Body skeleton
```markdown
## Summary
- 6-phase TDD ingestion system for CLI agent bash command telemetry
- SDK carve-out + extract/parse/DuckDB storage + PII redaction + crash recovery + sysops queries

## Phases (verifier hashes)
| Phase | Scope | RED | GREEN | Verifier hash | Status |
|-------|-------|-----|-------|---------------|--------|
| 1 (SDK) | `@open-agent-sessions/sdk` carve-out | `8b934da` | `3403888` | `080526-08fed2e4` | DONE |
| 2 (extract+parse+storage) | DuckDB + ingest batch + idempotency | `1080521` | `167ac17` | `26c617c3` | DONE |
| 3 (cwd+repo) | effective_cwd + repo derivation | `febc81d`/`555bc92` | `9702721` | _PENDING_ | DONE |
| 4 (PII) | redaction + retention (GDPR Art.6) | `37f4e24` | `abf792d` | _PENDING_ | DONE |
| 5 (crash+concurrency) | OT18 readonly + crash recovery | `b4ceecd` | _in-progress_ | _PENDING_ | WIP |
| 6 (sysops queries) | top-N + filters + exports | — | — | _PENDING_ | NOT-STARTED |

## Resolves
- OT20 (multi-source ingestion)
- OT23 (parse fidelity)
- OT24 (cwd/repo derivation rank5)
- OT30 (PII redaction + GDPR retention)
- OT45 (sysops query surface)
- LD1-LD5 (lessons-learned from LSL entries 2-6)

## Test plan
- [ ] `bun test` — all unit + integration green
- [ ] `oas-command-stats/scripts/parse-rate.ts` — simple 100% / medium 100% / complex ≥99.8%
- [ ] typecheck clean
- [ ] verifier-loop approval (2+ unanimous) recorded per phase

## Commits (will be squash-merged)
- 27 commits ahead of `origin/main` (full list via `git log --oneline origin/main..HEAD`)
```

## [F1] Per-phase verifier hash table (to fill)

| Phase | RED commit | GREEN commit | Verifier hash | Notes |
|-------|-----------|--------------|---------------|-------|
| 1 | `8b934da` | `3403888` | `080526-08fed2e4` | SDK carve-out, public boundary |
| 2 | `1080521` | `167ac17` | `26c617c3` | self-audit; independent re-audit PENDING (FIX-2) |
| 3 | `febc81d`,`555bc92` | `9702721` | _PENDING_ | effective_cwd + repo |
| 4 | `37f4e24` | `abf792d` | _PENDING_ | PII + retention |
| 5 | `b4ceecd` | _WIP_ | _PENDING_ | crash + readonly |
| 6 | — | — | _PENDING_ | sysops queries |

## [R1] Rebase plan

### NOW
- `behind = 0` → **NO rebase needed.** Skip rebase to avoid colliding with parallel Phase 5 GREEN work on `duckdb.ts`/`schema.ts`/`crash.ts`.

### BEFORE PR push (when all phases green)
1. `git stash` (preserve any WIP) — only if working tree dirty
2. `git fetch origin`
3. `git rev-list --count HEAD..origin/main`
4. If `>0`: `git rebase origin/main` → resolve conflicts (expect: `schema.ts`, `ingest.ts`, AGENTS.md if main moved)
5. `git push -u origin feat/oas-command-stats`
6. Create PR via `gh pr create` (or REST API fallback per pr-creation skill `references/github-pr-api.md`)

### Conflict forecast (if main moves)
- `AGENTS.md` — high risk (lesson_learn block churns per phase)
- `oas-command-stats/src/storage/schema.ts` — medium (Phase 2 baseline; new cols additive)
- `flow/lesson_learn/*` — low (date-prefixed dirs, unlikely collision)

## [A] Assumptions
- Parallel sub-agent owns Phase 5 GREEN writes to `src/storage/{duckdb,schema,crash}.ts` — DO NOT TOUCH
- Detached HEAD at `a581dd9` is intentional (avoid branch-write race with Phase 5 GREEN committer)
- `feat/oas-command-stats` local branch will be fast-forwarded to HEAD before push
- Squash-merge preserves verifier-hash chain in commit body (not PR description)

## [CA1] Pre-PR blockers / conflicts

| # | Issue | Impact | Mitigation |
|---|-------|--------|-----------|
| CA1.1 | Detached HEAD — branch `feat/oas-command-stats` 1 commit behind HEAD | PR cannot push detached HEAD | `git branch -f feat/oas-command-stats HEAD` once Phase 5 GREEN committed; then push |
| CA1.2 | Phase 5 GREEN uncommitted (`duckdb.ts`, `schema.ts`, `crash.ts` modified/untracked) | Cannot rebase safely until committed | Wait for parallel sub-agent to commit GREEN; THEN re-check behind count |
| CA1.3 | No `origin/feat/oas-command-stats` remote branch | First push needs `-u` | `git push -u origin feat/oas-command-stats` after fast-forward |
| CA1.4 | Phase 2 verifier hash is self-audit only (`26c617c3`); independent re-audit PENDING (FIX-2) | Bot reviewers may flag single-verifier gate | Run independent verifier before PR; document in body |
| CA1.5 | Phases 3/4/5/6 verifier hashes still PENDING | Per-phase TDD gate incomplete | Each phase gets its own verifier-loop before squash |
| CA1.6 | Runtime churn in working tree (`.pi-opa-net/`, `.pi-subagents/`, `.verify-p2/`, `.opencode/`) | Accidental commit risk | Explicit `git add <path>` only; never `git add -A` |

## [T1] Pre-PR checklist (run when all phases green)
```bash
# 1. Fast-forward branch to HEAD
git branch -f feat/oas-command-stats HEAD
git checkout feat/oas-command-stats

# 2. Re-check behind count
git fetch origin
git rev-list --count HEAD..origin/main   # must be 0 (or rebase)

# 3. Run test suite
cd oas-command-stats && bun test

# 4. Parse-rate sanity
bun run scripts/parse-rate.ts

# 5. Verifier-loop (per pr-creation skill)
# delegate @verifier → @build fix loop → 2+ unanimous APPROVE

# 6. Push + create PR
git push -u origin feat/oas-command-stats
gh pr create --title "feat(oas-cs): multi-phase ingestion system..." --body-file <(cat body.md)
```

## Refs
- pr-creation skill: `/home/bhd/.agents/skills/pr-creation/SKILL.md`
- Phase 2 plan: `flow/plans/2026-08-05_phase2-extraction-core/README.md`
- Phase 2 progress: `flow/progress/2026-08-05_phase-2-extract-parse-storage.md`
- Goal: `_GOAL_open-agent-sessions.md`
- Ceremony contract: verification items 8 (rebase) + 9 (pr-creation skill)
