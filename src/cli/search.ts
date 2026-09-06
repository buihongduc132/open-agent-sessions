import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
import { formatErrors as formatErrorsShared, formatSessionRowSimple, formatSessionsJson } from "./formatters/text";
import type { Database } from "bun:sqlite";
import { openSearchDb, closeSearchDb, initSearchSchema } from "../search/db";
import { querySearch, extractTurnSnippet } from "../search/engine";
import { syncAllSessions, type SyncFileInput } from "../search/sync";
import { collectJsonlFiles, resolvePath, safeStat } from "../adapters/fs-utils";
import { loadConfigFromFile } from "../config/load";

const USAGE = `Usage: oas search --text <query> [options]

Options:
  --text QUERY         Search text (required)
  --session ID         Filter by full or 7-character session ID
  -C, --context N      Show N context turns before and after each hit
  --sync               Sync session files before searching
  --no-sync            Skip synchronization and search current index directly
  --no-color           Suppress ANSI color highlighting
  --format FORMAT      Output format: 'text' or 'json'

Searches session titles and message content using FTS5 full-text search.`;

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
  format?: "text" | "json";
  searchSessions?: SearchService;
  findSimilarSessions?: ContentSearchService;

  // Milestone 6 FTS5 search options
  db?: Database;
  dbPath?: string;
  context?: number;
  contextN?: number;
  session?: string;
  sync?: boolean;
  noSync?: boolean;
  sessionFiles?: SyncFileInput[];
  noColor?: boolean;
  limit?: number;
  agent?: string;
  alias?: string;
};

// ============================================================================
// Main Command
// ============================================================================

