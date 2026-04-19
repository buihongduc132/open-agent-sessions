## User

1. Base on your usage of the oas cli AND with the exact above usecases ; 

give me 5 areas that it functionalities and UX is not good enough ? 

2. 
do you be able to do these: 
- identify main / sub agents? is it having 2 modes (main only ; main + sub) ; is it be able to quickly tell the main + sub relationship ? 
- do you be able to search for AND / OR or others kind of fuzzy? 

---

## Assistant

Based on my hands-on experience using `oas` in this conversation, here are my findings:

---

## 1. Five areas where `oas` functionality / UX falls short

### Area 1 — Search is purely title-based, not content-aware
The `--text` search only matches against session **titles**, not message content. In `ses_271309cd` (the main session), the title is "Config drift detection implementation" — it never mentions ast-grep, comby, or GritQL in the title. Yet it was the **richest** session on that topic. The tool completely missed it on the first round of searches.

This is a fundamental limitation — if you don't know the right session title, content-based searches fail silently with false negatives.

### Area 2 — No boolean operators or fuzzy matching in search
I had to run **three separate searches** (`--text "ast-grep"`, `--text "comby"`, `--text "gritql"`) and manually deduplicate the results. There's no:
- `AND` / `OR` / `NOT` operators
- Fuzzy / substring matching
- Regex patterns

The searches returned identical results across all three queries because title-based search is an exact match against what was indexed. Even with the "gritql" query, the top result was the **current session** with that exact title — the tool had nothing else to surface.

### Area 3 — Current session pollutes results with no way to exclude it
The very first `grit` search returned `ses_26a533145` (the current session) as the top result because it was created with the title "Finding ast-grep comby gritql sessions" — which was the question I was asking. There's no `--exclude-current` flag, no `--exclude-session <id>` option, and no way to say "search only sessions older than this one." 

You just have to know to grep/filter it out manually, which requires you to already know the session ID.

### Area 4 — Flag conflicts force multiple round-trips
`--last N` and `--user-only` cannot be combined — they're mutually exclusive by design. To read a session's last 20 messages filtered to just user content, I had to either:
- Read last 20 (with assistant/tool noise), then mentally filter
- Read user-only (which defaults to last 10), then separately get the last N

This forces unnecessary back-and-forth. The right UX would be `--last 20 --user-only` as composable constraints, not a choice between two limited views.

### Area 5 — No agent hierarchy / delegation relationship visibility
The session list shows agents like:
```
orches/glm-5.1
verifier/gpt-5.2-codex
verifier/claude-sonnet
```

But `oas` has **zero affordance** to show that `verifier` was a sub-agent spawned *by* `orches/glm-5.1`. You can only discover this by reading the full session transcript and manually tracing the delegation chain. There's no:
- `oas tree <session-id>` to show parent → child relationships
- `oas children <session-id>` to list spawned sub-sessions
- Agent type labels in list output (main vs. sub-agent)

This makes session archaeology time-consuming — you're often reading sessions blind, not knowing whether a verifier session is a peer or a child.

---

## 2. Can `oas` do those things?

### Identify main / sub agents?
**No.** The session list shows agent names (`orches/glm-5.1`, `verifier/gpt-5.2-codex`) but provides no structural relationship between them. You cannot ask "show me all sub-agents spawned from session X" or "list all verifier sessions and their parents."

Even reading a session doesn't label its role — you'd have to parse the content yourself to infer whether it's a main or sub-agent session.

### Two modes (main only / main + sub)?
**No.** There's no filtering mode to show only "root" sessions vs. all sessions including spawned ones. Every command returns the flat list — you see everything mixed together.

### Quickly tell the main + sub relationship?
**No.** As described in Area 5 — no relationship graph, no tree view, no delegation chain. You have to manually read sessions to reconstruct the hierarchy.

### Search with AND / OR / fuzzy?
**No.** Only exact title substring matching. No boolean operators, no fuzzy/approximate matching, no regex. Three separate searches for three terms yielded identical results because the underlying match was title-based, not content-based.

---

**Summary table:**

| Capability | Supported? |
|---|---|
| AND / OR / NOT search | ❌ |
| Fuzzy / substring search | ❌ |
| Regex search | ❌ |
| Content search (not just title) | ❌ |
| Exclude current session | ❌ |
| Agent hierarchy / parent → child view | ❌ |
| Main vs. sub-agent mode filtering | ❌ |
| Composable read flags (`--last N --user-only`) | ❌ |

