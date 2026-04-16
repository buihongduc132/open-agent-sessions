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

