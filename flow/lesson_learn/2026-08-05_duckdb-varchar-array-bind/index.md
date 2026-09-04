# DuckDB VARCHAR[] Bind Failure

Context [C1]:
- Phase 2 GREEN, cmd_events INSERT via duckdb-node.
- positional_args + flags = JS string arrays → VARCHAR[] columns.

Symptom [S1]:
- Error: `Conversion Error: Type VARCHAR with value 'hi' can't be cast to destination type VARCHAR[]`.
- Bind of JS array collapsed to first scalar element.

Root Cause [R1]:
- duckdb-node does NOT auto-bind JS arrays to VARCHAR[] columns.
- Driver treats array param as scalar VARCHAR, not list.

Solution [SO1]:
- Bind as JSON-string: `JSON.stringify(parsed.positional_args ?? [])`.
- Add explicit `?::VARCHAR[]` cast in SQL VALUES clause.
- DuckDB parses JSON array literal → VARCHAR[].

Ref [REF1]:
- oas-command-stats/src/storage/ingest.ts:152 (`?::VARCHAR[]` cast)
- oas-command-stats/src/storage/ingest.ts:157-158 (JSON.stringify bind)
- Comment: ingest.ts:144-145

Gotchas [G1]:
- Applies to ALL list-type columns (VARCHAR[], INTEGER[], etc.), not just VARCHAR[].
- NULL vs empty: use `?? []` else NULL binds break cast.
- Cast MUST be in SQL, not JS — driver won't infer target type.
