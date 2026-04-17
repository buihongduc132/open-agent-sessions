import { AgentEntry, AgentKind } from "../config/types";
import { SessionListQuery, SessionListResult } from "../core/list";
import { SessionSummary } from "../core/types";
import { CliResult } from "./types";
import { type ConfigOptions, type ParseResult, resolveConfig, errorResult, errorMessage } from "./utils/config";

const USAGE = "Usage: oas list [--agent <agent>] [--alias <alias>] [--q <query>] [--limit <n>] [--after <cursor>]";

export type ListService = (query: SessionListQuery) => Promise<SessionListResult>;

export type ListOptions = {
  agent?: string;
  alias?: string;
  q?: string;
  limit?: number;
  after?: string;
  /** Filter to only root sessions (sessions with no parent). */
  rootsOnly?: boolean;
  /** Filter to only sub-agent sessions (sessions with a parent). */
  subOnly?: boolean;
  /** Filter to only sessions that are direct children of this parent session ID. */
  childrenOf?: string;
  list: ListService;
} & ConfigOptions;

export async function runListCommand(options: ListOptions): Promise<CliResult> {
  const configResult = resolveConfig(options, USAGE);
  if (!configResult.ok) {
    return errorResult(configResult.error);
  }

  // Validate mutually exclusive flags
  if (options.rootsOnly && options.childrenOf !== undefined) {
    return errorResult("Cannot use --roots-only and --children-of together: they are mutually exclusive.");
  }

  if (options.rootsOnly && options.subOnly) {
    return errorResult("Cannot use --roots-only and --sub-only together: they are mutually exclusive.");
  }

  const enabledEntries = configResult.value.agents.filter((entry) => entry.enabled);
  const agentResult = parseAgent(options.agent, enabledEntries);
  if (!agentResult.ok) {
    return errorResult(agentResult.error);
  }

  const aliasResult = parseAlias(options.alias, enabledEntries);
  if (!aliasResult.ok) {
    return errorResult(aliasResult.error);
  }

  const query: SessionListQuery = {
    agent: agentResult.value,
    alias: aliasResult.value,
    q: normalizeQuery(options.q),
    limit: options.limit,
    after: options.after,
  };

  let result: SessionListResult;
  try {
    result = await options.list(query);
  } catch (error) {
    return errorResult(errorMessage(error));
  }

  // Apply rootsOnly filter: only sessions with no parentSessionId
  let sessions = result.sessions;
  if (options.rootsOnly) {
    sessions = sessions.filter((s) => !s.parentSessionId);
  }

  // Apply childrenOf filter: only sessions whose parent is the specified ID
  if (options.childrenOf !== undefined) {
    sessions = sessions.filter((s) => s.parentSessionId === options.childrenOf);
  }

  // Apply subOnly filter: only sessions with a parentSessionId
  if (options.subOnly) {
    sessions = sessions.filter((s) => !!s.parentSessionId);
  }

  const stderr = formatErrors(result.errors);
  if (sessions.length === 0) {
    return {
      exitCode: 0,
      stdout: "No sessions found.\n",
      stderr,
    };
  }

  const stdout = sessions.map(formatSessionRow).join("\n") + "\n";
  return {
    exitCode: 0,
    stdout,
    stderr,
  };
}

function parseAgent(
  agentValue: string | undefined,
  entries: AgentEntry[]
): ParseResult<AgentKind | undefined> {
  const trimmed = agentValue?.trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }

  const available = listAgents(entries);
  const agent = trimmed as AgentKind;
  if (!isAgentKind(agent) || !available.includes(agent)) {
    return {
      ok: false,
      error: `Unknown agent "${trimmed}". Available agents: ${formatList(available)}`,
    };
  }

  return { ok: true, value: agent };
}

function parseAlias(
  aliasValue: string | undefined,
  entries: AgentEntry[]
): ParseResult<string | undefined> {
  const trimmed = aliasValue?.trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }

  const available = listAliases(entries);
  if (!available.includes(trimmed)) {
    return {
      ok: false,
      error: `Unknown alias "${trimmed}". Available aliases: ${formatList(available)}`,
    };
  }

  return { ok: true, value: trimmed };
}

function listAgents(entries: AgentEntry[]): AgentKind[] {
  const seen = new Set<AgentKind>();
  for (const entry of entries) {
    seen.add(entry.agent);
  }
  return Array.from(seen).sort(compareAgents);
}

function listAliases(entries: AgentEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    seen.add(entry.alias);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

function compareAgents(a: AgentKind, b: AgentKind): number {
  const order: Record<AgentKind, number> = {
    opencode: 0,
    codex: 1,
    claude: 2,
  };
  return order[a] - order[b];
}

function normalizeQuery(query: string | undefined): string | undefined {
  if (query === undefined) {
    return undefined;
  }
  const trimmed = query.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function formatSessionRow(session: SessionSummary): string {
  const label = `[${session.agent}:${session.alias}]`;
  const roleTag = session.parentSessionId ? "[sub]" : "[main]";
  const title = session.title.trim().length > 0 ? session.title : session.id;
  if (title === session.id) {
    return `${label} ${roleTag} ${session.id}`;
  }
  return `${label} ${roleTag} ${title} (${session.id})`;
}

function formatErrors(errors: SessionListResult["errors"]): string {
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

function formatList(values: string[]): string {
  if (values.length === 0) {
    return "(none)";
  }
  return values.join(", ");
}

function isAgentKind(agent: string): agent is AgentKind {
  return agent === "opencode" || agent === "codex" || agent === "claude";
}
