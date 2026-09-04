/**
 * OT43 — complexity bucketing for parse-rate measurement.
 *
 * Heuristic bucketing by command structure to set realistic success-rate
 * targets: ≥99% on simple, ≥95% on medium+complex.
 *
 * @file src/parse/complexity.ts
 */
import type { ComplexityBucket } from "../types/contract";

export function bucketComplexity(cmd: string): ComplexityBucket {
  if (!cmd) return "simple";

  const trimmed = cmd.trim();

  // Empty or pure comment → simple (parser handles trivially).
  if (!trimmed) return "simple";
  if (/^#/.test(trimmed)) return "simple";
  if (trimmed === ":") return "simple";

  // Complex signals: nested subst, heredocs, loops, find -exec, ANSI-C quoting
  const complexSignals: RegExp[] = [
    /\$\(/,           // command substitution $(
    /<\(/,            // process substitution <(
    /<<[A-Z\-]*'?/,   // heredoc <<EOF, <<'EOF'
    /\$'/,            // ANSI-C quoting $'...'
    /\bfor\s+\w+\s+in\b/,  // for loops
    /\bwhile\s+/,
    /\buntil\s+/,
    /\bcase\s+.*\bin\b/,
    /-exec\b/,
    /xargs\b.*sh\s+-c/,
    /\bparallel\b/,
  ];
  for (const re of complexSignals) {
    if (re.test(cmd)) return "complex";
  }

  // Count logical separators for statement_count
  const pipeCount = (cmd.match(/\|/g) ?? []).length;
  // && and || and ; — count as statement boundaries (exclude inside quotes
  // approximately by simple regex)
  const andCount = (cmd.match(/&&/g) ?? []).length;
  const orCount = (cmd.match(/\|\|/g) ?? []).length;
  const semiCount = (cmd.match(/;/g) ?? []).length;

  // Adjusted pipe count excludes || (counted as orCount above)
  const purePipeCount = pipeCount - orCount * 2;
  const stmtBoundaries = purePipeCount + andCount + orCount + semiCount;

  // 3+ statements → complex
  if (stmtBoundaries >= 2) return "complex";

  // 1-2 pipes OR && / || → medium
  if (purePipeCount >= 1 || andCount >= 1 || orCount >= 1) return "medium";

  // Otherwise simple
  return "simple";
}
