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
    return { terms: [], hasBoolean: false, excludeTerms: [], originalQuery: query, hasRegex: false };
  }

  try {
    const ast = parse(query);
    const terms: string[] = [];
    const excludeTerms: string[] = [];

    walkAst(ast.expression, terms, excludeTerms);

    const hasBoolean =
      terms.length > 1 || // implicit AND
      excludeTerms.length > 0 ||
      hasExplicitBooleanOperators(query);

    const hasRegex = query.includes("/");

    return {
      terms,
      hasBoolean,
      excludeTerms,
      originalQuery: query,
      hasRegex,
    };
  } catch {
    // If parsing fails, fall back to treating the whole query as a single term
    return {
      terms: [query.trim()],
      hasBoolean: false,
      excludeTerms: [],
      originalQuery: query,
      hasRegex: false,
    };
  }
}

/**
 * Walk the liqe AST, extracting search terms and NOT terms.
 */
function walkAst(node: Node, terms: string[], excludeTerms: string[]): void {
  if (!node) return;

  if (node.type === "TermExpression") {
    const term = node.value;
    if (term && typeof term === "string" && term.length > 0) {
      terms.push(term);
    }
    return;
  }

  if (node.type === "BinaryExpression") {
    const bin = node as {
      type: "BinaryExpression";
      operator: string;
      left: Node;
      right: Node;
    };

    if (bin.operator === "NOT") {
      // "NOT X" → X is excluded
      const rightTerms: string[] = [];
      walkAst(bin.right, rightTerms, []);
      for (const t of rightTerms) {
        excludeTerms.push(t);
      }
      // Still need left side if it exists (e.g. "X NOT Y")
      walkAst(bin.left, terms, excludeTerms);
      return;
    }

    // AND or OR: recurse into both sides
    walkAst(bin.left, terms, excludeTerms);
    walkAst(bin.right, terms, excludeTerms);
    return;
  }

  if (node.type === "GroupExpression") {
    walkAst((node as { expression: Node }).expression, terms, excludeTerms);
    return;
  }
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
