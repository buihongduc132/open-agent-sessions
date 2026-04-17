/**
 * src/search/planner.ts
 *
 * Parse user search queries using liqe (Lucene-compatible) and produce a
 * structured SearchPlan that can be evaluated against multiple backends.
 *
 * Query syntax (Lucene-compatible):
 *   "ast-grep AND comby"   → both terms required
 *   "ast-grep OR comby"    → either term sufficient
 *   "ast-grep NOT comby"   → ast-grep required, comby forbidden
 *   "ast-grep comby"      → both terms required (implicit AND)
 *   "(ast-grep OR comby) AND gritql"  → grouping
 *   /regex-pattern/        → regex match
 *
 * The plan extracts individual search terms that can be passed to backends
 * individually, with boolean logic applied in the CLI layer.
 *
 * ⚠️ ARCHITECTURE NOTE:
 * This module's `planFromQuery` and `applyBooleanLogic` are NOT used by
 * production code. The production boolean search path uses the custom
 * tokenizer/parser in `src/cli/search-boolean.ts` instead (see
 * executeBooleanSearch). This module remains because:
 *   1. It provides an alternative liqe-based parser with Lucene-compatible
 *      syntax that may be re-integrated when liqe parsing stabilises.
 *   2. Test files (test/cli-gaps-edge-cases-2.test.ts) validate these
 *      functions to ensure they remain correct if re-activated.
 * See _16apr_gaps.md for the full architecture decision.
 */

import { parse, type Node } from "liqe";

export interface SearchPlan {
  /** Individual search terms to query each backend with (AND semantics). */
  terms: string[];
  /** True when the query contains AND/OR/NOT operators. */
  hasBoolean: boolean;
  /** Terms that must NOT appear in results (from NOT operator). */
  excludeTerms: string[];
  /** Original query for backends that handle boolean natively. */
  originalQuery: string;
  /** True when query contains a regex pattern. */
  hasRegex: boolean;

  // ── REQ-22: Per-backend predicates (3-layer architecture) ────────────────

  /** FTS5 MATCH predicate string for SQLite backends (e.g. "astgrep AND comby"). */
  fts5Query: string;
  /** Streaming filter function for JSONL backends. Returns true when text matches. */
  jsonlFilter: (text: string) => boolean;
  /** Individual positive terms for vector similarity search backends. */
  vectorTerms: string[];
  /** The boolean operator detected: "AND", "OR", or "NONE" (single term). */
  booleanOp: "AND" | "OR" | "NONE";
}

/**
 * Parse a user query into a structured SearchPlan.
 *
 * Strategy:
 * - Use liqe to parse the query into an AST
 * - Walk the AST to extract search terms and NOT terms
 * - Return a plan where each term can be searched individually
 * - Boolean operators are evaluated in the CLI layer (AND = intersect, OR = union)
 */
