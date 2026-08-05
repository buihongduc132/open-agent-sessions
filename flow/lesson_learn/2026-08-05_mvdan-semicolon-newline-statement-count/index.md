# mvdan Semicolon→Newline statement_count

Context [C1]:
- Phase 2, parse layer counts logical commands for statement_count.
- Uses mvdan/sh AST + print() round-trip.

Symptom [S1]:
- Input `a || b ; c` returned statement_count=2, expected 3.
- Undercounts when `;` present.

Root Cause [R1]:
- mvdan/sh `print()` normalizes `;` separator to `\n`.
- Old `splitOnTopLevelStatementSeps` checked token-level `;` only.
- Normalized `\n` separator invisible to old splitter → merged stmts.

Solution [SO1]:
- New `countLogicalCommands()` walks normalized string.
- Treats `\n` + `;` + `&&` + `||` all as separators.
- Wired at mvdan.ts:124 via `|| result.statement_count` fallback.

Ref [REF1]:
- oas-command-stats/src/parse/mvdan.ts:337 (countLogicalCommands def)
- oas-command-stats/src/parse/mvdan.ts:124 (call site)
- Comment: mvdan.ts:122-123

Gotchas [G1]:
- Never assume printer preserves source separators — mvdan rewrites `;`→`\n`.
- Count on NORMALIZED output, not raw tokens.
- `&&`/`||` are operators not separators in some counters — here counted as stmt boundaries.
