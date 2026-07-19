/**
 * RED tests for src/skill-usage/fuzzy.ts
 *
 * Covers: canonicalize, damerauLevenshtein, matchTier.
 * All scenarios from design doc section 7 (worst-case test scenarios).
 *
 * These tests MUST fail in RED phase because src/skill-usage/ does not exist yet.
 */
import { describe, expect, test } from "bun:test";
// Import from not-yet-existing module — RED phase expects module-not-found
import {
  canonicalize,
  damerauLevenshtein,
  matchTier,
} from "../../src/skill-usage/fuzzy";

describe("canonicalize", () => {
  test("PascalCase VerifierLoop → verifierloop", () => {
    // No separator in PascalCase → collapses to single token
    expect(canonicalize("VerifierLoop")).toBe("verifierloop");
  });

  test("space variant 'verifier loop' → 'verifier-loop'", () => {
    expect(canonicalize("verifier loop")).toBe("verifier-loop");
  });

  test("underscore variant 'VERIFIER_LOOP' → 'verifier-loop'", () => {
    expect(canonicalize("VERIFIER_LOOP")).toBe("verifier-loop");
  });

  test("hyphen 'verifier-loop' → 'verifier-loop'", () => {
    expect(canonicalize("verifier-loop")).toBe("verifier-loop");
  });

  test("strips non-alphanumeric", () => {
    expect(canonicalize("verifier!@#loop")).toBe("verifierloop");
  });
});

describe("damerauLevenshtein", () => {
  test("identical strings → 0", () => {
    expect(damerauLevenshtein("abc", "abc")).toBe(0);
  });

  test("single substitution 'abc'→'abd' → 1", () => {
    expect(damerauLevenshtein("abc", "abd")).toBe(1);
  });

  test("adjacent transposition 'ca'→'ac' → 1 (Damerau)", () => {
    // Plain Levenshtein would be 2; Damerau-Levenshtein must be 1
    expect(damerauLevenshtein("ca", "ac")).toBe(1);
  });

  test("missing hyphen 'verifier-loop'→'verifierloop' → 1", () => {
    expect(damerauLevenshtein("verifier-loop", "verifierloop")).toBe(1);
  });

  test("typo 'worktree-lifecycel' vs 'worktree-lifecycle' → 2 (transposition of le/el)", () => {
    // last 4 chars: cycl vs cyce → swap, then sub → 2
    // Actually 'lifecycel' vs 'lifecycle': positions 5-6 transposed
    expect(damerauLevenshtein("worktree-lifecycel", "worktree-lifecycle")).toBe(2);
  });
});

describe("matchTier", () => {
  test("T1 exact match → {tier:'exact', distance:0}", () => {
    const result = matchTier("verifier-loop", "verifier-loop");
    expect(result).toEqual({ tier: "exact", distance: 0 });
  });

  test("T2 normalized: 'verifier loop' vs 'verifier-loop' → {tier:'normalized', distance:0}", () => {
    const result = matchTier("verifier loop", "verifier-loop");
    expect(result).toEqual({ tier: "normalized", distance: 0 });
  });

  test("T2 normalized: PascalCase 'VerifierLoop' vs 'verifierloop' → {tier:'normalized', distance:0}", () => {
    const result = matchTier("VerifierLoop", "verifierloop");
    expect(result).toEqual({ tier: "normalized", distance: 0 });
  });

  test("T3 alias match: 'jewilo' with aliases:['jewilo'] → {tier:'alias', distance:0}", () => {
    const result = matchTier("jewilo", "verifier-loop", { aliases: ["jewilo"] });
    expect(result).toEqual({ tier: "alias", distance: 0 });
  });

  test("T4 fuzzy: 'worktree-lifecycel' vs 'worktree-lifecycle' with maxDistance:2 → {tier:'fuzzy', distance:2}", () => {
    const result = matchTier("worktree-lifecycel", "worktree-lifecycle", { maxDistance: 2 });
    expect(result).toEqual({ tier: "fuzzy", distance: 2 });
  });

  test("out of distance: 'verifier' vs 'verifier-loop' with maxDistance:2 → null", () => {
    // distance is 5 (need to add -loop) — exceeds 2
    const result = matchTier("verifier", "verifier-loop", { maxDistance: 2 });
    expect(result).toBeNull();
  });

  test("precision guard: 'vrfr' vs 'verifier-loop' with maxDistance:2 → null (no subsequence match)", () => {
    const result = matchTier("vrfr", "verifier-loop", { maxDistance: 2 });
    expect(result).toBeNull();
  });

  test("no options defaults to maxDistance 2", () => {
    // 'ab' vs 'ac' is distance 1, within default maxDistance 2 → fuzzy
    const result = matchTier("ab", "ac");
    expect(result).toEqual({ tier: "fuzzy", distance: 1 });
  });
});