export function planFromQuery(query: string): SearchPlan {
  if (!query || query.trim().length === 0) {
    return {
      terms: [],
      hasBoolean: false,
      excludeTerms: [],
      originalQuery: query,
      hasRegex: false,
      fts5Query: "",
      jsonlFilter: (_text: string) => true, // empty filter matches everything
      vectorTerms: [],
      booleanOp: "NONE" as const,
    };
  }

  try {
    const ast = parse(query);
    const terms: string[] = [];
    const excludeTerms: string[] = [];
    const orGroups: string[][] = [];

    walkAst(ast, terms, excludeTerms, orGroups);

    const hasBoolean =
      terms.length > 1 || // implicit AND
      excludeTerms.length > 0 ||
      hasExplicitBooleanOperators(query);

    const hasRegex = query.includes("/");

    // REQ-22: Detect the boolean operator from the query
    const booleanOp = detectBooleanOp(query, terms.length);

    // REQ-22: Build per-backend predicates
    const fts5Query = buildFts5Query(terms, excludeTerms, booleanOp, orGroups);
    const jsonlFilter = buildJsonlFilter(terms, excludeTerms, booleanOp);
    // REQ-22: vectorTerms — normalized positive terms for vector similarity search.
    // Exclude NOT terms; normalize by stripping hyphens for embedding lookup.
    const vectorTerms = terms
      .filter((t) => !excludeTerms.includes(t))
      .map(normalizeTerm)
      .filter((t) => t.length > 0);

    return {
      terms,
      hasBoolean,
      excludeTerms,
      originalQuery: query,
      hasRegex,
      fts5Query,
      jsonlFilter,
      vectorTerms,
      booleanOp,
    };
  } catch {
    // If parsing fails, fall back to treating the whole query as a single term
    const fallbackTerm = query.trim();
    const normalizedTerm = normalizeTerm(fallbackTerm);
    return {
      terms: [fallbackTerm],
      hasBoolean: false,
      excludeTerms: [],
      originalQuery: query,
      hasRegex: false,
      fts5Query: normalizedTerm,
      jsonlFilter: (text: string) => text.toLowerCase().includes(normalizedTerm),
      vectorTerms: [normalizedTerm],
      booleanOp: "NONE" as const,
    };
  }
}

/**
 * Collect terms from a subtree and push them onto the excludeTerms list.
 * Used by all NOT patterns (explicit, implicit, legacy) to DRY the
 * "walk subtree → collect → push to excludes" sequence.
 */
function collectAndExclude(node: any, excludeTerms: string[]): void {
  const collected: string[] = [];
  walkAst(node, collected, []);
  for (const t of collected) {
    excludeTerms.push(t);
  }
}

/**
 * Walk the liqe AST, extracting search terms and NOT terms.
 * Handles liqe's actual node types: Tag, LogicalExpression, LiteralExpression, etc.
 */
function walkAst(node: any, terms: string[], excludeTerms: string[], orGroups?: string[][]): void {
  if (!node) return;

  // ParenthesizedExpression: unwrap and recurse into the inner expression
  if (node.type === "ParenthesizedExpression") {
    walkAst(node.expression, terms, excludeTerms, orGroups);
    return;
  }

  // Tag node: contains an expression (LiteralExpression, etc.) under .expression
  // and optionally a field under .field
  if (node.type === "Tag") {
    // Named fields (e.g., agent:opencode) are filters, not search terms.
    // Only recurse for ImplicitField tags (bare search terms).
    if (node.field?.type === "Field") {
      return; // skip named field values from search terms
    }
    // ImplicitField: treat as regular search term
    walkAst(node.expression, terms, excludeTerms, orGroups);
    return;
  }

  // Leaf nodes: LiteralExpression (current liqe) or TermExpression (legacy)
  if (node.type === "LiteralExpression" || node.type === "TermExpression") {
    const term = node.value;
    if (term && typeof term === "string" && term.length > 0) {
      terms.push(term);
    }
    return;
  }

  // LogicalExpression: binary node with .left, .right, .operator
  if (node.type === "LogicalExpression") {
    const op = node.operator;
    const opType = op?.type;
    const opValue = op?.operator;

    // Check for NOT: either explicit "NOT" or ImplicitBooleanOperator with NOT on right
    if (opType === "BooleanOperator" && opValue === "NOT") {
      // "X NOT Y" → Y is excluded
      collectAndExclude(node.right, excludeTerms);
      walkAst(node.left, terms, excludeTerms, orGroups);
      return;
    }

    // liqe parses "ast-grep NOT comby" as:
    //   LogicalExpression { operator: ImplicitBooleanOperator("AND"), right: UnaryOperator(NOT) }
    if (opType === "ImplicitBooleanOperator" && node.right?.type === "UnaryOperator" && node.right?.operator === "NOT") {
      collectAndExclude(node.right.operand, excludeTerms);
      walkAst(node.left, terms, excludeTerms, orGroups);
      return;
    }

    // OR: collect terms into a group so FTS5 can preserve grouping
    if (opType === "BooleanOperator" && opValue === "OR") {
      const groupTerms: string[] = [];
      walkAst(node.left, groupTerms, []);
      walkAst(node.right, groupTerms, []);
      for (const t of groupTerms) {
        terms.push(t);
      }
      if (orGroups) {
        orGroups.push([...groupTerms]);
      }
      return;
    }

    // AND or implicit AND: recurse into both sides
    walkAst(node.left, terms, excludeTerms, orGroups);
    walkAst(node.right, terms, excludeTerms, orGroups);
    return;
  }

  // Legacy: BinaryExpression (older liqe versions)
  if (node.type === "BinaryExpression") {
    const bin = node as {
      type: "BinaryExpression";
      operator: string;
      left: Node;
      right: Node;
    };

    if (bin.operator === "NOT") {
      collectAndExclude(bin.right, excludeTerms);
      walkAst(bin.left, terms, excludeTerms, orGroups);
      return;
    }

    walkAst(bin.left, terms, excludeTerms, orGroups);
    walkAst(bin.right, terms, excludeTerms, orGroups);
    return;
  }

  // GroupExpression: wrapper around an inner expression
  if (node.type === "GroupExpression") {
    walkAst((node as { expression: Node }).expression, terms, excludeTerms, orGroups);
    return;
  }

  // UnaryOperator: NOT prefix
  if (node.type === "UnaryOperator" && node.operator === "NOT") {
    collectAndExclude(node.operand, excludeTerms);
    return;
  }
}

