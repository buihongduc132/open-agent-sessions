/**
 * src/cli/search-boolean.ts
 *
 * Boolean query parser for Lucene-style AND / OR / NOT operators.
 * Operator precedence: NOT > AND > OR
 *
 * Architecture:
 *   Phase 1 (collectAndSeedAll): Pre-collect results from ALL non-NOT terms
 *   → seed ctx with full universe for NOT complement calculation
 *   Phase 2 (evalNode): Evaluate full AST with pre-seeded ctx
 *   → NOT uses ctx.getAllSessions() without re-recording its operand
 */

import type { SessionSummary } from "../core/types";
import type { SearchService, SearchResult } from "./search";
import { errorMessage } from "./utils/config";

export interface BooleanSearchOptions {
  rawQuery: string;
  /** Called per term. MUST call ctx.recordTerm(term, sessions) for NOT to work. */
  searchTerm: (term: string, ctx: EvalContext) => Promise<SearchResult>;
}

export interface BooleanSearchResult {
  sessions: SessionSummary[];
  errors: SearchError[];
}

interface SearchError {
  agent: string;
  alias: string;
  message: string;
}
// NOTE: This SearchError is structurally compatible with the one exported by
// search.ts (which uses `agent: AgentKind`). The boolean module uses `string`
// because error-generating catch blocks may produce `agent: "unknown"` when
// the originating agent cannot be determined. The errors flow from here into
// search.ts via BooleanSearchResult.errors, which is assigned to the stricter
// SearchError[] from search.ts — this is safe at runtime since AgentKind is a
// string union.

// ─── Lexer ─────────────────────────────────────────────────────────────────

interface Token {
  type: "TERM" | "AND" | "OR" | "NOT" | "LPAREN" | "RPAREN" | "EOF";
  value: string;
}

function tokenize(q: string): Token[] {
  const t: Token[] = [];
  let i = 0;
  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i])) i++;
    if (i >= q.length) break;
    const ch = q[i];
    if (ch === "(") { t.push({ type: "LPAREN", value: "(" }); i++; continue; }
    if (ch === ")") { t.push({ type: "RPAREN", value: ")" }); i++; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch; i++;
      let val = "";
      while (i < q.length && q[i] !== quote) { val += q[i]; i++; }
      i++;
      t.push({ type: "TERM", value: val.trim() });
      continue;
    }
    let word = "";
    while (i < q.length && !/\s/.test(q[i]) && q[i] !== "(" && q[i] !== ")") {
      word += q[i]; i++;
    }
    if (!word) continue;
    const u = word.toUpperCase();
    if (u === "AND") t.push({ type: "AND", value: "AND" });
    else if (u === "OR") t.push({ type: "OR", value: "OR" });
    else if (u === "NOT") t.push({ type: "NOT", value: "NOT" });
    else t.push({ type: "TERM", value: word });
  }
  t.push({ type: "EOF", value: "" });
  return t;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

type AstNode =
  | { type: "term"; value: string }
  | { type: "and"; left: AstNode; right: AstNode }
  | { type: "or"; left: AstNode; right: AstNode }
  | { type: "not"; operand: AstNode };

class Parser {
  private t: Token[];
  private p = 0;
  constructor(tokens: Token[]) { this.t = tokens; }

  parse(): AstNode { return this.parseOr(); }

  private peek(): Token { return this.t[this.p] ?? { type: "EOF", value: "" }; }
  private consume(): Token { return this.t[this.p++]; }
  private expect(type: Token["type"]): Token {
    const tok = this.consume();
    if (tok.type !== type) throw new Error(`Expected ${type}, got ${tok.type}`);
    return tok;
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.peek().type === "OR") { this.consume(); left = { type: "or", left, right: this.parseAnd() }; }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseNot();
    while (this.peek().type === "AND" || this.peek().type === "NOT" || this.peek().type === "TERM") {
      if (this.peek().type === "NOT") {
        // Implicit AND: "X NOT Y" = "X AND (NOT Y)"
        const right = this.parseNot();
        left = { type: "and", left, right };
      } else if (this.peek().type === "AND") {
        this.consume(); // consume AND
        const right = this.parseNot();
        left = { type: "and", left, right };
      } else {
        // Implicit AND: bare TERM after another term/expression
        const right = this.parsePrimary();
        left = { type: "and", left, right };
      }
    }
    return left;
  }

  private parseNot(): AstNode {
    if (this.peek().type === "NOT") { this.consume(); return { type: "not", operand: this.parseNot() }; }
    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    const tok = this.peek();
    if (tok.type === "TERM") {
      this.consume();
      let value = tok.value;
      // Strip matching outer parentheses: "((ast-grep))" → "(ast-grep)" → "ast-grep"
      while (value.startsWith("(") && value.endsWith(")")) {
        value = value.slice(1, -1);
      }
      // Strip matching outer quotes: '"term"' → 'term'
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return { type: "term", value };
    }
    if (tok.type === "LPAREN") {
      this.consume();
      if (this.peek().type === "EOF" || this.peek().type === "RPAREN") {
        // Empty parentheses "()" → treat as empty term
        if (this.peek().type === "RPAREN") this.consume();
        return { type: "term", value: "" };
      }
      const node = this.parseOr();
      if (this.peek().type === "RPAREN") this.consume();
      return node;
    }
    this.consume();
    return { type: "term", value: tok.value };
  }
}