export async function runSearchCommand(options: SearchOptions): Promise<CliResult> {
  if (!options.text || String(options.text).trim().length === 0) {
    return { exitCode: 1, stdout: "", stderr: "Missing required argument: --text\n" };
  }

  const isFts5 =
    options.db !== undefined ||
    options.dbPath !== undefined ||
    options.context !== undefined ||
    options.contextN !== undefined ||
    options.session !== undefined ||
    options.sync !== undefined ||
    options.noSync !== undefined ||
    options.sessionFiles !== undefined ||
    !options.searchSessions;

  if (isFts5) {
    return runFts5Search(options);
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

  let filteredSessions: SessionSummary[] = [];
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
      resultErrors = boolResult.errors as SearchError[];

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
    const emptyJson = options.format === "json" ? "[]\n" : "No sessions found.\n";
    return { exitCode: 0, stdout: emptyJson, stderr };
  }

  const stdout = options.format === "json"
    ? formatSessionsJson(filteredSessions)
    : filteredSessions.map(formatSessionRowSimple).join("\n") + "\n";
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
    // Respect user-provided flags. If no flags specified, default to case-insensitive.
    const flags = rawFlags.length > 0 ? rawFlags : "i";
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Discovers session files from configured agents or standard agent directories.
 */
export function discoverSessionFiles(config?: Config): SyncFileInput[] {
  let cfg = config;

  if (!cfg) {
    const configPaths = [
      ...(process.env.OAS_CONFIG_PATH ? [process.env.OAS_CONFIG_PATH] : []),
      ...(process.env.XDG_CONFIG_HOME
        ? [
            join(process.env.XDG_CONFIG_HOME, "oas", "config.yaml"),
            join(process.env.XDG_CONFIG_HOME, "oas", "config.yml"),
          ]
        : []),
      join(process.cwd(), "oas.config.yaml"),
      join(process.cwd(), "oas.config.yml"),
      join(homedir(), ".config", "oas", "config.yaml"),
      join(homedir(), ".config", "oas", "config.yml"),
    ];

    for (const p of configPaths) {
      if (existsSync(p)) {
        try {
          cfg = loadConfigFromFile(p);
          break;
        } catch {
          // Ignore unreadable config files during auto-discovery
        }
      }
    }
  }

  const rawDiscovered: SyncFileInput[] = [];

  if (cfg && Array.isArray(cfg.agents)) {
    for (const entry of cfg.agents) {
      if (entry.enabled === false) {
        continue;
      }

      const agent = String(entry.agent);
      const alias = String(entry.alias);
      const record = entry as Record<string, unknown>;

      // 1. Explicit path in entry
      const explicitPath =
        typeof record.path === "string" && record.path.trim().length > 0
          ? resolvePath(record.path)
          : undefined;

      // 2. OpenCode storage config (jsonl_path)
      const opencodeStorage = record.storage as Record<string, unknown> | undefined;
      const opencodeJsonlPath =
        opencodeStorage && typeof opencodeStorage.jsonl_path === "string"
          ? resolvePath(opencodeStorage.jsonl_path)
          : undefined;

      const targetPaths: string[] = [];
      if (explicitPath) {
        targetPaths.push(explicitPath);
      }
      if (opencodeJsonlPath) {
        targetPaths.push(opencodeJsonlPath);
      }

      // 3. Fallback default paths if neither explicitPath nor opencodeJsonlPath exists
      if (targetPaths.length === 0) {
        const home = homedir();
        if (agent === "claude") {
          targetPaths.push(join(home, ".claude", "transcripts"), join(home, ".claude", "sessions"));
        } else if (agent === "pi") {
          targetPaths.push(join(home, ".pi", "sessions"), join(home, ".omp", "agent", "sessions"));
        } else if (agent === "codex") {
          targetPaths.push(join(home, ".codex", "sessions"), join(home, ".codex", "transcripts"));
        } else if (agent === "grok") {
          const grokHome = process.env.GROK_HOME ? process.env.GROK_HOME : join(home, ".grok");
          targetPaths.push(join(grokHome, "sessions"));
        } else if (agent === "opencode") {
          targetPaths.push(
            join(home, ".local", "share", "opencode", "sessions"),
            join(home, ".opencode", "sessions")
          );
        } else if (agent === "gemini") {
          targetPaths.push(
            join(home, ".gemini", "sessions"),
            join(home, ".gemini", "antigravity-cli", "conversations")
          );
        } else if (agent === "antigravity") {
          targetPaths.push(
            join(home, ".gemini", "antigravity-cli"),
            join(home, ".antigravity", "sessions")
          );
        } else if (agent === "hermes") {
          targetPaths.push(join(home, ".hermes", "sessions"));
        } else if (agent === "zcode") {
          targetPaths.push(join(home, ".zcode", "sessions"));
        }
      }

      for (const root of targetPaths) {
        const stat = safeStat(root);
        if (!stat) continue;
        if (stat.isFile()) {
          if (root.endsWith(".jsonl")) {
            let sessionId = basename(root, ".jsonl");
            if (agent === "antigravity") {
              const brainMatch = root.match(/brain[/\\]([^/\\]+)/);
              if (brainMatch) sessionId = brainMatch[1];
            }
            rawDiscovered.push({
              path: root,
              agent,
              alias,
              sessionId,
            });
          }
        } else if (stat.isDirectory()) {
          try {
            if (agent === "antigravity") {
              const brainPath = existsSync(join(root, "brain"))
                ? join(root, "brain")
                : basename(root) === "brain"
                  ? root
                  : undefined;

              if (brainPath && safeStat(brainPath)?.isDirectory()) {
                const uuids = readdirSync(brainPath);
                for (const u of uuids) {
                  const transcript = join(brainPath, u, ".system_generated", "logs", "transcript.jsonl");
                  if (existsSync(transcript)) {
                    rawDiscovered.push({
                      path: transcript,
                      agent,
                      alias,
                      sessionId: u,
                    });
                  }
                }
              } else {
                const files = collectJsonlFiles(root);
                for (const f of files) {
                  if (f.includes("/chunks/") || f.includes("\\chunks\\")) continue;
                  if (f.endsWith("transcript_full.jsonl")) continue;
                  const brainMatch = f.match(/brain[/\\]([^/\\]+)/);
                  const sessionId = brainMatch ? brainMatch[1] : basename(f, ".jsonl");
                  rawDiscovered.push({
                    path: f,
                    agent,
                    alias,
                    sessionId,
                  });
                }
              }
            } else if (agent === "grok") {
              const files = collectJsonlFiles(root);
              for (const f of files) {
                if (!f.endsWith("chat_history.jsonl")) continue;
                rawDiscovered.push({
                  path: f,
                  agent,
                  alias,
                  sessionId: basename(dirname(f)),
                });
              }
            } else {
              const files = collectJsonlFiles(root);
              for (const f of files) {
                rawDiscovered.push({
                  path: f,
                  agent,
                  alias,
                  sessionId: basename(f, ".jsonl"),
                });
              }
            }
          } catch {
            // Ignore directory traversal error
          }
        }
      }
    }
  }

  // Deduplicate discovered files by path
  const seenPaths = new Set<string>();
  const results: SyncFileInput[] = [];
  for (const item of rawDiscovered) {
    if (!seenPaths.has(item.path)) {
      seenPaths.add(item.path);
      results.push(item);
    }
  }

  return results;
}

/**
 * Executes full-text contentless search against the SQLite FTS5 index.
 * Fulfills Milestone 6 (Tasks 23–27).
 */
async function runFts5Search(options: SearchOptions): Promise<CliResult> {
  const rawQuery = String(options.text).trim();

  let db: Database;
  let shouldClose = false;
  if (options.db) {
    db = options.db;
  } else {
    db = openSearchDb({ dbPath: options.dbPath });
    initSearchSchema(db);
    shouldClose = true;
  }

  try {
    // Task 26: Synchronization
    let sessionFiles = options.sessionFiles;
    if ((!sessionFiles || sessionFiles.length === 0) && options.sync && !options.noSync) {
      sessionFiles = discoverSessionFiles(options.config);
    }

    if (sessionFiles && sessionFiles.length > 0 && !options.noSync) {
      await syncAllSessions(db, sessionFiles);
    }

    // Task 24: Context window
    let contextN = 0;
    if (options.context !== undefined) {
      contextN = Number(options.context);
    } else if (options.contextN !== undefined) {
      contextN = Number(options.contextN);
    }
    if (isNaN(contextN) || contextN < 0) {
      contextN = 0;
    } else {
      contextN = Math.floor(contextN);
    }

    // Task 23, 25: Query execution
    const searchRes = await querySearch(db, {
      text: rawQuery,
      context: contextN,
      contextN,
      session: options.session,
      agent: options.agent,
      alias: options.alias,
      limit: options.limit ?? 100,
    });

    if (searchRes.hits.length === 0) {
      const emptyOutput = options.format === "json" ? "[]\n" : "No matches found.\n";
      return { exitCode: 0, stdout: emptyOutput, stderr: "" };
    }

    // Task 23, 24, 27: JSON formatting
    if (options.format === "json") {
      const jsonHits = searchRes.hits.map((hit) => {
        const hitSnippet = extractTurnSnippet(hit.hitTurn) || hit.snippet || "";
        const obj: Record<string, any> = {
          id: hit.sessionId,
          sessionId: hit.sessionId,
          shortId: hit.shortId,
          turnIndex: hit.turnIndex,
          agent: hit.agent,
          alias: hit.alias,
          title: hitSnippet,
          snippet: hitSnippet,
          timestamp: hit.timestamp,
          created_at: new Date(hit.timestamp).toISOString(),
          updated_at: new Date(hit.timestamp).toISOString(),
          message_count: 1,
        };

        if (contextN > 0) {
          obj.contextBefore = (hit.context?.before ?? []).map((b) => ({
            turnIndex: b.turnIndex,
            role: b.role,
            text: extractTurnSnippet(b),
            timestamp: b.timestamp,
          }));
          obj.contextAfter = (hit.context?.after ?? []).map((a) => ({
            turnIndex: a.turnIndex,
            role: a.role,
            text: extractTurnSnippet(a),
            timestamp: a.timestamp,
          }));
        }

        return obj;
      });

      return { exitCode: 0, stdout: JSON.stringify(jsonHits, null, 2) + "\n", stderr: "" };
    }

    // Task 27: Color control
    const noColorEnv = process.env.NO_COLOR;
    const isNoColorEnv = noColorEnv !== undefined && noColorEnv !== "" && noColorEnv !== "0";
    const colorEnabled = options.noColor === false && !isNoColorEnv;

    // Task 23, 24, 25, 27: Text formatting
    const lines: string[] = [];

    for (let i = 0; i < searchRes.hits.length; i++) {
      const hit = searchRes.hits[i];
      const hitSnippet = extractTurnSnippet(hit.hitTurn) || hit.snippet || "";
      const hitHighlighted = highlightMatches(hitSnippet, rawQuery, colorEnabled);
      const hitTs = formatTimestamp(hit.timestamp);
      const agentTag = `[${hit.agent}/${hit.alias}]`;
      const shortId = hit.shortId;

      if (contextN > 0) {
        // Context before
        if (hit.context?.before) {
          for (const b of hit.context.before) {
            const bSnippet = extractTurnSnippet(b);
            const bHighlighted = highlightMatches(bSnippet, rawQuery, colorEnabled);
            const bTs = formatTimestamp(b.timestamp);
            lines.push(`│ [context]  ${bTs}  ${agentTag}  ${shortId}  #${b.turnIndex}  ${bHighlighted}`);
          }
        }

        // Hit turn
        lines.push(`▶ [hit]      ${hitTs}  ${agentTag}  ${shortId}  #${hit.turnIndex}  ${hitHighlighted}`);

        // Context after
        if (hit.context?.after) {
          for (const a of hit.context.after) {
            const aSnippet = extractTurnSnippet(a);
            const aHighlighted = highlightMatches(aSnippet, rawQuery, colorEnabled);
            const aTs = formatTimestamp(a.timestamp);
            lines.push(`│ [context]  ${aTs}  ${agentTag}  ${shortId}  #${a.turnIndex}  ${aHighlighted}`);
          }
        }
      } else {
        lines.push(`${hitTs}  ${agentTag}  ${shortId}  #${hit.turnIndex}  ${hitHighlighted}`);
      }
    }

    return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  } finally {
    if (shouldClose) {
      try {
        closeSearchDb(db);
      } catch {
        // Ignore close error
      }
    }
  }
}

/**
 * Formats numeric epoch milliseconds as a clean timestamp: YYYY-MM-DD HH:mm:ss
 */
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const mins = pad(d.getMinutes());
  const secs = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
}

/**
 * Highlights matching query terms in text using ANSI styling when color is enabled.
 * Preserves multi-byte UTF-8 text, emojis, and special punctuation safely.
 */
function highlightMatches(text: string, query: string, enabled: boolean): string {
  if (!enabled || !text || !query) return text;

  const tokens = query
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return text;

  const uniqueTokens = Array.from(new Set(tokens.map((t) => t.toLowerCase())));
  uniqueTokens.sort((a, b) => b.length - a.length);

  const escapedTokens = uniqueTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escapedTokens.join("|")})`, "gi");

  return text.replace(regex, "\x1b[1;33m$1\x1b[0m");
}
