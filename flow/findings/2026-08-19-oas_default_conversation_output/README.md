# oas default conversation output

> Date range: 2026-08-19 → 2026-08-19
> Status: explore-ongoing

## Topics

### oas-default-conversation-output (2026-08-19)

Explore how to change `oas session read <id>` default output from verbose (8-line header + `(agent/model) @ timestamp` badges + full reasoning walls + tools) to conversation-first (user + assistant text, 1-line header, no reasoning), with a new flag for full info.

**What explored:**
- Read command surface (`src/cli/read.ts`), formatter internals (`src/cli/formatters/text.ts`), export module (`src/core/export.ts`), types (`src/core/types.ts`), registry (`src/core/registry.ts`), bin dispatch (`bin/oas`).
- Test surface: 85 assertions across 4 files pin current verbose behavior.
- Real-session probe: opencode session `ses_0171b9e17ffeF8JyQOaul0TfyS` — 3 messages = 100% assistant, ~95% reasoning walls, signal:noise ≈ 1:10.
- Prior art: gptme (~6k★) `/log` command (hide-by-default + `--reasoning` opt-in), `hide=True` display-only flag pattern; cautionary tale #1999→#2001 (server-side stripping broke webui → reverted).

**What concluded:**
- Change target is purely display layer (`formatPart` in `src/cli/formatters/text.ts`); no data-path movement.
- `--tools` flag already establishes the exact precedent (formatter-layer hide-by-default + opt-in).
- Downstream (json/csf/markdown/detail/list/TUI) structurally immune — verified separate paths.
- 2 locked decisions (LD1, LD2): default = conversation view, full info behind flag, non-regression on downstream.
- 4 open threads: flag name (OT1), default count (OT2), sub-agent attribution (OT3), zcode registry-build throw (OT4, orthogonal severity-4).

**What open:**
- User has not answered the 3 open questions (flag name, default count, sub-agent attribution).
- zcode bug (OT4) blocks all local verification on this machine — workaround documented in turn-4 callback.

## Pick up next time

1. `2026-08-19-turn4-continue-real-sample-prior-art-summary.md` — the final summary with proposal sketch + open questions.
2. `2026-08-19-locked-decisions.yaml` — the 2 locked decisions (LD1, LD2) with verbatim user quotes.
3. `2026-08-19-open-threads.yaml` — 4 open threads; OT1/OT2/OT3 need user input before implementation; OT4 is orthogonal blocker for local verification.
4. `references.md` — all source files, documents, code patterns consulted.
