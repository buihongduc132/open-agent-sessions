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

  const configResult = resolveConfig(options);
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

              // Gap B: Also search content via findSimilarSessions when available
              if (options.findSimilarSessions) {
                try {
                  const normalizedTerm = normalizeFuzzyQuery(searchText.replace(/^\/|\/$/g, ""));
                  const contentResults = await options.findSimilarSessions(normalizedTerm);
                  mergeContentResults(matched, contentResults);
                } catch {
                  // Content search failed — continue with regex results only
                }
              }

              return { sessions: matched, errors: allResult.errors };
            }
          }

          const query: SearchQuery = { cwd: process.cwd(), text: searchText };
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

      // Gap B: Also search content via findSimilarSessions for the full query
      // and union results with boolean evaluation
      if (options.findSimilarSessions) {
        try {
          const normalizedQuery = normalizeFuzzyQuery(rawQuery.replace(/ AND | OR | NOT /gi, " "));
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
        let contentResults;
        try {
          contentResults = await options.findSimilarSessions(normalizedQuery);
        } catch (simError) {
          // findSimilarSessions failed — fall back to title-only search
          const query: SearchQuery = { cwd: process.cwd(), text: rawQuery };
          const fallbackResult = await options.searchSessions(query);
          filteredSessions = fallbackResult.sessions;
          resultErrors = fallbackResult.errors;
          if (filteredSessions.length === 0) {
            return errorResult(simError instanceof Error ? simError.message : String(simError));
          }
          if (excludedIds.size > 0) {
            filteredSessions = filteredSessions.filter((s) => !excludedIds.has(s.id));
          }
          const stderr = formatErrors(resultErrors);
          if (filteredSessions.length === 0) {
            return { exitCode: 0, stdout: "No sessions found.\n", stderr };
          }
          const stdout = filteredSessions.map(formatSessionRow).join("\n") + "\n";
          return { exitCode: 0, stdout, stderr };
        }
        filteredSessions = contentResultsToSessions(contentResults);
      } else {
        const query: SearchQuery = { cwd: process.cwd(), text: rawQuery };
        const result = await options.searchSessions(query);
        filteredSessions = result.sessions;
        resultErrors = result.errors;
      }
    }
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : (typeof error === "string" ? error : "Unknown error");
    return errorResult(message);
  }

  if (excludedIds.size > 0) {
    filteredSessions = filteredSessions.filter((s) => !excludedIds.has(s.id));
  }

  const stderr = formatErrors(resultErrors);
  if (filteredSessions.length === 0) {
    return { exitCode: 0, stdout: "No sessions found.\n", stderr };
  }

  const stdout = filteredSessions.map(formatSessionRow).join("\n") + "\n";
  return { exitCode: 0, stdout, stderr };
}

// ============================================================================
// Config Resolution
// ============================================================================

type ConfigResult = { ok: true; value: Config } | { ok: false; error: string };

function resolveConfig(opts: {
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
}): ConfigResult {
  if (opts.config) return { ok: true, value: opts.config };
  if (opts.configPath && opts.loadConfig) {
    try {
      return { ok: true, value: opts.loadConfig(opts.configPath) };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  }
  return { ok: false, error: "Missing config. " + USAGE };
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatSessionRow(session: SessionSummary): string {
  const label = "[" + session.agent + ":" + session.alias + "]";
  const title = session.title.trim().length > 0 ? session.title : session.id;
  if (title === session.id) return label + " " + session.id;
  return label + " " + title + " (" + session.id + ")";
}

function formatErrors(errors: SearchError[]): string {
  if (errors.length === 0) return "";
  const lines = errors.map((e) => {
    const label = "[" + e.agent + ":" + e.alias + "]";
    if (e.message.includes(label)) return e.message;
    return label + " " + e.message;
  });
  return lines.join("\n") + "\n";
}

function errorResult(message: string): CliResult {
  return { exitCode: 1, stdout: "", stderr: message + "\n" };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Convert SimilarSessionResult[] to SessionSummary[] (content search results
 * use a different shape). All such results are marked as "opencode/personal"
 * since content search only runs against the local FTS index.
 */
function contentResultsToSessions(results: SimilarSessionResult[]): SessionSummary[] {
  return results.map((r) => ({
    id: r.sessionId,
    agent: "opencode" as AgentKind,
    alias: "personal" as const,
    title: r.title,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    message_count: r.matchedChunks,
    storage: "other" as const,
  }));
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
 * Check if a query is a regex pattern wrapped in /.../ delimiters.
 */
function isRegexPattern(query: string): boolean {
  return /^\/.+\/[gimsuy]*$/.test(query);
}

/**
 * Parse a /pattern/ query into a RegExp. Returns null if invalid.
 */
function parseRegex(query: string): RegExp | null {
  const match = query.match(/^\/(.+)\/([gimsuy]*)$/);
  if (!match) return null;
  try {
    // Default to case-insensitive if no 'i' flag specified
    const flags = match[2].includes("i") ? match[2] : match[2] + "i";
    return new RegExp(match[1], flags);
  } catch {
    return null;
  }
}
