import { AgentEntry, AgentKind, Config } from "../config/types";
import { CliResult, CloneDestination, CloneRequest, CloneService, CloneSource } from "./types";

const USAGE =
  "Usage: oas clone --from <agent:session_id|agent:alias:session_id> --to <agent:alias>";

export async function runCloneCommand(options: {
  from?: string;
  to?: string;
  config: Config;
  clone: CloneService;
}): Promise<CliResult> {
  if (!options.from || !options.to) {
    return errorResult(`${USAGE}`);
  }

  const enabledEntries = options.config.agents.filter((entry) => entry.enabled);

  const sourceResult = parseCloneSource(options.from, enabledEntries);
  if (!sourceResult.ok) {
    return errorResult(sourceResult.error);
  }

  const destinationResult = parseCloneDestination(options.to, enabledEntries);
  if (!destinationResult.ok) {
    return errorResult(destinationResult.error);
  }

  const source = sourceResult.value;
  const destination = destinationResult.value;

  if (source.agent !== "codex" || destination.agent !== "opencode") {
    return errorResult(
      `Clone direction not supported: ${source.agent} -> ${destination.agent}`
    );
  }

  try {
    const result = await options.clone({ source, destination });
    return {
      exitCode: 0,
      stdout: `${result.destinationId}\n`,
      stderr: "",
    };
  } catch (error) {
    return errorResult(errorMessage(error));
  }
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseCloneSource(spec: string, entries: AgentEntry[]): ParseResult<CloneSource> {
  const parts = splitSpec(spec);
  if (parts.length < 2 || parts.length > 3) {
    return { ok: false, error: `Invalid --from value "${spec}". ${USAGE}` };
  }

  const agent = parts[0] as AgentKind;
  if (!isAgentKind(agent)) {
    return { ok: false, error: unknownAgentError(agent, entries) };
  }

  if (parts.length === 2) {
    const session_id = parts[1];
    const aliasResult = inferAlias(agent, entries);
    if (!aliasResult.ok) {
      return { ok: false, error: aliasResult.error };
    }
    return { ok: true, value: { agent, alias: aliasResult.value, session_id } };
  }

  const alias = parts[1];
  const session_id = parts[2];
  const aliasValidation = validateAlias(agent, alias, entries);
  if (!aliasValidation.ok) {
    return { ok: false, error: aliasValidation.error };
  }

  return { ok: true, value: { agent, alias, session_id } };
}

function parseCloneDestination(
  spec: string,
  entries: AgentEntry[]
): ParseResult<CloneDestination> {
  const parts = splitSpec(spec);
  if (parts.length !== 2) {
    return { ok: false, error: `Invalid --to value "${spec}". ${USAGE}` };
  }

  const agent = parts[0] as AgentKind;
  if (!isAgentKind(agent)) {
    return { ok: false, error: unknownAgentError(agent, entries) };
  }

  const alias = parts[1];
  const aliasValidation = validateAlias(agent, alias, entries);
  if (!aliasValidation.ok) {
    return { ok: false, error: aliasValidation.error };
  }

  return { ok: true, value: { agent, alias } };
}

function splitSpec(spec: string): string[] {
  return spec.split(":").filter((part) => part.length > 0);
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

function aliasesForAgent(agent: AgentKind, entries: AgentEntry[]): string[] {
  return entries.filter((entry) => entry.agent === agent).map((entry) => entry.alias);
}

function unknownAgentError(agent: string, entries: AgentEntry[]): string {
  const available = Array.from(
    new Set(entries.map((entry) => entry.agent))
  ) as AgentKind[];
  return `Unknown agent "${agent}". Available agents: ${formatList(available)}`;
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
