import { AgentEntry, AgentKind, Config } from "../config/types";
import { CliResult, CloneDestination, CloneRequest, CloneService, CloneSource } from "./types";
import { errorResult, errorMessage } from "./utils/config";
import {
  isAgentKind,
  formatList,
  validateAlias,
  aliasesForAgent,
  unknownAgentError,
  inferAlias,
  splitSpec,
} from "./utils/agents";

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

import type { ParseResult } from "./utils/config";

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

// Helpers: imported from ./utils/config and ./utils/agents
