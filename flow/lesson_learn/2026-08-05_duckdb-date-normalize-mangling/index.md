# DuckDB Date Normalize Mangling

Context [C1]:
- Phase 2, NORMALIZE_FN post-processes DuckDB query rows.
- Recurses to convert bigint → Number for JSON-safe output.

Symptom [S1]:
- TIMESTAMP columns returned as `{}` empty object.
- Date values lost entirely on read.

Root Cause [R1]:
- `typeof new Date() === "object"` → normalize recursed INTO Date.
- Object recursion iterated Date's own-keys (none) → empty `{}`.

Solution [SO1]:
- Early-return BEFORE object recursion: `if (v instanceof Date) return v;`.
- Order matters: Date check placed after bigint, before Array/object.

Ref [REF1]:
- oas-command-stats/src/storage/duckdb.ts:22 (`if (v instanceof Date) return v;`)
- Function: NORMALIZE_FN, duckdb.ts:23

Gotchas [G1]:
- `typeof` unreliable for class instances — object catch-all traps Date, RegExp, Map, Buffer.
- Recursion guards must list ALL pass-through classes before generic object branch.
- Same trap awaits Buffer/Uint8Array if BLOB columns added later.
