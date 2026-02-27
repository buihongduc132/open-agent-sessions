import { AgentEntry, AgentKind, Config } from "../config/types";
import { SessionDetail } from "../core/types";
import { CliResult } from "./types";

const USAGE =
  "Usage: oas detail --session <agent:alias:session_id|agent:session_id> | oas detail --agent <agent> --alias <alias> --id <session_id>";

export type DetailQuery = {
  agent: AgentKind;
  alias: string;
  id: string;
};

export type DetailService = (query: DetailQuery) => Promise<SessionDetail | null>;

export async function runDetailCommand(options: {
  session?: string;
  agent?: string;
  alias?: string;
  id?: string;
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
  getSession: DetailService;
}): Promise<CliResult> {
  const configResult = resolveConfig(options);
  if (!configResult.ok) {
    return errorResult(configResult.error);
  }

  const enabledEntries = configResult.value.agents.filter((entry) => entry.enabled);
  const targetResult = resolveTarget(options, enabledEntries);
  if (!targetResult.ok) {
    return errorResult(targetResult.error);
  }

  const target = targetResult.value;
  let detail: SessionDetail | null;

  try {
    detail = await options.getSession(target);
  } catch (error) {
    return errorResult(withLabel(target, errorMessage(error)));
  }

  if (!detail) {
    return errorResult(
      withLabel(target, `Session not found: ${target.id}`)
    );
  }

  const stdout = formatDetail(detail, target) + "\n";
  return {
    exitCode: 0,
    stdout,
    stderr: "",
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

function resolveTarget(
  options: {
    session?: string;
    agent?: string;
    alias?: string;
    id?: string;
  },
  entries: AgentEntry[]
): ParseResult<DetailQuery> {
  if (options.session) {
    return parseSessionSpec(options.session, entries);
  }

  const agent = options.agent?.trim();
  const alias = options.alias?.trim();
  const id = options.id?.trim();

  if (!agent || !alias || !id) {
    return { ok: false, error: `Invalid arguments. ${USAGE}` };
  }

  return parseExplicitTarget(agent, alias, id, entries);
}

function parseSessionSpec(spec: string, entries: AgentEntry[]): ParseResult<DetailQuery> {
  const splitResult = splitSpec(spec);
  if (!splitResult.ok) {
    return { ok: false, error: splitResult.error };
  }
  const parts = splitResult.value;
  if (parts.length < 2 || parts.length > 3) {
    return { ok: false, error: `Invalid --session value "${spec}". ${USAGE}` };
  }

  const agent = parts[0].trim() as AgentKind;
  if (!isAgentKind(agent) || !listAgents(entries).includes(agent)) {
    return { ok: false, error: unknownAgentError(agent, entries) };
  }

  if (parts.length === 2) {
    const sessionId = parts[1].trim();
    const aliasResult = inferAlias(agent, entries);
    if (!aliasResult.ok) {
      return { ok: false, error: aliasResult.error };
    }
    return {
      ok: true,
      value: { agent, alias: aliasResult.value, id: sessionId },
    };
  }

  const alias = parts[1].trim();
  const sessionId = parts[2].trim();
  const aliasValidation = validateAlias(agent, alias, entries);
  if (!aliasValidation.ok) {
    return { ok: false, error: aliasValidation.error };
  }

  return { ok: true, value: { agent, alias, id: sessionId } };
}

function parseExplicitTarget(
  agentValue: string,
  aliasValue: string,
  idValue: string,
  entries: AgentEntry[]
): ParseResult<DetailQuery> {
  const agent = agentValue as AgentKind;
  if (!isAgentKind(agent) || !listAgents(entries).includes(agent)) {
    return { ok: false, error: unknownAgentError(agent, entries) };
  }

  const aliasValidation = validateAlias(agent, aliasValue, entries);
  if (!aliasValidation.ok) {
    return { ok: false, error: aliasValidation.error };
  }

  return {
    ok: true,
    value: { agent, alias: aliasValue, id: idValue },
  };
}

function splitSpec(spec: string): ParseResult<string[]> {
  const parts = spec.split(":");
  if (parts.some((part) => part.trim().length === 0)) {
    return { ok: false, error: `Invalid --session value "${spec}". ${USAGE}` };
  }
  return { ok: true, value: parts };
}

function inferAlias(agent: AgentKind, entries: AgentEntry[]): ParseResult<string> {
  const aliases = aliasesForAgent(agent, entries);
  if (aliases.length === 1) {
    return { ok: true, value: aliases[0] };
  }

  return {
    ok: false,
    error: `Alias required for ${agent}. Available aliases: ${formatList(aliases)}`,
  };
}

function validateAlias(
  agent: AgentKind,
  alias: string,
  entries: AgentEntry[]
): ParseResult<string> {
  const aliases = aliasesForAgent(agent, entries);
  if (!aliases.includes(alias)) {
    return {
      ok: false,
      error: `Unknown alias "${alias}" for ${agent}. Available aliases: ${formatList(
        aliases
      )}`,
    };
  }
  return { ok: true, value: alias };
}

function listAgents(entries: AgentEntry[]): AgentKind[] {
  const seen = new Set<AgentKind>();
  for (const entry of entries) {
    seen.add(entry.agent);
  }
  return Array.from(seen).sort(compareAgents);
}

function aliasesForAgent(agent: AgentKind, entries: AgentEntry[]): string[] {
  return entries
    .filter((entry) => entry.agent === agent)
    .map((entry) => entry.alias)
    .sort((a, b) => a.localeCompare(b));
}

function compareAgents(a: AgentKind, b: AgentKind): number {
  const order: Record<AgentKind, number> = {
    opencode: 0,
    codex: 1,
    claude: 2,
  };
  return order[a] - order[b];
}

function unknownAgentError(agent: string, entries: AgentEntry[]): string {
  const available = listAgents(entries);
  return `Unknown agent "${agent}". Available agents: ${formatList(available)}`;
}

function formatList(values: string[]): string {
  if (values.length === 0) {
    return "(none)";
  }
  return values.join(", ");
}

function formatDetail(detail: SessionDetail, target: DetailQuery): string {
  const title = normalizeTitle(detail.title, detail.id);
  const lines = [
    `Session [${target.agent}:${target.alias}]`,
    `agent: ${target.agent}`,
    `alias: ${target.alias}`,
    `id: ${detail.id}`,
    `title: ${title}`,
    `created_at: ${detail.created_at}`,
    `updated_at: ${detail.updated_at}`,
    `message_count: ${String(detail.message_count)}`,
    `storage: ${detail.storage}`,
  ];

  const cloneLines = formatCloneMetadata(detail.clone);
  if (cloneLines.length > 0) {
    lines.push(...cloneLines);
  }

  return lines.join("\n");
}

function formatCloneMetadata(
  clone: SessionDetail["clone"] | undefined
): string[] {
  if (!clone) return [];

  const src = clone.src ?? {};
  const dst = clone.dst ?? {};
  return [
    `src.agent: ${formatValue(src.agent)}`,
    `src.session_id: ${formatValue(src.session_id)}`,
    `src.version: ${formatValue(src.version)}`,
    `dst.agent: ${formatValue(dst.agent)}`,
    `dst.session_id: ${formatValue(dst.session_id)}`,
    `dst.version: ${formatValue(dst.version)}`,
  ];
}

function normalizeTitle(title: string, id: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : id;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "-";
  }
  return String(value);
}

function withLabel(target: DetailQuery, message: string): string {
  const label = `[${target.agent}:${target.alias}]`;
  if (message.includes(label)) {
    return message;
  }
  return `${label} ${message}`;
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
