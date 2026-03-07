import { AgentEntry, AgentKind, Config } from "../config/types";
import { SessionSummary, SearchQuery } from "../core/types";
import { CliResult } from "./types";

const USAGE = `Usage: oas search --text <query>

Options:
  --text QUERY    Search text (required)

Searches session titles and message content.`;

// ============================================================================
// Types
// ============================================================================

export type SearchService = (query: SearchQuery) => Promise<SearchResult>;

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
  searchSessions: SearchService;
};

// ============================================================================
// Main Command
// ============================================================================

export async function runSearchCommand(options: SearchOptions): Promise<CliResult> {
  // Validate --text argument
  if (!options.text || String(options.text).trim().length === 0) {
    return errorResult(`Missing required argument: --text. ${USAGE}`);
  }

  // Resolve config
  const configResult = resolveConfig(options);
  if (!configResult.ok) {
    return errorResult(configResult.error);
  }

  // Build query
  const query: SearchQuery = {
    cwd: process.cwd(),
    text: String(options.text).trim(),
  };

  // Search sessions
  let result: SearchResult;
  try {
    result = await options.searchSessions(query);
  } catch (error) {
    return errorResult(errorMessage(error));
  }

  const stderr = formatErrors(result.errors);
  if (result.sessions.length === 0) {
    return {
      exitCode: 0,
      stdout: "No sessions found.\n",
      stderr,
    };
  }

  const stdout = result.sessions.map(formatSessionRow).join("\n") + "\n";
  return {
    exitCode: 0,
    stdout,
    stderr,
  };
}

// ============================================================================
// Config Resolution
// ============================================================================

type ConfigResult = { ok: true; value: Config } | { ok: false; error: string };

function resolveConfig(options: {
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
}): ConfigResult {
  if (options.config) {
    return { ok: true, value: options.config };
  }

  if (options.configPath && options.loadConfig) {
    try {
      return { ok: true, value: options.loadConfig(options.configPath) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  return { ok: false, error: `Missing config. ${USAGE}` };
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatSessionRow(session: SessionSummary): string {
  const label = `[${session.agent}:${session.alias}]`;
  const title = session.title.trim().length > 0 ? session.title : session.id;
  if (title === session.id) {
    return `${label} ${session.id}`;
  }
  return `${label} ${title} (${session.id})`;
}

function formatErrors(errors: SearchError[]): string {
  if (errors.length === 0) {
    return "";
  }
  return (
    errors
      .map((error) => {
        const label = `[${error.agent}:${error.alias}]`;
        const message = error.message;
        if (message.includes(label)) {
          return message;
        }
        return `${label} ${message}`;
      })
      .join("\n") + "\n"
  );
}

// ============================================================================
// Helpers
// ============================================================================

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

function errorResult(message: string): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${message}\n`,
  };
}
