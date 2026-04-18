import { AgentKind, Config } from "../config/types";
import { SessionSummary, SearchQuery } from "../core/types";
import { CliResult } from "./types";
import {
  executeBooleanSearch,
  isBooleanQuery,
  type BooleanSearchOptions,
  EvalContext,
} from "./search-boolean";
import type { SimilarSessionResult } from "../similarity/search";
import { resolveConfig, errorResult, errorMessage } from "./utils/config";
import { formatErrors as formatErrorsShared, formatSessionRowSimple } from "./formatters/text";

const USAGE = `Usage: oas search --text <query>

Options:
  --text QUERY    Search text (required)

Searches session titles and message content.`;

// ============================================================================
// Types
// ============================================================================

export type SearchService = (query: SearchQuery) => Promise<SearchResult>;

export type ContentSearchService = (text: string) => Promise<SimilarSessionResult[]>;

export type SearchResult = {
  sessions: SessionSummary[];
  errors: SearchError[];
};

export type SearchError = {
  agent: AgentKind;
  alias: string;
  message: string;
};

export type SearchOptions = {
  text?: string;
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
  currentSessionId?: string;
  excludeCurrent?: boolean;
  excludeSession?: string[];
  searchSessions: SearchService;
  findSimilarSessions?: ContentSearchService;
};

// ============================================================================
// Main Command
// ============================================================================