function parseQuery(q: string): AstNode {
  const trimmed = q.trim();
  // Use the same detection logic as isBooleanQuery to ensure consistency
  if (!isBooleanQuery(trimmed)) {
    return { type: "term", value: trimmed };
  }
  // Full parse for queries with operators or parentheses
  return new Parser(tokenize(trimmed)).parse();
}

// ─── Context ────────────────────────────────────────────────────────────────

export class EvalContext {
  private sessions = new Map<string, SessionSummary>();

  /**
   * Seed ctx with all available sessions (for NOT complement calculation).
   * Does NOT record via recordTerm() — these are universe, not results.
   */
  seedAll(results: SessionSummary[]): void {
    for (const s of results) this.sessions.set(s.id, s);
  }

  recordTerm(term: string, results: SessionSummary[]): void {
    if (term === "*") return; // skip wildcard seeding
    for (const s of results) this.sessions.set(s.id, s);
  }

  getAllSessions(): SessionSummary[] { return Array.from(this.sessions.values()); }
}

// ─── Evaluator ─────────────────────────────────────────────────────────────

interface EvalResult {
  sessions: SessionSummary[];
  excludeSet: Set<string>;
  errors: SearchError[];
}

function empty(excludeSet: Set<string> = new Set(), errors: SearchError[] = []): EvalResult {
  return { sessions: [], excludeSet, errors };
}

function collectErrors(errors: SearchError[], into: Map<string, SearchError>): void {
  for (const e of errors) {
    const k = `${e.agent}:${e.alias}`;
    const existing = into.get(k);
    if (existing) {
      // Merge messages: append if different
      if (existing.message !== e.message) {
        existing.message = existing.message + "; " + e.message;
      }
    } else {
      into.set(k, { ...e });
    }
  }
}

async function evalNode(node: AstNode, options: BooleanSearchOptions, ctx: EvalContext): Promise<EvalResult> {
  switch (node.type) {
    case "term": {
      if (!node.value.trim()) return empty(new Set(), []);
      try {
        const result = await options.searchTerm(node.value.trim(), ctx);
        return { sessions: result.sessions, excludeSet: new Set(), errors: result.errors };
      } catch (error) {
        const errorMsg = errorMessage(error);
        return empty(new Set(), [{ agent: "unknown", alias: "unknown", message: errorMsg }]);
      }
    }
    case "and": {
      const left = await evalNode(node.left, options, ctx);
      const right = await evalNode(node.right, options, ctx);
      let combined: SessionSummary[];
      if (left.sessions.length > 0 && right.sessions.length > 0) {
        const rightIds = new Set(right.sessions.map(s => s.id));
        combined = left.sessions.filter(s => rightIds.has(s.id));
      } else {
        combined = [];
      }
      const allExclude = new Set([...left.excludeSet, ...right.excludeSet]);
      return {
        sessions: combined.filter(s => !allExclude.has(s.id)),
        excludeSet: allExclude,
        errors: [...left.errors, ...right.errors],
      };
    }
    case "or": {
      const left = await evalNode(node.left, options, ctx);
      const right = await evalNode(node.right, options, ctx);
      const seen = new Set<string>();
      const combined: SessionSummary[] = [];
      for (const s of [...left.sessions, ...right.sessions]) {
        if (!seen.has(s.id)) { seen.add(s.id); combined.push(s); }
      }
      // OR merges sessions from both sides; excludeSets only affect individual
      // operands' results and should NOT bleed into the combined union.
      return {
        sessions: combined,
        excludeSet: new Set<string>(),
        errors: [...left.errors, ...right.errors],
      };
    }
    case "not": {
      // NOT(X): complement against the pre-seeded universe (ctx.getAllSessions()).
      // For simple terms, search directly. For compound operands (AND/OR),
      // recursively evaluate to get the set of sessions to exclude.
      const all = ctx.getAllSessions();
      let operandSessions: SessionSummary[];
      let operandErrors: SearchError[];

      if (node.operand.type === "term") {
        // Simple term: search directly
        const termValue = node.operand.value.trim();
        try {
          const operandResult = await options.searchTerm(termValue, ctx);
          operandSessions = operandResult.sessions;
          operandErrors = operandResult.errors;
        } catch (error) {
          const errorMsg = errorMessage(error);
          return empty(new Set(), [{ agent: "unknown", alias: "unknown", message: errorMsg }]);
        }
      } else {
        // Compound operand (AND/OR): recursively evaluate to find sessions to exclude
        const operandResult = await evalNode(node.operand, options, ctx);
        operandSessions = operandResult.sessions;
        operandErrors = operandResult.errors;
      }

      const excludeIds = new Set(operandSessions.map(s => s.id));
      return {
        sessions: all.filter(s => !excludeIds.has(s.id)),
        excludeSet: excludeIds,
        errors: operandErrors,
      };
    }
    default: {
      return evalNode({ type: "term", value: "" }, options, ctx);
    }
  }
}