---

## Architecture Decision: How to implement all 5 gaps

### The core problem

`oas` has **three backends** that all need to be queried when a user searches:
- **codex** (SQLite via FTS5) — session titles + message body chunks in `session_fts` table
- **acpx** (JSONL sessions) — sessions stored as `.jsonl` files on disk
- **opencode** (vector search via `findSimilarSessions`) — hybrid FTS5 + vector KNN in `session_vec`

Every search needs to run against **all three**, merge results by relevance, and return a unified ranked list. A single search implementation can't hardcode one backend.

### Decision: 3-layer architecture — reuse library, not execution engine

```
User: "ast-grep AND comby"
        │
        ▼
┌─────────────────────────────────────┐
│  Layer 1 — PARSER  (library)         │
│  Parse query string → AST             │
│  Library: liqe (Lucene-compatible)   │  ← 674 stars, active Feb 2026,
└──────────────┬────────────────────────┘   │  parse-only, AST is public API
               │ liqe.parse() → AST        │
               ▼
┌─────────────────────────────────────┐
│  Layer 2 — PLANNER  (custom)         │  ← thin, pure, stateless translator
│  Walk AST → per-backend predicates    │     ~50-80 lines of TypeScript
│  3 translators: FTS5 / JSONL / Vector  │
└──────────────┬────────────────────────┘
               │ SearchPlan { terms, fts5Query, jsonlFilter, excludeTerms }
       ┌───────┼────────┐
       ▼       ▼        ▼
┌──────────┐ ┌────────┐ ┌──────────────┐
│  codex   │ │  acpx  │ │   opencode   │
│  SQLite  │ │  JSONL │ │    vector    │
│  FTS5    │ │ stream │ │ findSimilar  │
│  match   │ │  scan  │ │ Sessions()   │
└────┬─────┘─┴───┬────┘ └──────┬───────┘
     │           │             │
     └───────────┼─────────────┘
                 ▼
┌─────────────────────────────────────┐
│  Layer 3 — FUSION  (custom)          │  ← already exists: applyRrfFusion()
│  RRF merge → unified ranked results   │     in src/similarity/search.ts
└─────────────────────────────────────┘
```

### Why this decision

| Principle | How it applies |
|-----------|----------------|
| **Reuse, not reinvent** | `liqe` parses Lucene syntax (widely known, documented, battle-tested). We don't write a parser. |
| **Library = parser only** | `liqe` gives AST — we own execution. Other candidates (`SearchFn`, `retriv`) own the execution layer too, which prevents multi-backend flexibility. |
| **Backend-agnostic planner** | Adding a new backend (Elasticsearch, pgvector, etc.) = new translator, zero changes to parser or existing translators. |
| **Backwards compatible** | Users get Lucene syntax — widely known, not a custom DSL. |
| **JSONL works** | Planner generates a streaming filter fn `(msg: Message) => boolean` — no schema needed, runs in-process over `.jsonl` files. |
| **SQLite FTS5 works** | Planner generates FTS5 `MATCH` string — runs natively via existing `applyFtsSearch()`. |
| **Vector works** | `findSimilarSessions` already does FTS5 + vector + RRF fusion — just wire the boolean query terms into it. |
| **Regex works** | `liqe` natively supports `/pattern/` — no custom regex support needed. |

### What gets reused vs. custom

| Component | Owned by | What it does |
|-----------|----------|--------------|
| `liqe` (npm: `liqe`) | **Library** — gajus, 674 stars, nearley-based | Parse `"ast-grep AND comby"` → AST. Lucene-compatible. |
| `findSimilarSessions` | **Already there** — `src/similarity/search.ts` | Hybrid FTS5 + vector + RRF. Just needs boolean terms wired in. |
| `applyRrfFusion` | **Already there** — `src/similarity/search.ts` | RRF merge. Already returns ranked results. |
| `src/search/planner.ts` | **Custom** — but thin, pure, stateless | Walk liqe AST → `SearchPlan`. 3 translator functions: FTS5, JSONL, Vector. ~80 lines. |
| JSONL streaming filter | **Custom** — but trivial | `(msg) => msg.text.includes(term)`. No schema. |

### What the planner produces