// ── REQ-22: Per-backend predicate builders ──────────────────────────────────

/**
 * Normalize a search term for FTS5: strip hyphens so "ast-grep" → "astgrep".
 * FTS5 tokenizes on hyphens, so the compound form matches both.
 */
function normalizeTerm(term: string): string {
  return term.replace(/-/g, "").toLowerCase();
}

/**
 * Detect the top-level boolean operator from the query string.
 * Returns "AND" for explicit AND or implicit multi-term, "OR" for explicit OR,
 * or "NONE" for single-term queries.
 */
function detectBooleanOp(query: string, termCount: number): "AND" | "OR" | "NONE" {
  const upper = query.toUpperCase();
  if (/\bOR\b/.test(upper)) return "OR";
  if (/\bAND\b/.test(upper) || /\bNOT\b/.test(upper) || termCount > 1) return "AND";
  return "NONE";
}

/**
 * Build an FTS5 MATCH query string from extracted terms.
 * FTS5 syntax: "term1 AND term2", "term1 OR term2", "term1 NOT term2"
 * Hyphens are stripped since FTS5 tokenizes on them.
 */
function buildFts5Query(terms: string[], excludeTerms: string[], op: "AND" | "OR" | "NONE", orGroups?: string[][]): string {
  const normalized = terms.map(normalizeTerm).filter((t) => t.length > 0);
  const normalizedExclude = excludeTerms.map(normalizeTerm).filter((t) => t.length > 0);

  if (normalized.length === 0) return "";

  // If we have OR groups with remaining terms outside, build structured query
  if (orGroups && orGroups.length > 0) {
    const normalizedOrGroups = orGroups
      .map((group) => group.map(normalizeTerm).filter((t) => t.length > 0))
      .filter((group) => group.length > 0);

    // Track which terms belong to OR groups
    const orGroupTerms = new Set(orGroups.flat());
    const remainingTerms = terms
      .filter((t) => !orGroupTerms.has(t))
      .map(normalizeTerm)
      .filter((t) => t.length > 0);

    // Single OR group with no remaining terms → flat OR (no parens)
    if (normalizedOrGroups.length === 1 && remainingTerms.length === 0) {
      let positive = normalizedOrGroups[0].join(" OR ");
      if (normalizedExclude.length > 0) {
        positive += " NOT " + normalizedExclude.join(" NOT ");
      }
      return positive;
    }

    // Multiple groups or remaining terms → structured with parens
    const parts: string[] = [];
    for (const group of normalizedOrGroups) {
      if (group.length === 1) {
        parts.push(group[0]);
      } else {
        parts.push("(" + group.join(" OR ") + ")");
      }
    }
    for (const term of remainingTerms) {
      parts.push(term);
    }

    let positive = parts.join(" AND ");
    if (normalizedExclude.length > 0) {
      positive += " NOT " + normalizedExclude.join(" NOT ");
    }
    return positive;
  }

  // Build positive part (no OR groups)
  let positive: string;
  if (op === "OR") {
    positive = normalized.join(" OR ");
  } else {
    // AND or NONE (single term)
    positive = normalized.join(" AND ");
  }

  // Append NOT terms
  if (normalizedExclude.length > 0) {
    positive += " NOT " + normalizedExclude.join(" NOT ");
  }

  return positive;
}

