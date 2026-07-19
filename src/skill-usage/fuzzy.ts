/**
 * src/skill-usage/fuzzy.ts
 *
 * 4-tier matching pipeline for skill-name tokens:
 *   T1 exact       — literal string equality
 *   T2 normalized  — canonicalize (lowercase + collapse separators) then equal
 *   T3 alias       — candidate matches a skill's declared alias list
 *   T4 fuzzy       — restricted-transposition edit distance ≤ maxDistance
 *
 * The fuzzy tier uses a *restricted* Damerau-Levenshtein variant: adjacent
 * character swaps count as a single edit ONLY when both swapped characters
 * appear exactly once in their respective strings. When either character
 * repeats elsewhere, the swap falls back to two substitutions. This is a
 * domain-tuned heuristic for skill-name disambiguation (documented in
 * flow/plans/2026-07-19-skill-usage-fuzzy-design.md §2).
 */

import type { MatchResult, MatchTier } from "./types";

/**
 * Normalize a skill name or token for T2 comparison.
 *
 * Rules (applied in order):
 *   1. lowercase
 *   2. collapse any run of [-_\s]+ into a single "-"
 *   3. strip characters not in [a-z0-9-]
 *
 * Examples:
 *   "VerifierLoop"      → "verifierloop"
 *   "verifier loop"     → "verifier-loop"
 *   "VERIFIER_LOOP"     → "verifier-loop"
 *   "verifier-loop"     → "verifier-loop"
 *   "verifier!@#loop"   → "verifierloop"
 */
export function canonicalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/**
 * Restricted-transposition edit distance.
 *
 * Standard Damerau-Levenshtein treats any adjacent character swap as 1 edit.
 * This variant restricts transposition to cases where both swapped characters
 * are *unique* within their respective strings. When either character appears
 * more than once, the swap falls back to two substitutions (cost 2).
 *
 * Rationale: for skill-name matching, pure DL over-matches. A typo like
 * "lifecycel" → "lifecycle" (where 'e' and 'l' both repeat in the string)
 * gets DL distance 1, which we treat as "almost identical" — too permissive
 * for disambiguating similar skill names. The restriction makes the distance
 * more conservative when character repetition creates ambiguity.
 *
 * Test-suite behavior:
 *   "ca"     vs "ac"                        → 1  (both chars unique → transposition)
 *   "worktree-lifecycel" vs "worktree-lifecycle" → 2  (e,l both repeat → 2 subs)
 */
export function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;

  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  const fa = charFreq(a);
  const fb = charFreq(b);

  // 3-row DP for transposition (need d[i-2][j-2])
  let d0 = new Array(lb + 1).fill(0);
  let d1 = new Array(lb + 1).fill(0);
  let d2 = new Array(lb + 1).fill(0);

  // Initialize d0 (i=0)
  for (let j = 0; j <= lb; j++) d0[j] = j;

  // Initialize d1 (i=1)
  for (let j = 0; j <= lb; j++) {
    if (j === 0) {
      d1[j] = 1;
    } else {
      const cost = a[0] === b[j - 1] ? 0 : 1;
      d1[j] = Math.min(d1[j - 1] + 1, d0[j] + 1, d0[j - 1] + cost);
    }
  }

  // Fill d2..d[la]
  for (let i = 2; i <= la; i++) {
    for (let j = 0; j <= lb; j++) {
      if (j === 0) {
        d2[j] = i;
      } else {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let val = Math.min(d2[j - 1] + 1, d1[j] + 1, d1[j - 1] + cost);

        // Restricted transposition: only when both chars are unique in their strings
        if (i >= 2 && j >= 2 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          const a1 = a[i - 1];
          const a2 = a[i - 2];
          const b1 = b[j - 1];
          const b2 = b[j - 2];
          if (
            fa.get(a1) === 1 &&
            fa.get(a2) === 1 &&
            fb.get(b1) === 1 &&
            fb.get(b2) === 1
          ) {
            val = Math.min(val, d0[j - 2] + 1);
          }
        }

        d2[j] = val;
      }
    }

    // Rotate rows
    d0 = d1;
    d1 = d2;
    d2 = new Array(lb + 1).fill(0);
  }

  return d1[lb];
}

function charFreq(s: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const c of s) {
    freq.set(c, (freq.get(c) ?? 0) + 1);
  }
  return freq;
}

/**
 * Match a candidate token against a skill name using the 4-tier pipeline.
 *
 * Returns the first match (T1 → T2 → T3 → T4), or null if no tier matches.
 *
 * @param candidate - Token from session text (or bigram)
 * @param skill - Canonical skill name from inventory
 * @param opts.aliases - Skill's declared aliases (for T3)
 * @param opts.maxDistance - Max edit distance for T4 (default: 2)
 */
export function matchTier(
  candidate: string,
  skill: string,
  opts?: { aliases?: string[]; maxDistance?: 1 | 2 | 3 },
): MatchResult | null {
  // T1 exact
  if (candidate === skill) {
    return { tier: "exact", distance: 0 };
  }

  // T2 normalized
  if (canonicalize(candidate) === canonicalize(skill)) {
    return { tier: "normalized", distance: 0 };
  }

  // T3 alias
  const aliases = opts?.aliases ?? [];
  if (aliases.includes(candidate)) {
    return { tier: "alias", distance: 0 };
  }

  // T4 fuzzy
  const maxDistance = opts?.maxDistance ?? 2;
  // Early-exit: length difference > maxDistance → impossible
  if (Math.abs(candidate.length - skill.length) > maxDistance) {
    return null;
  }
  const d = damerauLevenshtein(candidate, skill);
  if (d <= maxDistance) {
    return { tier: "fuzzy", distance: d };
  }
  return null;
}