```typescript
// src/search/planner.ts — thin translator, ~80 lines

interface SearchPlan {
  terms: string[];           // ["ast-grep", "comby"]
  fts5Query: string;        // "ast-grep AND comby"
  jsonlFilter: (msg: Message) => boolean;
  excludeTerms: string[];    // for NOT operator
  regexTerms: string[];      // /pattern/ terms for FTS5 LIKE
}

export function planFromQuery(query: string): SearchPlan {
  const ast = parse(query);  // liqe
  return walk(ast.expression);
}
```

The plan is the contract between parser and executors. Each executor:
- **SQLite**: builds `WHERE session_fts MATCH 'fts5Query'`
- **JSONL**: runs `messages.filter(jsonlFilter)` in streaming
- **Vector**: calls `findSimilarSessions(fts5Terms)` (terms extracted from AST)

### Future extensibility

Adding a new backend = adding a translator:

```
src/search/translators/
  fts5.ts      — AST → FTS5 MATCH string        (already wired)
  jsonl.ts     — AST → streaming filter fn       (trivial)
  elastic.ts   — AST → Elastic query DSL         (future)
  pgvector.ts  — AST → pgvector SQL              (future)
```

Each translator is isolated, tested independently, parser never changes.

### Why NOT the alternatives

| Candidate | Rejected because |
|-----------|-------------------|
| `SearchFn` | Owns execution engine — can't plug in JSONL scan or custom FTS5. Adapter contract is fixed. |
| `retriv` | Owns hybrid search (BM25+vector) — requires using their drivers. Can't work with JSONL files or existing `findSimilarSessions`. |
| Custom parser | Would reinvent what Lucene has solved. No backwards compatibility with user expectations. |
| Lucene-kit | 8 stars, peggyjs grammar, less maintained. `liqe` is the most complete Lucene-compatible parser in JS ecosystem. |

### Summary

- **Parse**: `liqe` (reused library, Lucene syntax)
- **Plan**: custom thin translator → per-backend predicates (custom, ~80 lines)
- **Execute**: existing `findSimilarSessions` + JSONL streaming (mostly already there)
- **Fuse**: existing `applyRrfFusion` (already there)
- **Result**: unified ranked list across all 3 backends

---

## GAP 7 — `parentSessionId` never populated in `SessionSummary` by any adapter

### Root Cause