// ─── Phase 1: Pre-collect all non-NOT term results ─────────────────────────

/**
 * Recursively collect searchTerm results from ALL term nodes in the AST.
 * Skips NOT operands (they are only evaluated during Phase 2, and we do NOT
 * want to record them since that would corrupt the universe for NOT complement).
 * Deduplicates by term string to avoid duplicate searches.
 */
async function collectAndSeedAll(
  node: AstNode,
  options: BooleanSearchOptions,
  ctx: EvalContext,
  seenTerms: Set<string>,
  phase1Errors?: SearchError[]
): Promise<void> {
  switch (node.type) {
    case "term": {
      const term = node.value.trim();
      if (!term || seenTerms.has(term)) return;
      seenTerms.add(term);
      try {
        const result = await options.searchTerm(term, ctx);
        ctx.seedAll(result.sessions);
        // Gap F: Propagate errors from Phase 1
        if (phase1Errors && result.errors) {
          for (const e of result.errors) {
            phase1Errors.push(e);
          }
        }
      } catch {
        // Partial failure during seeding — skip this term, continue with others
      }
      break;
    }
    case "and":
    case "or": {
      await collectAndSeedAll(node.left, options, ctx, seenTerms, phase1Errors);
      await collectAndSeedAll(node.right, options, ctx, seenTerms, phase1Errors);
      break;
    }
    case "not": {
      // Collect NOT operands for the universe so that NOT can compute
      // the complement against the full set of matching sessions.
      await collectAndSeedAll(node.operand, options, ctx, seenTerms, phase1Errors);
      break;
    }
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Check whether the AST contains any NOT nodes at any depth.
 */
function astContainsNot(node: AstNode): boolean {
  if (node.type === "not") return true;
  if (node.type === "and" || node.type === "or") {
    return astContainsNot(node.left) || astContainsNot(node.right);
  }
  return false;
}

/**
 * Check if a query contains boolean operators or parentheses.
 * Uses word-boundary-aware detection to avoid "ast-grep" matching "AND".
 */
export function isBooleanQuery(query: string): boolean {
  const u = query.trim();
  // Skip regex patterns entirely — /pattern/ with optional flags should never
  // be routed through the boolean parser. Check this BEFORE operators/parens
  // because regex patterns like /(a{2,}){3,}/ contain parentheses.
  if (/^\/.+\/[gimsuy]*$/.test(u)) return false;
  // Match standalone NOT at start or after operator/parens: "NOT comby", "AND NOT foo"
  const hasNotOp = (/\bNOT\b/i.test(u) || /^\s*NOT\s/i.test(u));
  const hasOperator = (/\bAND\b/i.test(u) || /\bOR\b/i.test(u));
  const hasParens = (u.includes("(") || u.includes(")"));
  return hasOperator || hasNotOp || hasParens;
}

/**
 * Execute a boolean query.
 *
 * Phase 1: collectAndSeedAll walks the AST, searching all non-NOT terms and
 *   seeding ctx with their results. This builds the "universe" for NOT.
 * Phase 2: evalNode evaluates the full AST with the pre-seeded ctx.
 *   NOT computes its complement against the universe WITHOUT re-recording.
 */
export async function executeBooleanSearch(options: BooleanSearchOptions): Promise<BooleanSearchResult> {
  const ast = parseQuery(options.rawQuery);
  const ctx = new EvalContext();

  // Phase 1: pre-collect universe (with error tracking)
  const phase1Errors: SearchError[] = [];
  await collectAndSeedAll(ast, options, ctx, new Set<string>(), phase1Errors);

  // Special case: any NOT nodes in the AST (not just root) need full universe.
  // Phase 1 only seeds results from the NOT operands, so the universe is too small.
  // Do a wildcard search to expand the universe with all accessible sessions.
  if (astContainsNot(ast)) {
    try {
      const wildcardResult = await options.searchTerm("*", ctx);
      ctx.seedAll(wildcardResult.sessions);
    } catch {
      // Wildcard search failed — continue with existing universe
    }
  }

  // Phase 2: evaluate
  const results = await evalNode(ast, options, ctx);
  const allErrors = [...phase1Errors, ...results.errors];
  const errorMap = new Map<string, SearchError>();
  collectErrors(allErrors, errorMap);
  return { sessions: results.sessions, errors: Array.from(errorMap.values()) };
}