export async function runSearchCommand(options: SearchOptions): Promise<CliResult> {
  if (!options.text || String(options.text).trim().length === 0) {
    return { exitCode: 1, stdout: "", stderr: "Missing required argument: --text\n" };
  }

  const configResult = resolveConfig(options, USAGE);
  if (!configResult.ok) {
    return errorResult(configResult.error);
  }

  const rawQuery = String(options.text).trim();

  const excludedIds = new Set<string>();
  if (options.excludeCurrent && options.currentSessionId) {
    excludedIds.add(options.currentSessionId);
  }
  if (options.excludeSession) {
    for (const id of options.excludeSession) {
      excludedIds.add(id);
    }
  }

  let filteredSessions: SessionSummary[];
  let resultErrors: SearchError[] = [];

  try {
    if (isBooleanQuery(rawQuery)) {
      // Collect regex terms for deferred content search (after boolean evaluation)
      const deferredContentSearches: string[] = [];

      const searchOpts: BooleanSearchOptions = {
        rawQuery,
        searchTerm: async (term: string, ctx: EvalContext) => {
          // Wildcard term "*" is used by executeBooleanSearch to expand the
          // universe for standalone NOT queries. Use a common vowel to
          // maximize session coverage when the service doesn't support
          // true wildcard queries.
          const searchText = term === "*" ? "e" : term;

          // Gap A: Handle regex terms within boolean queries
          if (isRegexPattern(searchText)) {
            const regex = parseRegex(searchText);
            if (regex) {
              // Fetch all sessions via wildcard search, then filter by regex
              const allQuery: SearchQuery = { cwd: process.cwd(), text: "e" };
              const allResult = await options.searchSessions(allQuery);
              const matched = allResult.sessions.filter((s) =>
                regex.test(s.title) || regex.test(s.id)
              );
              if (term !== "*") {
                ctx.recordTerm(term, matched);
              }

              // Defer content search for regex terms — will run after boolean eval
              // so the findSimilarSessions call isn't overwritten by subsequent terms
              const normalizedTerm = normalizeFuzzyQuery(searchText.replace(/^\/|\/[gimsuy]*$/g, ""));
              deferredContentSearches.push(normalizedTerm);

              return { sessions: matched, errors: allResult.errors };
            }
          }

          const normalizedSearchText = normalizeFuzzyQuery(searchText);
          const query: SearchQuery = { cwd: process.cwd(), text: normalizedSearchText };
          const result = await options.searchSessions(query);
          if (term !== "*") {
            ctx.recordTerm(term, result.sessions);
          }

          // Gap B: Also search content via findSimilarSessions when available
          if (options.findSimilarSessions && term !== "*") {
            try {
              const normalizedTerm = normalizeFuzzyQuery(searchText);
              const contentResults = await options.findSimilarSessions(normalizedTerm);
              mergeContentResults(result.sessions, contentResults);
            } catch {
              // Content search failed for this term — continue with title results only
            }
          }

          return result;
        },
      };
      const boolResult = await executeBooleanSearch(searchOpts);
      filteredSessions = boolResult.sessions;
      resultErrors = boolResult.errors;

      // Deferred: run content search for regex terms after boolean evaluation
      // This ensures findSimilarSessions is called last for regex terms,
      // preventing the call from being overwritten by non-regex terms.
      if (options.findSimilarSessions && deferredContentSearches.length > 0) {
        for (const contentText of deferredContentSearches) {
          try {
            const contentResults = await options.findSimilarSessions(contentText);
            mergeContentResults(filteredSessions, contentResults);
          } catch {
            // Content search failed — continue with boolean results only
          }
        }
      } else if (options.findSimilarSessions) {
        // Gap B: No regex terms — run full-query content search after boolean eval
        // to supplement boolean results with content matches
        try {
          const normalizedQuery = normalizeFuzzyQuery(
            rawQuery.replace(/ AND | OR | NOT /gi, " ")
          );
          const contentResults = await options.findSimilarSessions(normalizedQuery);
          mergeContentResults(filteredSessions, contentResults);
        } catch {
          // Content search failed — continue with boolean results only
        }
      }
    } else if (isRegexPattern(rawQuery)) {
      // Gap A: Handle regex patterns /pattern/
      const regex = parseRegex(rawQuery);
      if (regex) {
        // Fetch all sessions via wildcard-like search, then filter by regex
        const query: SearchQuery = { cwd: process.cwd(), text: "e" };
        const result = await options.searchSessions(query);
        filteredSessions = result.sessions.filter((s) =>
          regex.test(s.title) || regex.test(s.id)
        );
        resultErrors = result.errors;
      } else {
        // Invalid regex — fall back to plain search
        const query: SearchQuery = { cwd: process.cwd(), text: rawQuery };
        const result = await options.searchSessions(query);
        filteredSessions = result.sessions;
        resultErrors = result.errors;
      }
    } else {
      if (options.findSimilarSessions) {
        // Normalize hyphenated queries for fuzzy/substring matching
        const normalizedQuery = normalizeFuzzyQuery(rawQuery);

        // Always run title search for agent/alias resolution and fallback
        const titleQuery: SearchQuery = { cwd: process.cwd(), text: rawQuery };
        const titleResult = await options.searchSessions(titleQuery);

        let contentResults: SimilarSessionResult[] | undefined;
        try {
          contentResults = await options.findSimilarSessions(normalizedQuery);
        } catch (simError) {
          // findSimilarSessions failed — fall back to title-only search
          filteredSessions = titleResult.sessions;
          resultErrors = titleResult.errors;
          if (filteredSessions.length === 0) {
            return errorResult(simError instanceof Error ? simError.message : String(simError));
          }
          // Skip content resolution — use title results; fall through to
          // shared exclusion + formatting at the end of the function.
        }

        if (contentResults !== undefined) {
          if (contentResults.length === 0) {
            // Content search found nothing — fall back to title-only results
            filteredSessions = titleResult.sessions;
            resultErrors = titleResult.errors;
          } else {
            // Resolve agent/alias from title results + config for content matches
            filteredSessions = contentResultsToSessions(
              contentResults,
              titleResult.sessions,
              configResult.value,
            );
          }
        }
      } else {
        const query: SearchQuery = { cwd: process.cwd(), text: normalizeWhitespace(rawQuery) };
        const result = await options.searchSessions(query);
        filteredSessions = result.sessions;
        resultErrors = result.errors;
      }
    }
  } catch (error) {
    return errorResult(errorMessage(error));
  }

  if (excludedIds.size > 0) {
    filteredSessions = filteredSessions.filter((s) => !excludedIds.has(s.id));
  }

  const stderr = formatErrorsShared(resultErrors);
  if (filteredSessions.length === 0) {
    return { exitCode: 0, stdout: "No sessions found.\n", stderr };
  }

  const stdout = filteredSessions.map(formatSessionRowSimple).join("\n") + "\n";
  return { exitCode: 0, stdout, stderr };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Convert SimilarSessionResult[] to SessionSummary[] (content search results
 * use a different shape). Resolves agent/alias from known sessions first,
 * then falls back to config-based sessionId prefix matching.
 */
function contentResultsToSessions(
  results: SimilarSessionResult[],
  knownSessions: SessionSummary[] = [],
  config?: Config,
): SessionSummary[] {
  // Build lookup from known sessions (title search results)
  const sessionLookup = new Map<string, SessionSummary>();
  for (const s of knownSessions) {
    sessionLookup.set(s.id, s);
  }

  return results.map((r) => {
    // Try to find in known sessions first for correct agent/alias
    const known = sessionLookup.get(r.sessionId);
    if (known) {
      return {
        ...known,
        title: r.title || known.title,
        message_count: r.matchedChunks,
      };
    }

    // Try to match agent from config based on sessionId prefix (e.g. "codex-xxx" → codex)
    let agent: AgentKind = "opencode";
    let alias = "personal";
    if (config) {
      for (const entry of config.agents) {
        if (r.sessionId.toLowerCase().startsWith(entry.agent.toLowerCase() + "-")) {
          agent = entry.agent;
          alias = entry.alias;
          break;
        }
      }
    }

    return {
      id: r.sessionId,
      agent,
      alias,
      title: r.title,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      message_count: r.matchedChunks,
      storage: "other" as const,
    };
  });
}

/**
 * Merge content search results into an existing session list, deduplicating
 * by session ID. Sessions already present in `existing` are skipped.
 */
function mergeContentResults(
  existing: SessionSummary[],
  contentResults: SimilarSessionResult[],
): void {
  const contentSessions = contentResultsToSessions(contentResults);
  const existingIds = new Set(existing.map((s) => s.id));
  for (const cs of contentSessions) {
    if (!existingIds.has(cs.id)) {
      existing.push(cs);
      existingIds.add(cs.id);
    }
  }
}

function normalizeFuzzyQuery(query: string): string {
  // Remove hyphen separator so "ast-grep" is searched as single compound token "astgrep"
  // (FTS5 MATCH will match "astgrep" within "ast-grep" etc.)
  return query.replace(/-/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Normalize whitespace (tabs, newlines, multiple spaces) to single spaces.
 * Does NOT remove hyphens — used for plain search path.
 */
function normalizeWhitespace(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

/**
 * Check if a query is a regex pattern wrapped in /.../ delimiters.
 */
function isRegexPattern(query: string): boolean {
  return /^\/.+\/[gimsuy]*$/.test(query);
}

/**
 * Detect nested quantifier patterns that cause catastrophic backtracking (ReDoS).
 * E.g. patterns like (a+)+ or (x*)* or (a|a)+ where quantified groups wrap quantified content.
 * Returns true if the pattern is potentially dangerous.
 */
function hasNestedQuantifiers(pattern: string): boolean {
  // Strip escaped characters and character classes so we only analyse
  // the structural quantifiers, not literal +/* inside [] or after \.
  const stripped = pattern
    .replace(/\\[^]/g, " ")   // remove escaped chars (\+, \*, \\, etc.)
    .replace(/\[[^\]]*\]/g, "m");  // remove char classes [...] (non-nested)

  // Detect quantified group containing quantified content:
  // e.g. (a+)+, (x*)*, (a|b)+ with inner quantifiers
  const nestedQuantifier = /\([^()]*[+*][^()]*\)[+*{]/;
  if (nestedQuantifier.test(stripped)) return true;

  // Detect alternation with overlapping branches + quantifier:
  // e.g. (a|a)+ where identical alternatives cause exponential branching
  const overlapAlt = /\(([^|()]+)\|\1\)[+*{]/;
  if (overlapAlt.test(stripped)) return true;

  return false;
}

/**
 * Parse a /pattern/ query into a RegExp. Returns null if invalid or dangerous.
 *
 * - Strips the 'g' flag: it causes stateful .test() in filter loops
 *   (lastIndex advances per call, silently dropping every-other match).
 * - Rejects patterns with nested quantifiers to prevent ReDoS.
 */
function parseRegex(query: string): RegExp | null {
  const match = query.match(/^\/(.+)\/([gimsuy]*)$/);
  if (!match) return null;
  try {
    const pattern = match[1];

    // ReDoS protection: reject nested quantifier patterns
    if (hasNestedQuantifiers(pattern)) return null;

    // Strip 'g' flag — it is harmful in boolean .test() filter loops.
    // 'g' is only useful for matchAll/exec loops, which we never use.
    const rawFlags = match[2].replace(/g/g, "");
    // Default to case-insensitive if no 'i' flag specified
    const flags = rawFlags.includes("i") ? rawFlags : rawFlags + "i";
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}