`SessionSummary` has an optional `parentSessionId?: string` field (`src/core/types.ts:16`) which is the backbone of all sub-agent filtering (`--roots-only`, `--sub-only`, `--children-of`, GAP 6's default root-only filter). However, **zero adapters populate this field** when building `SessionSummary` objects from their respective backends:

| Adapter | Storage | Sets `parentSessionId` on `SessionSummary`? |
|---|---|---|
| `opencode.ts` — DB path | `opencode.db` (SQLite) | ❌ No — `listSessionsFromDb` never reads parent info |
| `opencode.ts` — JSONL path | `opencode.jsonl` | ❌ No — `listSessionsFromJsonl` never reads `session.clone.src.session_id` |
| `codex.ts` | `~/.codex/sessions/*.jsonl` | ❌ No |
| `claude.ts` | `~/.claude/transcripts/*.jsonl` | ❌ No |

The only place `parentSessionId` exists is in `ForkResult` (return value of `forkSession()`), which is ephemeral — not persisted.

### Why This Matters

Without `parentSessionId` on `SessionSummary`:
- `--roots-only` / `--sub-only` / `--children-of` always return empty or wrong results
- GAP 6's default root-only filter produces meaningless `+0` / `-` badges on every row
- The tree view (`src/tui/tree-model.ts`) shows all sessions as isolated roots — no hierarchy
- Fork chains cannot be traced without loading full `SessionDetail` for every session

### Requirement

**Each adapter MUST populate `parentSessionId` on `SessionSummary` during list operations.**

Sources of truth per adapter:

#### OpenCode DB (`opencode.db`)
The `opencode.db` SQLite schema does **NOT** store parent session IDs. There is no `parent_session_id` column in the `session` table. Two paths forward:

1. **Preferred**: Store `parent_session_id TEXT` in the `session` table (requires migration). When a session is forked, write the parent's ID into this column. Then read it during `listSessionsFromDb`.
2. **Fallback**: Cross-reference the `clone` field in `opencode.jsonl` entries to build a parent map, then join it in the DB path. This requires reading JSONL on every DB list call — expensive but requires no schema change.

#### OpenCode JSONL (`opencode.jsonl`)
Each session JSONL entry has:
```json
{ "id": "ses_001", "clone": { "src": { "session_id": "ses_parent" } } }
```
The `clone.src.session_id` is the parent. The adapter must read this field for every session and propagate it to `SessionSummary.parentSessionId`.

#### Codex (`~/.codex/sessions/*.jsonl`)
Codex JSONL does not store parent session IDs natively. Parent info must be inferred from the **session directory structure** or session filename patterns — if a session is a sub-agent, its path may embed the parent's ID (e.g. `~/.codex/sessions/parent-id/sub-id/`), or it may need to be stored in a separate metadata file. **This GAP requires investigating the actual Codex storage format** to determine if and how parent information is stored.

#### Claude (`~/.claude/transcripts/*.jsonl`)
Same as Codex — investigate whether Claude stores parent session information in its JSONL files or session directories. If not, this is a known limitation until Claude's storage format supports it.

### Open Questions

- [ ] Does Codex store parent session IDs anywhere? What is the exact JSONL schema?
- [ ] Does Claude store parent session IDs anywhere? What is the exact directory/file schema?
- [ ] Should `opencode.db` be migrated to add a `parent_session_id` column?
- [ ] Is the JSONL `clone.src.session_id` field populated at fork time for OpenCode?

### Implementation Notes

1. **OpenCode JSONL** — simplest fix: in `listSessionsFromJsonl`, read `session.clone?.src?.session_id` and set `parentSessionId`.
2. **OpenCode DB** — add `parent_session_id TEXT` column to `session` table via migration. Update `forkSession` implementations to write the parent's ID into this column.
3. **Codex / Claude** — first investigate storage format, then determine feasibility.
4. ** GAP 6 interaction**: GAP 6's default filter and child-count badges are meaningless until this GAP is fixed.

---

## GAP 8 — `SessionDetail` also missing `parentSessionId` in adapters

### Root Cause

`SessionDetail` (which extends `SessionSummary`) also has `parentSessionId?: string` (`src/core/types.ts:37`), but it is also never set by `getSessionDetail` implementations:

```typescript
// opencode.ts:1438 — getSessionDb clones full summary but drops parentSessionId
return {
  newSessionId,
  parentSessionId: sourceSessionId,  // ForkResult sets it
  ...
};
// BUT getSessionDetail in opencode.ts NEVER sets parentSessionId on the returned SessionDetail
```

Even when a session has `clone.src.session_id` in JSONL, `getSessionDetail` doesn't propagate it to `SessionDetail.parentSessionId`.

### Requirement

Both `listSessions` (returns `SessionSummary[]`) and `getSessionDetail` (returns `SessionDetail`) adapters must set `parentSessionId` when the information is available from the storage backend.

### Test Strategy (RED)

GAP 7 tests mock `ListService` to return `SessionSummary[]` with `parentSessionId` pre-populated, then verify `runListCommand` filters correctly. GAP 8 tests go one layer deeper: verify that **each adapter** sets `parentSessionId` when listing sessions with parent information available.

> **Note**: GAP 8 tests should live in `test/adapters/` and mock the filesystem/SQLite directly. GAP 7 tests (in `cli-gaps-edge-cases-4.test.ts`) test the CLI layer only.

---

## DRY Hook Infrastructure (committed 2026-04-18)

### Problem

Multiple code duplication patterns were accumulating across adapter files (codex.ts, claude.ts, opencode.ts) with no automated detection. Previous refactoring removed ~46 lines of duplication but had no gate to prevent recurrence.

### Solution

Pre-commit hook (`.githooks/pre-commit`) with 13 rules:

```
.githooks/pre-commit        — bash hook, git config core.hooksPath=.githooks
references/rules.md         — human-readable rule registry
ast-grep/rules/dry-rules.yml — structural ast-grep patterns
scripts/pre-commit-ast-dry.sh — ast-grep scanner for staged files
```

**Rule summary:**

| Rule | Severity | What it catches |
|---|---|---|
| R-01 | fail | hook not executable |
| R-02 | fail | staged .env files |
| R-03 | warn | staged binary files |
| R-04 | warn | ast-grep DRY violations |
| R-05 | warn | `readFileSync("utf-8")` in adapters → use fs-utils |
| R-06 | warn | `readdirSync` + `.json` filter → use listJsonFiles |
| R-07 | warn | `statSync` + isFile guard → use safeStat |
| R-08 | warn | inline `Date.parse` for sorting → use minIso/maxIso |
| R-09 | warn | inline `toLowerCase().includes()` → use containsIgnoreCase |
| R-10 | warn | inline `split(/\r?\n/)` for JSONL → use jsonl-utils |
| R-11 | warn | inline content extraction → use content-utils |
| R-12 | warn | duplicate expandTilde in config/load.ts → import from fs-utils |
| R-13 | warn | duplicate label construction → use createLabel helper |

**All rules are warn-only** (except R-01/R-02) — they guide refactoring, never block commits.

### Duplication inventory (17 known patterns)

| Pattern | Locations | Suggested utility |
|---|---|---|
| `readFileSync("utf-8")` | 10 files | `fs-utils.ts: readTextFile/readJsonFile` |
| `readdirSync + .json filter` | 3× acpx.ts | `fs-utils.ts: listJsonFiles` |
| `statSync + isFile` guard | 4 adapters | `fs-utils.ts: safeStat` |
| `Date.parse(a) - Date.parse(b)` | acpx.ts, opencode.ts | `fs-utils.ts: sortByIso` |
| `toLowerCase().includes()` | 17 files | `fs-utils.ts: containsIgnoreCase` |
| `split(/\r?\n/)` | 10+ lines | `jsonl-utils.ts: splitJsonlLines` |
| `extractContentText/Parts` | codex.ts, claude.ts | `content-utils.ts` |
| `expandTilde` duplicate | config/load.ts | import from fs-utils.ts |
| `${entry.agent}:${entry.alias}` label | 4 adapters | `label.ts: createLabel` |
| `normalizeTimestamp` | 3 adapters | already in normalize.ts ✅ |
| `errorMessage()` | 4 adapters | already in core/utils.ts ✅ |
| `minIso/maxIso` | 2 adapters | already in fs-utils.ts ✅ |

### DRY Refactoring — Completed 2026-04-18

All 4 remaining DRY patterns implemented and GREEN:

| Rule | Action | Files updated |
|---|---|---|
| R-12 | `expandTilde` in `config/load.ts` → import from `fs-utils.ts` | `src/config/load.ts` |
| R-13 | New `src/adapters/label.ts: createLabel()` + update all 4 adapters | codex.ts, claude.ts, acpx.ts, opencode.ts |
| R-10 | `splitJsonlLines()` added to `fs-utils.ts` + update codex/claude | codex.ts (4 sites), claude.ts (2 sites) |
| R-11 | New `src/adapters/content-utils.ts` (extractContentText/Parts/Line) + update codex/claude | codex.ts, claude.ts |

New utility files:
- `src/adapters/label.ts` — 3 lines: `createLabel()` shared across all adapters
- `src/adapters/content-utils.ts` — 92 lines: Codex/Claude-specific content extraction (input_text/text/output_text field priority preserved)

Pre-commit hook: **13/13 rules pass** (all GREEN).
Full test suite: **1479 pass, 5 skip, 0 fail**.

Test additions this session:
- `test/cli-entry-fixed.test.ts`: 6 new TUI command tests (oas tui wiring verified)
- `test/adapters/opencode-lock-retry.test.ts`: 8 new tests for SQLite lock retry hardcoded delays

### Adding new rules

When adding cursor.ts, zed.ts, or aider.ts (REQ-29/30/31):
- [ ] Adapter uses `createSqliteBackend()` or `createJsonlBackend()`, not raw `Database`/`readFileSync`
- [ ] Path resolution uses `fs-utils.ts` helpers, not inline `expandTilde`/`homedir()`
- [ ] Label construction uses shared helper, not `${agent}:${alias}` literals
- [ ] All 13 pre-commit rules pass before commit

---

## GAP 9 — `oas sessions` UX: truncated title + noisy `:default` alias

### Problem 1: Title is always truncated

`oas sessions --limit 5` output:
```
[opencode:default] Explore mise/CI pipeline patterns (@e... ses_25e446cd7ffep0iV... 2 msg 1m ago
```
No `--full` flag exists. Users cannot read complete titles without `oas find <id>`.

### Problem 2: `:default` alias clutters every row

`[opencode:default]` on every row provides zero value. It must be hidden by default.

### Requirements

1. Add `--full` flag to `sessions` / `list`. Title is never truncated when `--full` is set.
2. Hide `default` alias by default. Show it only with `--show-alias`.

Flag composition:

| `--full` | `--show-alias` | Result |
|---|---|---|
| ❌ | ❌ | Title truncated, `default` hidden |
| ✅ | ❌ | Title full, `default` hidden |
| ❌ | ✅ | Title truncated, all aliases shown |
| ✅ | ✅ | Title full, all aliases shown |

`--full` and `--show-alias` are text-format only. JSON output (`--format json`) is unaffected.

### Tests (RED first)
- `--full`: full title in text output
- `--show-alias`: `default` alias visible in text output
- Default: `default` hidden, title truncated
- JSON: unaffected by both flags

---

## GAP 10 — `--format` missing from `list`, `search`, `detail`

### Current state

| Command | `--format` |
|---|---|
| `sessions` | ✅ `text` / `json` |
| `similar` | ✅ `text` / `json` |
| `read` | ✅ `text` / `json` / `csf` / `md` |
| `tree` | ✅ `text` / `json` |
| `children` | ✅ `text` / `json` |
| `export` | ✅ `csf` / `markdown` / `text` |
| `list` | ❌ text only |
| `search` | ❌ text only |
| `detail` | ❌ text only |

`list`, `search`, `detail` produce text-only output. No `--format` flag exists. `jq` pipelines fail.

All required JSON formatters already exist (`formatSessionsJson`, `formatSessionDetailJson`). Only CLI wiring is missing.

### Requirements

1. **`oas list --format json`** — route to `formatSessionsJson()`. `--format text` unchanged.
2. **`oas search --format json`** — route to `formatSessionsJson()`. `--format text` unchanged.
3. **`oas detail --format json`** — route to `formatSessionDetailJson()`. `--format text` unchanged.

Invalid `--format` value: same error behavior as `sessions`.

### Tests (RED first)
- `list --format json`: valid `SessionSummary[]` JSON array
- `list --format text`: unchanged
- `search --format json`: valid `SessionSummary[]` JSON array
- `search --format text`: unchanged
- `detail --format json`: valid `SessionDetail` JSON object
- `detail --format text`: unchanged
- Invalid `--format`: error returned

---

## GAP 11 — `oas sessions` returns wrong project sessions

### Evidence (3 worktrees tested)

**`/home/bhd/Documents/Projects/bhd/open-agent-sessions` (main worktree)**
```
$ ocxo session list -n 3   → OAS sessions UX requirements, Requirements test coverage...
$ oas sessions --limit 3  → same sessions ✓
```
→ exact project match exists → both tools agree ✓

**`/home/bhd/Documents/Projects/bhd/oas-16apr-gaps` (worktree B)**
```
$ ocxo session list -n 3   → OAS sessions UX requirements, Gap analysis...
$ oas sessions --limit 3    → No sessions found. ✗
```
→ 189 sessions in DB under `session.directory=/home/bhd/Documents/Projects/bhd/oas-16apr-gaps`
→ 0 returned by `oas` (no project entry → `findProjectId` returns `null`)

**`/home/bhd/Documents/Projects/bhd/oas-functionalities-improve` (worktree C)**
```
$ oas sessions --limit 3   → No sessions found.
$ ocxo session list -n 3   → same sessions as oas-16apr-gaps ✗
```
→ no sessions in DB for this directory → both return empty ✓

### Root Cause

`findProjectId()` queries `session.project_id` via a project table lookup. When a worktree has **no entry in the `project` table**:
- `findProjectId` walks up the directory tree → finds nothing → returns `null`
- `oas` returns `[]`
- `ocxo` queries `session.directory` column directly → finds matching sessions

Sessions in `oas-16apr-gaps` have `directory=/home/bhd/Documents/Projects/bhd/oas-16apr-gaps` in the DB, but no corresponding `project` entry. `oas` sees no project → returns nothing. `ocxo` sees the directory column → returns sessions.

**Scenario where the OLD bug (global fallback) occurs**: directories that walk up to `/home/bhd` and find the `global` project entry.

### Requirement

When running `oas sessions` in a directory with no project entry but with sessions in `session.directory` matching that cwd, `oas` MUST return those sessions (same as `ocxo`).

`oas sessions` count MUST match `ocxo session list` count for the same directory.

### Tests (RED — 4 fail, 5 pass)
- `oas-16apr-gaps`: `oas sessions` returns `[]` → should return directory-matched sessions
- `oas-16apr-gaps`: count `oas` < count `ocxo` → must be `>=`
- `open-agent-sessions`: count comparison must hold
- `/tmp` and `e2e_context` sessions must not appear in project-scoped output

