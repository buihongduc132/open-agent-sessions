# Auditor Ceremony Violations

Evidence [E1]:
- Auditor run for pi-goal msf02zrg-6cp56a (oas-command-stats)
- APPEND_SYSTEM.md + base.md ceremony rules active
- Auditor emitted `<approved/>` with 11 behavioral violations
- V9 = HARD-CONTRACT BREACH: self-verify hash ≠ independent verifier-loop approval

Violations [V1-11]:
- [V1] Caveman OFF. APPEND_SYSTEM "Mode: full" active. Full prose, articles, sentences.
- [V2] Wall of text. base.md ≤20 words. Paragraphs >20 words.
- [V3] Structure missing. base.md req [E1][C1][F1][R1][A][CA]. None present.
- [V4] Showcase markdown. Heavy tables, bold headers, fancy formatting.
- [V5] Diplomatic speech. Softening language ("with documented ceremony caveat").
- [V6] No LSL created. AGENTS.md mandates LSL when mistake made. Skipped.
- [V7] GitNexus bypassed. Used grep/find. AGENTS.md mandates gitnexus_query for code exploration.
- [V8] Skills not loaded first. verifier-loop, codebase-utils, worst-first-testing not read before audit.
- [V9] Self-verify APPROVED = HARD-CONTRACT BREACH.
  Contract: "no verifier-loop approval hash → instant disapproved".
  P1 hash 7c6a90e1 = SELF-VERIFY (3 attempts REJECTED).
  verifier-loop req 2+ unanimous INDEPENDENT verifiers.
  Self-verify ≠ verifier-loop approval. Should DISAPPROVE.
- [V10] No tool-update callout. AGENTS.md "Tool update awareness" rule ignored.
- [V11] Wrong verdict. V9 means correct verdict = disapproved. approved = ERROR.

Cause [C1]:
- [C1] Auditor focused on content review, ignored all behavioral ceremony rules.
- [C2] Self-verify hash mistaken for independent approval. Contract not read carefully.
- [C3] Goal override "stub if blocked" misapplied to ceremony gates. Override = execution only.

Fixed [F1]:
- [F1] LSL codified at this path.
- [F2] AGENTS.md lesson_learn entry 8 added.
- [F3] Verifier-ceremony LSL (entry 1) referenced — same pattern, different role.

Prevention [P1]:
- Before any verdict: caveman ON? structure present? ≤30 words/line? LSL created?
- Self-verify hash ≠ independent verifier approval. Always check hash source.
- Goal overrides apply to execution, NEVER to ceremony/approval gates.
- Load skills FIRST: verifier-loop, codebase-utils, worst-first-testing.

Callout [CA1]:
- Ceremony rules apply to ALL roles: verifier, auditor, worker, reviewer.
- Technical correctness does not excuse behavioral violations.
- Self-verify is NOT approval. Contract requires 2+ independent verifiers.
- V9 is most critical — wrong verdict (approved vs disapproved) = contract breach.

Assumptions [A1]:
- APPEND_SYSTEM.md + base.md rules global (all pi agent sessions, all roles).
- Auditor verdicts subject to same ceremony as other outputs.
- verifier-loop skill contract is authoritative for approval requirements.
- "stub if blocked" goal override does not override ceremony gates.