/**
 * Build a streaming filter function for JSONL backends.
 * Returns a predicate that checks message text against the query terms.
 * Case-insensitive matching; hyphens stripped from both text and terms.
 */
function buildJsonlFilter(
  terms: string[],
  excludeTerms: string[],
  op: "AND" | "OR" | "NONE"
): (text: string) => boolean {
  const normalized = terms.map(normalizeTerm).filter((t) => t.length > 0);
  const normalizedExclude = excludeTerms.map(normalizeTerm).filter((t) => t.length > 0);

  if (normalized.length === 0 && normalizedExclude.length === 0) {
    return (_text: string) => true; // empty query matches everything
  }

  return (text: string): boolean => {
    const lower = text.toLowerCase().replace(/-/g, "");

    // Check positive terms
    let positiveMatch: boolean;
    if (normalized.length === 0) {
      positiveMatch = true; // only exclusion, match everything positive
    } else if (op === "OR") {
      positiveMatch = normalized.some((t) => lower.includes(t));
    } else {
      // AND or NONE: all terms must be present
      positiveMatch = normalized.every((t) => lower.includes(t));
    }

    // Check exclusion terms
    if (positiveMatch && normalizedExclude.length > 0) {
      const hasExcluded = normalizedExclude.some((t) => lower.includes(t));
      if (hasExcluded) return false;
    }

    return positiveMatch;
  };
}

/**
 * Check if the raw query string contains explicit AND/OR/NOT operators.
 */
function hasExplicitBooleanOperators(query: string): boolean {
  const upper = query.toUpperCase();
  return (
    upper.includes(" AND ") ||
    upper.includes(" OR ") ||
    upper.includes(" NOT ") ||
    /\bNOT\b/i.test(query)
  );
}

/**
 * Apply boolean logic to search results.
 *
 * AND = intersection of results for each term
 * OR  = union of results (deduplicated by sessionId)
 * NOT = remove results containing exclude terms
 *
 * @param resultsByTerm Map of term → session IDs returned for that term
 * @param operator "AND" | "OR"
 * @param excludeIds Set of session IDs to exclude (from NOT terms)
 */
export function applyBooleanLogic(
  resultsByTerm: Map<string, Set<string>>,
  operator: "AND" | "OR",
  excludeIds: Set<string>
): Set<string> {
  const termResultSets = Array.from(resultsByTerm.values());

  if (termResultSets.length === 0) {
    return new Set();
  }

  let result: Set<string>;

  if (operator === "AND") {
    // Intersection: start with first term's results, intersect with each subsequent
    result = new Set(termResultSets[0]);
    for (let i = 1; i < termResultSets.length; i++) {
      const nextSet = termResultSets[i];
      for (const id of result) {
        if (!nextSet.has(id)) {
          result.delete(id);
        }
      }
    }
  } else {
    // OR: union of all terms' results
    result = new Set();
    for (const ids of termResultSets) {
      for (const id of ids) {
        result.add(id);
      }
    }
  }

  // Apply NOT exclusions
  for (const excludeId of excludeIds) {
    result.delete(excludeId);
  }

  return result;
}
