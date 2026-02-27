import {
  AgentEntry,
  AgentKind,
  Config,
  OpenCodeStorageConfig,
  OpenCodeStorageMode,
} from "./types";

const ALLOWED_AGENTS: AgentKind[] = ["opencode", "codex", "claude"];
const STORAGE_MODES: OpenCodeStorageMode[] = ["auto", "db", "jsonl"];
const AGENT_ORDER: Record<AgentKind, number> = {
  opencode: 0,
  codex: 1,
  claude: 2,
};

export function validateConfig(raw: unknown): Config {
  if (raw === null || raw === undefined) {
    return { agents: [] };
  }

  if (!isPlainObject(raw)) {
    throw new Error(
      `Config validation error: top-level must be a mapping, got ${typeName(raw)}`
    );
  }

  const agentsRaw = (raw as Record<string, unknown>).agents;
  if (agentsRaw === undefined) {
    return { agents: [] };
  }

  if (!Array.isArray(agentsRaw)) {
    throw new Error(
      `Config validation error: "agents" must be a list, got ${typeName(agentsRaw)}`
    );
  }

  const entries: AgentEntry[] = [];
  const seenAliases = new Map<string, number>();

  for (let index = 0; index < agentsRaw.length; index += 1) {
    const entry = validateAgentEntry(agentsRaw[index], index);

    if (seenAliases.has(entry.alias)) {
      const firstIndex = seenAliases.get(entry.alias);
      const context = entryContext(index, entry.agent, entry.alias);
      throw new Error(
        `${context}: duplicate alias "${entry.alias}" (first seen at agents[${firstIndex}])`
      );
    }
    seenAliases.set(entry.alias, index);

    entries.push(entry);
  }

  const sorted = entries.slice().sort((a, b) => {
    const agentDelta = AGENT_ORDER[a.agent] - AGENT_ORDER[b.agent];
    if (agentDelta !== 0) return agentDelta;
    return a.alias.localeCompare(b.alias);
  });

  return { agents: sorted };
}

function validateAgentEntry(raw: unknown, index: number): AgentEntry {
  if (!isPlainObject(raw)) {
    const context = entryContext(index);
    throw new Error(
      `${context}: agent entry must be a mapping, got ${typeName(raw)}`
    );
  }

  const record = raw as Record<string, unknown>;
  const rawAgent = record.agent;
  const rawAlias = record.alias;
  const context = entryContext(index, rawAgent, rawAlias);

  if (typeof rawAgent !== "string" || !ALLOWED_AGENTS.includes(rawAgent as AgentKind)) {
    throw new Error(
      `${context}: agent must be one of ${ALLOWED_AGENTS.join(", ")}, got ${stringifyValue(
        rawAgent
      )}`
    );
  }
  const agent = rawAgent as AgentKind;

  if (typeof rawAlias !== "string") {
    throw new Error(`${context}: alias must be a non-empty string`);
  }
  if (rawAlias.trim() !== rawAlias || rawAlias.length === 0) {
    throw new Error(
      `${context}: alias must be non-empty with no leading/trailing whitespace`
    );
  }
  const alias = rawAlias;

  let enabled = true;
  if (Object.prototype.hasOwnProperty.call(record, "enabled")) {
    if (typeof record.enabled !== "boolean") {
      throw new Error(
        `${context}: enabled must be a boolean, got ${typeName(record.enabled)}`
      );
    }
    enabled = record.enabled as boolean;
  }

  const normalized: Record<string, unknown> = { ...record, agent, alias, enabled };

  if (agent === "opencode") {
    normalized.storage = validateOpenCodeStorage(record.storage, context);
  }

  return normalized as AgentEntry;
}

function validateOpenCodeStorage(
  raw: unknown,
  context: string
): OpenCodeStorageConfig {
  if (raw === undefined) {
    return { mode: "auto" };
  }

  if (!isPlainObject(raw)) {
    throw new Error(`${context}: storage must be a mapping`);
  }

  const record = raw as Record<string, unknown>;
  const modeRaw = record.mode ?? "auto";
  if (typeof modeRaw !== "string" || !STORAGE_MODES.includes(modeRaw as OpenCodeStorageMode)) {
    throw new Error(
      `${context}: storage.mode must be one of ${STORAGE_MODES.join(", ")}, got ${stringifyValue(
        modeRaw
      )}`
    );
  }

  const dbPath = record.db_path;
  if (dbPath !== undefined) {
    if (typeof dbPath !== "string" || dbPath.trim().length === 0) {
      throw new Error(`${context}: storage.db_path must be a non-empty string`);
    }
  }

  const jsonlPath = record.jsonl_path;
  if (jsonlPath !== undefined) {
    if (typeof jsonlPath !== "string" || jsonlPath.trim().length === 0) {
      throw new Error(`${context}: storage.jsonl_path must be a non-empty string`);
    }
  }

  return {
    mode: modeRaw as OpenCodeStorageMode,
    db_path: dbPath as string | undefined,
    jsonl_path: jsonlPath as string | undefined,
  };
}

function entryContext(index: number, agent?: unknown, alias?: unknown): string {
  let context = `agents[${index}]`;
  const agentPart = typeof agent === "string" ? agent : undefined;
  const aliasPart = typeof alias === "string" ? alias : undefined;
  if (agentPart || aliasPart) {
    const labelParts = [agentPart, aliasPart].filter(Boolean) as string[];
    context += ` (${labelParts.join(":")})`;
  }
  return context;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  return String(value);
}
