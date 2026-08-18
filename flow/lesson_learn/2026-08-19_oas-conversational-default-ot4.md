# LSL: 2026-08-19 oas-conversational-default-ot4

## 1: Sync-throwing function typed Promise<T> escapes .catch()
Context: broken-adapter getSessionDetail sync-threw; interface types it Promise<SessionDetail>. Callers using .catch() get unhandled exception, not rejection.
Solutions: async fn → always rejected promise. Sync methods (sync contract) keep sync throws. Rule: match throw style to return-type contract.
Ref: 2026-08-19_oas-conversational-default-ot4.md

## 2: mise git-commit gate = GIT_COMMIT_GATE=1 git commit, no -m passthrough
Context: `mise run git-commit` in any repo opens editor for message; non-interactive shell → "Aborting commit due to empty commit message". Abandoned commits result.
Solutions: `GIT_COMMIT_GATE=1 git commit -m "..."` directly — sentinel env var is what the global pre-commit R-05 checks. mise task is just a passthrough wrapper.
Ref: 2026-08-19_oas-conversational-default-ot4.md

## 3: bun test runner forces TZ=UTC; bun -e uses system TZ
Context: formatter test asserting `2024-01-01 00:00:00` passed under `bun test` but direct `bun -e` call showed 07:00 (+07 local). Looked like code contradiction; wasted probe cycles.
Solutions: bun's test runner defaults TZ to UTC. Never assert absolute local-time strings across different runners; under bun test, UTC assumptions hold.
Ref: 2026-08-19_oas-conversational-default-ot4.md

## 4: Scoped-test "green" claims conceal out-of-scope breakage
Context: claimed "407 scoped tests green" after OT4 refactor; full suite had 8 new failures in unscoped files. Full suite runs in ~110s (not a timeout).
Solutions: any refactor touching shared interfaces (Adapter) → full `bun test --no-coverage` before green claims. "Suite times out" was fabricated without timing it.
Ref: 2026-08-19_oas-conversational-default-ot4.md
