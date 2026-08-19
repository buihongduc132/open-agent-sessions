I have internet + empirical proof. Key finding verified by running the design's own parser against the design's own sample command:

- **PROGRAM detected: `echo`** (wrong — real command is `grep`)
- **pipeline_depth: 7** (wrong — real depth is 3: `grep | grep | head`; the 7 fragments come from `|` chars inside the quoted regex `"manual.*line|line.*item|POST.*line|/lines"`)
- **flags captured: `['-rnE']` only** (lost `-iE`, `-15`, and the `2>/dev/null` redirect)

Also confirmed the three real parser options exist and are current: **bashlex** (Python, port of GNU bash parser, handles `cat <(echo $(echo foo))`), **mvdan/sh** (Go, 8,940★, "bash **and zsh** support, includes shfmt"), **tree-sitter-bash** (C/WASM, 325★).

---

# Review — Parsing + Extraction Gotchas (OT5, OT6, OT7, OT8, LD5)

**Scope:** design doc `flow/findings/2026-08-04_oas-command-stats/2026-08-04-turn4-design-ingestion-system.md` + `2026-08-04-turn3-frameworks-granular-stats.md`. No files modified. Findings verified against the sample command in turn4 (`cd … && echo …; timeout 15 grep … | grep … | head -15`).

**Legend:** rank 1=YAGNI 2=Minor 3=Moderate 4=Significant 5=Sophisticated. `★` = cross-cutting (affects ≥2 items). `⚙` = empirically reproduced.

---

## OT5 — args-depth (top-N flags vs full flags[])

**OT5-G1 ⚙ rank 4 — Combined short flags are never decomposed → flag frequency is meaningless**
- **what:** `flags = args.filter(startsWith('-'))` stores `-rnE`, `-rn`, `-r`, `-n` as 4 distinct tokens. Semantically `-rnE` ≡ `-r -n -E`. `grep -rnE`, `grep -rn`, `grep -rn -E` all count separately; "most-used flag" is dominated by incidental bundling. Empirically: design captured only `-rnE` from the sample.
- **why_missed:** design treats flags as opaque strings; no getopt-style bundling expansion. OT5 debates *volume* (top-N vs all) but not *fidelity* — either choice produces the same noise.
- **severity:** Significant — directly corrupts LD3's "most run cmd / args" query goal.
- **mitigation:** expand single-dash runs into atomic short flags (`-rnE` → `[-r,-n,-E]`) for the frequency dimension; keep the original token in `raw_flags[]` for drill-down. Don't expand `--long` forms.
- **sources:** POSIX.1-2017 XBD §12.2 Utility Syntax Guidelines (single options may be grouped after one `-`); GNU Coreutils "Common Options" / getopt convention; bashlex README (AST `OptionNode`); shellcheck wiki SC2086 (quoting) SC2206 (splitting bundled args); GNU Bash Reference Manual §4.1 "Bourne Shell Builtins".

