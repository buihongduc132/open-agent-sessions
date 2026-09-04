# Bun + duckdb-node Segfault on 2nd Instance

Context [C1]:
- Phase 2, readonly connection needed alongside write connection.
- Attempted `new Database(path)` 2nd time on same file, same Bun process.

Symptom [S1]:
- `terminate called after throwing an instance of 'Napi::Error'`.
- Then SIGSEGV — full process crash, no catchable error.

Root Cause [R1]:
- Opening 2nd `new Database(path)` on same file in one Bun process crashes native module.
- Bun N-API + duckdb-node native binding incompatibility.

Solution [SO1] (Phase 2 STUB):
- Software-only readonly guard — NOT DB-level readonly.
- Regex blocks write SQL on the guarded handle.
- `writeRe` = INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|MERGE|COPY.

Ref [REF1]:
- oas-command-stats/src/storage/duckdb.ts:99 (openReadOnly)
- oas-command-stats/src/storage/duckdb.ts:104 (writeRe)
- oas-command-stats/src/storage/duckdb.ts:122-124 (guard throw OT18)
- Comment: duckdb.ts:100-102

Gotchas [G1]:
- STUB — guard is app-level only; real readonly NOT enforced by DB.
- Phase 5 MUST solve via: CLI shell-out, FFI binding, different runtime, OR singleton pool.
- Native segfault uncatchable — cannot try/catch; must avoid 2nd instance entirely.
- Do NOT rely on duckdb-node `readonly` option under Bun — it segfaults too.
