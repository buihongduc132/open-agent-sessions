import { AgentEntry, AgentKind, Config } from "../config/types";
import { SessionDetail } from "../core/types";
import { CliResult } from "./types";
import { resolveConfig, errorResult, errorMessage, type ParseResult } from "./utils/config";
import {
  isAgentKind,
  formatList,
  listAgents,
  aliasesForAgent,
  compareAgents,
  unknownAgentError,
  withLabel,
  normalizeTitle,
} from "./utils/agents";

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
  const configResult = resolveConfig(options, USAGE);
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

// Config/target resolution: imported from ./utils/config and ./utils/agents

// ParseResult: imported from ./utils/config

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

  // Support three formats:
  // 1. session_id (1 part) - infer agent/alias from config
  // 2. agent:session_id (2 parts) - infer alias from config
  // 3. agent:alias:session_id (3 parts) - full format

  if (parts.length === 1) {
    // Format: session_id - use first enabled agent/alias
    if (entries.length === 0) {
      return { ok: false, error: `No enabled agents in config. ${USAGE}` };
    }
    const entry = entries[0];
    return { ok: true, value: { agent: entry.agent, alias: entry.alias, id: parts[0].trim() } };
  }

  if (parts.length === 2) {
    // Check if first part is an agent name or an alias
    const first = parts[0].trim();
    if (isAgentKind(first)) {
      if (listAgents(entries).includes(first)) {
        // Format: agent:session_id
        const agent = first as AgentKind;
        const sessionId = parts[1].trim();
        const aliasResult = inferAlias(agent, entries);
        if (!aliasResult.ok) {
          return { ok: false, error: aliasResult.error };
        }
        return { ok: true, value: { agent, alias: aliasResult.value, id: sessionId } };
      }
      // Valid agent type syntax but agent not in config
      return { ok: false, error: unknownAgentError(first, entries) };
    }
    // Format: alias:session_id
    const alias = first;
    const sessionId = parts[1].trim();
    const matchingEntry = entries.find((e) => e.alias === alias);
    if (!matchingEntry) {
      const availableAliases = [...new Set(entries.map((e) => e.alias))].sort();
      return {
        ok: false,
        error: `Unknown alias "${alias}". Available aliases: ${formatList(availableAliases)}`,
      };
    }
    return { ok: true, value: { agent: matchingEntry.agent, alias, id: sessionId } };
  }

  if (parts.length === 3) {
    // Format: agent:alias:session_id - full format
    const agent = parts[0].trim() as AgentKind;
    if (!isAgentKind(agent) || !listAgents(entries).includes(agent)) {
      return { ok: false, error: unknownAgentError(agent, entries) };
    }
    const alias = parts[1].trim();
    const sessionId = parts[2].trim();
    const aliasValidation = validateAlias(agent, alias, entries);
    if (!aliasValidation.ok) {
      return { ok: false, error: aliasValidation.error };
    }
    return { ok: true, value: { agent, alias, id: sessionId } };
  }

  return { ok: false, error: `Invalid --session value "${spec}". ${USAGE}` };
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

// Helpers: imported from ./utils/config and ./utils/agents

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

// Title/label/agent helpers: imported from ./utils/agents

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
