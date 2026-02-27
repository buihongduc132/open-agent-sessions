import { AgentEntry, AgentKind, Config } from "../config/types";
import { SessionListQuery, SessionListResult } from "../core/list";
import { SessionSummary } from "../core/types";
import { CliResult } from "./types";

const USAGE = "Usage: oas list [--agent <agent>] [--alias <alias>] [--q <query>]";

export type ListService = (query: SessionListQuery) => Promise<SessionListResult>;

export async function runListCommand(options: {
  agent?: string;
  alias?: string;
  q?: string;
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
  list: ListService;
}): Promise<CliResult> {
  const configResult = resolveConfig(options);
  if (!configResult.ok) {
    return errorResult(configResult.error);
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
  };

  let result: SessionListResult;
  try {
    result = await options.list(query);
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

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

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
  const title = session.title.trim().length > 0 ? session.title : session.id;
  if (title === session.id) {
    return `${label} ${session.id}`;
  }
  return `${label} ${title} (${session.id})`;
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
