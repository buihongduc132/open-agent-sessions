import { AgentEntry, AgentKind, Config } from "../config/types";
import { normalizeSessionSummary } from "./normalize";
import {
  Adapter,
  AdapterFactories,
  AdapterHandle,
  AdapterRegistry,
} from "./types";

const AGENT_ORDER: Record<AgentKind, number> = {
  opencode: 0,
  codex: 1,
  claude: 2,
};

export function createAdapterRegistry(
  config: Config,
  factories: Partial<AdapterFactories>
): AdapterRegistry {
  const entries = config.agents ?? [];
  ensureUniqueAliases(entries);

  const enabledEntries = entries.filter((entry) => entry.enabled);
  const sorted = enabledEntries.slice().sort(compareEntries);
  const adapters = sorted.map((entry) =>
    buildHandle(entry, factories, entries.indexOf(entry))
  );

  return { adapters };
}

function ensureUniqueAliases(entries: AgentEntry[]): void {
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.alias)) {
      const firstIndex = seen.get(entry.alias);
      const context = formatAdapterLabel(entry);
      throw new Error(
        `${context} duplicate alias "${entry.alias}" (first seen at agents[${firstIndex}])`
      );
    }
    seen.set(entry.alias, index);
  });
}

function compareEntries(a: AgentEntry, b: AgentEntry): number {
  const agentDelta = AGENT_ORDER[a.agent] - AGENT_ORDER[b.agent];
  if (agentDelta !== 0) return agentDelta;
  return a.alias.localeCompare(b.alias);
}

function buildHandle(
  entry: AgentEntry,
  factories: Partial<AdapterFactories>,
  index?: number
): AdapterHandle {
  const context = formatAdapterLabel(entry);
  const validationContext = formatValidationContext(entry, index);
  const factory = factories[entry.agent];
  if (!factory) {
    throw new Error(`${context} adapter factory not found for agent "${entry.agent}"`);
  }

  let adapter: Adapter;
  try {
    adapter = factory(entry);
  } catch (error) {
    throw new Error(`${context} ${errorMessage(error)}`);
  }

  return {
    agent: entry.agent,
    alias: entry.alias,
    version: adapter.version,
    listSessions: async () => {
      let sessions: Awaited<ReturnType<Adapter["listSessions"]>>;
      try {
        sessions = await adapter.listSessions();
      } catch (error) {
        throw new Error(`${context} ${errorMessage(error)}`);
      }

      if (!Array.isArray(sessions)) {
        throw new Error(`${validationContext} adapter returned non-list sessions`);
      }

      return sessions.map((session, sessionIndex) => {
        const normalized = normalizeSessionSummary(
          session,
          `${validationContext} session[${sessionIndex}]`
        );
        if (normalized.agent !== entry.agent) {
          throw new Error(
            `${validationContext} session[${sessionIndex}] agent must be "${entry.agent}"`
          );
        }
        if (normalized.alias !== entry.alias) {
          throw new Error(
            `${validationContext} session[${sessionIndex}] alias must be "${entry.alias}"`
          );
        }
        return normalized;
      });
    },
  };
}

function formatAdapterLabel(entry: AgentEntry): string {
  return `[${entry.agent}:${entry.alias}]`;
}

function formatValidationContext(entry: AgentEntry, index?: number): string {
  const prefix = typeof index === "number" ? `agents[${index}]` : "agent";
  return `${prefix} (${entry.agent}:${entry.alias})`;
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
