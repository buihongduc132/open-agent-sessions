# Phase 4 — PII Redaction + Retention Legal Basis

> Date: 2026-08-05
> Phase: 4
> Status: implemented (commit abf792d)
> Respects: OT30 (rank5 GDPR), OT10-G1, OT10-G4, OT10-G5

## Scope

oas-command-stats ingests raw shell commands from CLI agent sessions
(pi JSONL + zcode SQLite + hermes SQLite). These commands routinely
contain PII: bearer tokens, AWS keys, env secrets, git passwords,
credit-card numbers, sshpass credentials.

Phase 4 redacts PII at ingestion (write) time. cmd_events stores
redacted cmd_text + PII-free cmd_signature. Raw outbox keeps original
raw_command for replay but is time-bounded by hard TTL.

## Legal basis (GDPR Art. 6)

Lawful basis for retention: **legitimate interest (Art. 6(1)(f))**.

- **Purpose**: sysops/devops analytics — most-run commands, time-of-day
  patterns, repo usage, failure rates (LD3 locked decision).
- **Necessity**:聚合 stats require raw cmd storage; no less-invasive
  alternative achieves the analytics purpose.
- **Balancing test**: PII redaction at write + TTL trim + retention_hold
  override minimizes data subject impact. cmd_signature (sha256 of
  redacted) enables long-term analytics WITHOUT PII retention.
- **Data subject rights**: TTL auto-trim + soft cap sample_excluded
  enforce right-to-be-forgotten (Art. 17). retention_hold BOOLEAN
  supports legal-hold scenarios (Art. 6(1)(c)).

## Retention knobs (OT30 (e))

### Hard TTL (age, privacy-driven)

- **outbox.raw_command**: 7 days (short TTL; raw PII-bearing)
- **cmd_events.cmd_text**: 7 days (redacted, but still potentially
  identifying via cwd/args context)
- **cmd_events.cmd_signature**: 90 days (PII-free sha256; analytics-grade)
- **cmd_quarantine.raw_command**: 7 days (same as outbox)

Implementation: `trimExpired(db, {hard_ttl_days: N})` in
`src/storage/retention.ts`. DELETE + VACUUM = forensic unrecoverable.

### Soft cap (size, sampling not deletion)

- **max_rows**: configurable; oldest rows beyond cap marked
  `sample_excluded=TRUE`, NOT deleted. Analytics queries filter on
  `sample_excluded=FALSE` for representative sampling.

Implementation: `enforceSoftCap(db, {max_rows: N})` in
`src/storage/retention.ts`. Marks via ROW_NUMBER() window.

## retention_hold BOOLEAN (OT30 (d))

Rows with `retention_hold=TRUE` skip TTL trim. Use cases:
- Legal hold (litigation preservation)
- Active incident investigation
- Manual analyst flagging

Implementation: outbox + cmd_events both have `retention_hold BOOLEAN
NOT NULL DEFAULT FALSE`. trimExpired WHERE clause excludes held rows.

## PII redaction patterns (OT30 (a))

Order matters: bearer → AWS → git-https → sshpass → env-assign → cc.
env-assign uses negative lookahead to skip already-redacted values.

Implementation: `redact(cmd)` in `src/parse/pii.ts`.

## cmd_signature (OT30 (b))

`computeSignature(cmd) = sha256(redact(cmd))[:32]`.

PII-free because redact() runs first. Stable across re-ingest.
Enables long-term (90d) analytics without PII storage.

## Data subject rights mapping

| GDPR Article | Implementation |
|--------------|----------------|
| Art. 5(1)(c) data minimization | redact() at write; cmd_text TTL 7d |
| Art. 5(1)(e) storage limitation | trimExpired hard TTL |
| Art. 6(1)(f) legitimate interest | this doc + LD3 sysops purpose |
| Art. 17 right to erasure | trimExpired DELETE+VACUUM |
| Art. 17(3)(b) legal hold | retention_hold BOOLEAN |
| Art. 25 privacy by design | redaction on write, not on read |

## Review cadence

This legal basis document is reviewed:
- On any Phase 4 contract change
- On any GDPR Art. 6 basis change
- Annually (next review: 2027-08-05)

## Reference

- Phase 4 GREEN commit: abf792d
- Phase 4 RED commit: 37f4e24
- Phase 3 verifier hash (independent): 06a02071
- Phase 4 self-verify hash (fallback): 45b4525b
- Phase 5 OT18 blocker: GH issue #36