**OT5-G2 ⚙ rank 4 — Flags-with-values collapse the value dimension; `--` and `=` forms are conflated**
- **what:** Many flags take args: `grep -A 3`, `timeout 15`, `git -C /path`, `--message=foo` vs `--message foo`. `startsWith('-')` records `--message`/`-A` as flags but (a) the following positional (`3`,`15`,`foo`) becomes orphan "positional_args" noise, (b) `--output=x` and `--output x` count as different flags, (c) `--` end-of-options marker is ignored so `git log -- --weird-name` counts `--weird-name` as a flag. In the sample `timeout 15` → `15` would leak into positionals.
- **why_missed:** no per-program getopt spec; the design hardcodes subcommand detection only for `git/npm/gh/docker/pnpm` and assumes args after a flag are independent.
- **severity:** Significant — "which args" query (LD3 #2 `SELECT subcommand, flags`) returns skewed data.
- **mitigation:** store `flags[]` as objects `{flag, value?}`; strip the value after the first `=`; maintain a small known-flags-take-value table per program (long flags only); honor `--`.
- **sources:** POSIX Utility Syntax Guidelines 9 & 10 (options precede operands; `--` terminates options); GNU getopt Long Options spec; GNU Coreutils manual (per-utility arg classes); tree-sitter-bash grammar (can mark flag/value nodes); mvdan/sh `CallExpr.Args` (preserves arg structure for value extraction).

**OT5-G3 rank 3 — "Top-N per program" is the wrong grain; flags are (program, subcommand)-scoped**
- **what:** OT5 proposes "top-3 flags per program". But flag validity/sense is subcommand-specific: `git push --force` vs `git commit` (no `--force`), `git log --oneline` vs `git add --oneline` (invalid). Pruning to per-program top-N mixes unrelated semantics.
- **why_missed:** OT5 frames depth as a storage cost question, not a semantic-grain question.
- **severity:** Moderate.
- **mitigation:** prune to top-N per `(program, subcommand)` not per `program`. Cheaper than full array, semantically correct.
- **sources:** git man pages (per-subcommand option tables); POSIX Utility Syntax; GNU Coreutils per-command docs; mvdan/sh (subcommand = first non-flag arg of a Call); bashlex CommandNode structure.

---

## OT6 — cross-cwd-patterns (cwd in schema)

**OT6-G1 ⚙ rank 5 ★ — `cwd` field logic contradicts itself: turn3 says "cwd is free, join event→session"; turn4 parser STRIPS the `cd` so the actual cwd is lost**
- **what:** The sample command runs in `/home/…/beet-orches` (the `cd` target), but the design (a) turn3 claims `cwd` comes free from session metadata, and (b) turn4 strips `^cd\s+\S+ &&` then parses what remains — the `cd` target is discarded. So `cwd` will be recorded as the **session** cwd, not the **command's** cwd. For the sample, the stored cwd ≠ where grep actually ran.
- **why_missed:** two turns treat cwd differently and nobody reconciled them. `&&` after `cd` means the cd *takes effect* for subsequent `;`/`|` commands in the same invocation.
- **severity:** Sophisticated — silently wrong on the highest-volume command shape (`cd X && …` is the dominant pattern in turn2 data: thousands of commands). OT6's own motivating query ("which repos use --force") is corrupted.
- **mitigation:** capture the `cd` target as `effective_cwd = session_cwd → cd_override` and store THAT, not session cwd. Keep both: `session_cwd` and `effective_cwd`.
- **sources:** bash manual §3.7.2 "Command Execution Environment" (cd persists in current shell); POSIX `cd` utility; bashlex (CommandNode for `cd` distinguishable); ShellCheck SC2164 (cd error handling); the design doc itself turn3 vs turn4.

**OT6-G2 rank 4 — cwd must be canonicalized & repo-derived, not raw path**
- **what:** OT6 asks "which *repos* use --force" but schema stores raw `cwd`. Same repo appears via: absolute path, `~/...`, `..`-relative, worktree path, symlink. `cd ../foo`, `cd $REPO`, git worktrees, `~` all fragment one repo into many cwd rows.
- **why_missed:** design treats cwd as a free string; never defines cwd→repo normalization (find nearest `.git`/basename/realpath).
- **severity:** Significant — cross-cwd query returns N=1-per-path noise.
- **mitigation:** derive a `repo` column (nearest `.git` parent, else basename) + `cwd_realpath` (resolve `..`,`~` against session cwd). Index `repo`, not raw cwd.
- **sources:** git repository layout (`.git` resolution incl. worktrees `gitdir:` files); POSIX `realpath`; bash tilde-expansion §3.5.2; coreutils `realpath(1)`; mvdan/sh (Expander for `~`/`$VAR`).

**OT6-G3 rank 3 — Subshell/pushd/relative cd cwd is invisible**
- **what:** `(cd /x && cmd)` runs in a subshell (cwd doesn't persist) — semantically different from `cd /x && cmd`. `pushd/popd`, `cd -`, and relative `cd ../foo` (resolves against *prior* cwd, not session cwd) all need prior-cwd tracking. Naive leading-`cd` strip handles none.
- **why_missed:** parser only matches leading `cd`; subshell/grouping `(...)` not modeled.
- **severity:** Moderate.
- **mitigation:** use an AST that distinguishes subshell commands; carry a cwd stack through statement parsing; mark subshell-invoked commands `cwd_scope=subshell`.
- **sources:** bash manual §3.2.4 Grouping/§3.2.5 Coprocess; POSIX Shell Command Language (subshell `()`); bashlex (CompoundNode/Subshell); mvdan/sh Subshell node; bash `pushd`/`dirs` builtin docs.

---

## OT7 — pipeline-attribution (count all vs only first)

**OT7-G1 ⚙ rank 5 ★ — `cmd.split('|')` splits pipes INSIDE quotes/regex/process-substitution → corrupts depth AND downstream programs**
- **what:** Empirically reproduced on the sample: real pipeline is `grep | grep | head` (depth 3), but naive split yields **7 fragments** because `|` appears inside the quoted regex `"manual.*line|line.*item|POST.*line|/lines"`. Every flag/program after the first quoted pipe is garbage.
- **why_missed:** parser tokenizes by literal `|` with no quote-state machine. This is the single most damaging bug and OT7's framing ("count all vs count first") is moot until this is fixed.
- **severity:** Sophisticated — both options in OT7 produce wrong numbers until quote-aware splitting exists.
- **mitigation:** quote/escape-aware tokenizer is a hard prerequisite. Either shell-aware split or a real parser (see OT8). No middle ground.
- **sources:** POSIX Shell Command Language §2.2 Quoting & §2.9.2 Pipelines; bash manual §3.2.2 Pipelines; bashlex (PipelineNode respects quoting); mvdan/sh BinaryExpr (pipe) built on a real lexer; ShellCheck SC2046/SC2086.

**OT7-G2 rank 4 ★ — Multi-statement commands (`;`, `&&`, `||`) are not split — only `|` is; this dwarfs the pipeline question**
- **what:** The sample is `cd … && echo … ; timeout … grep … | grep … | head`. The design splits on `|` but never on `;`. So the whole thing is treated as ONE command whose program is the first token (`echo`). `;` is far more common than `|` in the turn2 data (echo=19,469; for=2,979; if=2,073 are all multi-statement artifacts). "Count first" vs "count all" is the wrong debate — "count statements" is the missing axis.
- **why_missed:** OT7 collapses everything to pipelines; statement lists (`;`, `&&`, `||`, newlines) are not in the model.
- **severity:** Significant — the entire "marker" command class (`echo "=== section ==="; cmd`) is mis-attributed to `echo`.
- **mitigation:** parse into a statement list first (split on `;`,`&&`,`||` with precedence), then pipelines, then commands. Need an AST.
- **sources:** POSIX Shell Command Language §2.9.1 Lists (and-or lists); bash manual §3.2.3 Lists; bashlex (ListNode/OperatorNode); mvdan/sh `CmdStmt`/BinaryExpr `&&`/`||`; tree-sitter-bash grammar (list/command).

**OT7-G3 rank 4 — `xargs` and `find -exec` are hidden command invocations, not pipeline stages**
- **what:** `find . -exec grep -l {} \;` and `... | xargs grep` invoke `grep` "inside" another command. The pipeline model has no slot for these. Attribution is ambiguous (count `find`? `grep`? both?). Very common in devops data.
- **why_missed:** OT7's "depth" field only counts `|`; nested invocations via `-exec`/`xargs`/`parallel` are invisible.
- **severity:** Significant — `find -exec`/`xargs` are top-tier devops patterns (turn2 shows `find` 908, `grep` 2,893).
- **mitigation:** add `nested_in` field (e.g. `find`/`xargs`/`parallel`) and emit a sub-event for the inner command with `parent_program`. Requires per-command arg inspection (`-exec … \;`, `-exec … +`).
- **sources:** GNU find manual (`-exec … \;` vs `-exec … +`); xargs man page; GNU parallel; POSIX `find` `-exec` semantics; mvdan/sh (CallExpr args contain nested CallExpr).

**OT7-G4 rank 3 — Process substitution `<()` `>()` and command substitution `$()` contain hidden commands**
- **what:** `diff <(ls a) <(ls b)`, `echo "$(git rev-parse HEAD)"`, backticks. The inner `ls`/`git`/`echo` are real invocations but the naive model sees them as part of one token. Bashlex verified to handle `cat <(echo $(echo foo))` correctly.
- **why_missed:** no handling of `$()`, backticks, `<()>`. Design's edge-case list omits command substitution entirely.
- **severity:** Moderate.
- **mitigation:** walk the AST's CommandSubstitution/ProcessSubstitution nodes; emit sub-events with `substitution_of=parent`.
- **sources:** bash manual §3.5.4 Command Substitution & §3.5.6 Process Substitution; bashlex README (ProcesssubstitutionNode/CommandsubstitutionNode, verified); mvdan/sh CmdSubst/ProcSubst nodes; POSIX.

---

## OT8 — bashlex-vs-manual-parser (start manual, "~80% accuracy")

**OT8-G1 ⚙ rank 5 ★ — "~80% accuracy" is a misleading scalar; failure is CORRELATED with analytical value**
- **what:** The 80% figure is unverified (turn3 assertion, no measurement). Worse: failures cluster in long, complex commands (pipelines, subshells, heredocs) — exactly the commands an analyst wants. Simple `ls`/`cd`/`echo` parse fine; the interesting `cd && echo ; timeout grep | grep | head` fails. So "80% by count" can mean "0% of the interesting 20%". Verified: the design's OWN sample command fails ≥4 distinct ways (wrong program, wrong depth, lost flags, lost statements).
- **why_missed:** no accuracy measurement on real data; "accuracy" defined per-command, not per-analytical-question.
- **severity:** Sophisticated — the entire value proposition is at risk.
- **mitigation:** before locking OT8, measure on the real 247k: bucket by command complexity (token count, has `|`/`;`/`$()`/quote) and report accuracy per bucket. Gate the decision on bucketed accuracy, not a global number.
- **sources:** bashlex (ground-truth AST for measurement); mvdan/sh (alternative ground truth); tree-sitter-bash; GNU Bash Reference Manual (defines correct parse); the design doc turn3 ("~80%" claim, unreferenced).

**OT8-G2 rank 4 — The choice is falsely framed as "bashlex(python) vs manual"; non-python AST parsers exist**
- **what:** The "python dependency" objection to bashlex doesn't preclude real parsing. **mvdan/sh** (Go, 8,940★, verified — "bash AND zsh support, includes shfmt"), **tree-sitter-bash** (C/WASM, 325★, verified), and **shell-quote** (JS, mentioned in turn3 then dropped) all produce real ASTs without a Python subprocess. mvdan/sh has WASM builds → embeddable in Node with no Python.
- **why_missed:** turn4 reduces the matrix to two options; the middle (JS/WASM AST parser) — which removes both objections — is absent.
- **severity:** Significant — the recommendation ("start manual") rests on a false dichotomy.
- **mitigation:** re-frame OT8 as three tiers: (1) `shell-quote` (JS tokenize, quote-aware — fixes OT7-G1/G2 cheaply), (2) `mvdan-sh` WASM / `tree-sitter-bash` WASM (full AST, no Python), (3) bashlex (Python subprocess, last resort). Default to (2).
- **sources:** mvdan/sh repo (verified 8,940★, bash+zsh, Go/WASM); tree-sitter-bash repo (verified); shell-quote npm; bashlex README; tree-sitter wasm bindings.

**OT8-G3 rank 4 ★ — Manual parser has NO failure signal → silent data corruption; need `parse_status` + `parser_version` columns**
- **what:** Regex/manual parsers silently produce wrong output on edge cases (no exception, no flag). bashlex/mvdan throw on parse error (catchable). Without a `parse_status` column (ok/partial/failed) and a `parser_version`, (a) you can't measure OT8-G1's accuracy, (b) you can't filter garbage out of analytics, (c) you can't re-process after a parser upgrade (idempotency key in LD5-G3 blocks it).
- **why_missed:** schema (turn4) has no parse-quality metadata.
- **severity:** Significant — compounds LD5.
- **mitigation:** add `parse_status` (ok|partial|failed), `parser_version`, `parser_notes` to `cmd_events`. On `failed`, store `program=NULL` and emit to a quarantine table for review.
- **sources:** outbox pattern literature (dead-letter / poison queue); DuckDB CHECK constraints; mvdan/sh (returns syntax errors via Go error, catchable); bashlex (raises `ParsingError`); ELT data-quality patterns (dbt tests).

**OT8-G4 rank 4 — Quoting / escaping / `$'...'` / ANSI / comments inside quotes all break regex parsing**
- **what:** Edge cases the design lists but doesn't solve: escaped spaces (`echo a\ b`), ANSI-C quoting (`$'\033[0m'`), `#` inside quotes (`grep "# TODO"`), locale/multibyte chars, escaped quotes (`\"`), single-vs-double-quote semantics (no expansion in `'...'`). Each corrupts tokens. Manual regex has no model of quote state.
- **why_missed:** parser uses `\S+` and `split(/\s+/)` — neither tracks quote/escape state.
- **severity:** Significant — devops commands are full of these (curl `-H "Content-Type: …"`, `sed "s/…/…/"`, ANSI output).
- **mitigation:** any of the tier-2 parsers (OT8-G2) handles these by construction; if staying manual, implement a proper quote-state tokenizer (state machine, not regex).
- **sources:** bash manual §3.1.2 Quoting & §3.1.2.4 ANSI-C Quoting; POSIX §2.2 Quoting; ShellCheck SC2086/SC2295 (quoting rules); mvdan/sh lexer (Quote state); bashlex (quote-aware WordNode).

**OT8-G5 rank 3 — bashlex is bash-only; the data contains zsh/sh/other shells**
- **what:** bashlex is a port of the GNU *bash* parser. Commands sourced from pi/zcode run in whatever `$SHELL` the user has (zsh is common per project context — "use zsh > bash" in the parent AGENTS.md). zsh-only syntax (e.g. `=command`, `${name:-default}` flavors, glob qualifiers) won't parse. mvdan/sh explicitly supports both bash and zsh.
- **why_missed:** assumes all commands are bash.
- **severity:** Moderate.
- **mitigation:** prefer mvdan/sh (bash+zsh) over bashlex; detect shell from session metadata; fallback-chain parsers with status tracking.
- **sources:** mvdan/sh repo (verified "bash and zsh support"); bashlex README ("port of the parser used internally by GNU bash"); zsh manual (divergent syntax); POSIX Shell Command Language (baseline intersection); AGENTS.md ("use zsh > bash").

---

## LD5 — outbox-pattern (load-bearing fields only)

**LD5-G1 ⚙ rank 4 ★ — Load-bearing field list is INCOMPLETE: processor must re-derive `pipeline_depth`/`event_date`/`event_hour` not in outbox, breaking the decoupling LD5 promises**
- **what:** LD5 says outbox carries "only load-bearing fields (program, subcommand, flags, cwd, ts, exit_code, duration)". But `cmd_events` schema also has `pipeline_depth`, `event_date`, `event_hour`, `agent`, `alias`, `positional_args`. `pipeline_depth` requires *parsing* — so the processor re-parses raw_command on consume, which means the parser logic is coupled to the processor, not the extractor. That's fine, but LD5's "decouples extract from transform" claim is only half-true (transform still parses).
- **why_missed:** the field list was written before reconciling with the full `cmd_events` schema.
- **severity:** Significant — either move parsing to the extractor (outbox stores parsed fields) or accept the processor parses (then outbox only needs `raw_command` + provenance).
- **mitigation:** decide parse location explicitly. Recommendation: parse in the *processor* (single place), so outbox stores only `(id, agent, alias, session_id, event_id, event_ts, raw_command, cwd, exit_code, duration_ms) + status` — no parsed fields. Drop the "load-bearing parsed fields" idea from LD5.
- **sources:** transactional outbox pattern (Microservices.io; Vernon "Implementing DDD"); the design doc turn4 outbox schema vs cmd_events schema; DuckDB transaction docs; ETL vs ELT literature (parse-on-load vs parse-on-read).

**LD5-G2 ⚙ rank 5 ★ — Poison-message: one malformed row rolls back the ENTIRE 10k batch; `parseCommand` throw aborts 9,999 good rows**
- **what:** `ingestBatch` wraps the loop in `tx.commit()`/`tx.rollback()`. A single command that throws in `parseCommand` rolls back the whole batch and marks all 10,000 `failed` (attempts++). One weird heredoc poisons 10k rows, which then fail forever (attempts cap → dead). Verified the sample contains exactly the kind of input that would throw.
- **why_missed:** error handling is at batch level, not row level.
- **severity:** Sophisticated — a handful of exotic commands can stall ingestion permanently.
- **mitigation:** per-row try/catch inside the loop; on row error, set THAT row `status=failed`, write the error, commit the rest. Cap `attempts` and move to a dead-letter table after N. Only rollback on infra errors (DB write failure), not parse errors.
- **sources:** transactional outbox / dead-letter pattern (AWS SQS DLQ docs); Microservices.io outbox; DuckDB transactions (per-statement error behavior); Erlang "let it crash" vs isolation; the design doc `ingestBatch` code.

**LD5-G3 ⚙ rank 5 ★ — Idempotency key excludes parser version → parser upgrades NEVER backfill analytics; ON CONFLICT DO NOTHING skips re-parse**
- **what:** `outbox.id = hash(agent:alias:session_id:event_id)` and `INSERT INTO cmd_events … ON CONFLICT (id) DO NOTHING`. When you fix a parser bug (and you will — see OT8-G1), the improved output for an already-ingested event is silently discarded because the `id` already exists. The 7-day outbox prune then deletes the raw, so old events can never be re-parsed.
- **why_missed:** idempotency was designed against *re-delivery*, not against *parser evolution*.
- **severity:** Sophisticaticated — a v1 parser bug becomes permanent data corruption after prune.
- **mitigation:** include `parser_version` in the analytics id (or a separate `(id, parser_version)` key); provide `oas-stats reprocess --since --parser-version` that re-runs the processor over unpruned raw; lengthen raw retention (separate raw archive) if backfill matters.
- **sources:** schema-versioning / event-sourcing patterns (include version in key); CDC idempotency (Debezium key handling); the design doc outbox.id derivation + ON CONFLICT code; DuckDB conflict handling; data-pipeline replay patterns (dbt full-refresh).

**LD5-G4 rank 4 — Status machine has no lease/reclaim; a crash mid-batch leaves rows stuck in `processing` forever**
- **what:** outbox has `status` (pending|processing|processed|failed) + `attempts`, but no `processing_since`/lease. If the processor crashes (OOM, kill) after `status=processing`, rows never return to `pending`. Restart re-selects `status=pending` only → orphaned rows.
- **why_missed:** no claim-with-timeout semantics; "reclaim stale" not modeled.
- **severity:** Significant at scale (LD2's "old session gets new events" makes restarts routine).
- **mitigation:** add `claimed_at TIMESTAMP`; claim = `UPDATE outbox SET status='processing', claimed_at=now() WHERE id IN (… pending …)`; on startup, reset `status='pending' WHERE status='processing' AND claimed_at < now() - lease`. Use a single-writer (OT12) to avoid double-claim.
- **sources:** transactional outbox with leasing (Microservices.io; Naylor "outbox poller" patterns); job-queue lease patterns (Sidekiq/SQS VisibilityTimeout); DuckDB single-writer model; the design doc outbox schema; CDC consumer patterns.

**LD5-G5 rank 3 — Atomicity boundary is undefined if outbox and analytics are separate files**
- **what:** LD5 + OT9 discuss outbox-vs-analytics storage choice. If they're separate DuckDB files (two file handles), `UPDATE outbox … processed` + `INSERT INTO analytics` are NOT one transaction → crash between them = double-processing or lost ack. Design's `ingestBatch` assumes one `tx`.
- **why_missed:** the "decouple extract from transform" framing implies possibly-separate stores, but the code assumes one tx.
- **severity:** Moderate — only if OT9 picks separate files.
- **mitigation:** keep outbox + analytics in the SAME DuckDB file (one tx) — resolves atomicity and OT9 at once. If separate stores are ever needed, use outbox.id in analytics + idempotent INSERT (already planned) and make the UPDATE-outbox idempotent on replay.
- **sources:** transactional outbox requires same-transaction write (Microservices.io); DuckDB ATTACH/cross-DB tx limitations; the design doc ingestBatch code; CDC exactly-once semantics; DuckDB docs.

**LD5-G6 rank 3 — `event_id` is not stable/deterministically derivable for pi → dedup breaks or duplicates appear**
- **what:** outbox `UNIQUE(agent, alias, session_id, event_id)` and idempotency depend on a stable `event_id`. zcode has `tool_usage.id`/`tool_call_id`. But pi JSONL bash calls have NO per-call id — they're positional (`message.content[i]` where item is a `toolCall` of name `bash`). Naive `event_id = index` is unstable if the file is appended/compacted; `hash(content)` collides on repeated identical commands and breaks the "new event" detection LD2 requires.
- **why_missed:** design assumes event_id exists uniformly; pi extraction (turn2) shows it's positional.
- **severity:** Moderate — causes either duplicate rows (id drifts) or missed re-ingest (hash collides).
- **mitigation:** `event_id = hash(session_file_path + byte_offset_of_record)` for pi (offsets are append-stable); document per-agent event_id derivation; add an extraction test that re-running on identical input yields zero new outbox rows.
- **sources:** the design doc turn2 (pi extraction uses positional `content[]`); CDC offset/LSN patterns (Kafka offsets, Postgres LSN); DuckDB UNIQUE constraints; idempotency key design (Eventide); pi JSONL schema (turn2 references).

---

## Cross-cutting (affects ≥2 items) — flagged ★ above

| ID | Cross-cut items | One-line |
|----|-----------------|----------|
| OT6-G1 | OT6, LD5 | cwd field logic self-contradicts (free vs stripped) → silently wrong on dominant `cd X && …` shape |
| OT7-G1 | OT7, OT8, LD5 | `split('|')` breaks on quoted pipes — verified 7 vs 3 on sample |
| OT7-G2 | OT7, OT8, OT5 | `;`/`&&`/`||` statement lists not modeled — bigger than the pipeline question |
| OT8-G3 | OT8, LD5 | no `parse_status`/`parser_version` → no accuracy, no filter, no backfill |
| LD5-G1 | LD5, OT8 | load-bearing field list incomplete; parse location undecided |
| LD5-G2 | LD5, OT8 | poison row aborts whole batch → ingestion stall |
| LD5-G3 | LD5, OT8 | id excludes parser version → upgrades never propagate |

**Single biggest miss:** the design never ran its proposed parser against its own sample command. Doing so (3 lines of node, shown above) disproves the "~80% accuracy" premise on the spot — the sample fails on program, depth, flags, and statement-count simultaneously.

---