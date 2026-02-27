import { AgentKind } from "../config/types";
import { AdapterRegistry, SessionSummary } from "./types";

const AGENT_ORDER: Record<AgentKind, number> = {
  opencode: 0,
  codex: 1,
  claude: 2,
};

export type SessionListQuery = {
  agent?: AgentKind;
  alias?: string;
  q?: string;
};

export type SessionListError = {
  agent: AgentKind;
  alias: string;
  message: string;
};

export type SessionListResult = {
  sessions: SessionSummary[];
  errors: SessionListError[];
};

export function createListService(
  registry: AdapterRegistry
): (query?: SessionListQuery) => Promise<SessionListResult> {
  return (query) => listSessions(registry, query);
}

export async function listSessions(
  registry: AdapterRegistry,
  query: SessionListQuery = {}
): Promise<SessionListResult> {
  const { sessions, errors } = await collectSessions(registry);
  const filtered = applyFilters(sessions, query);
  const ordered = filtered.slice().sort(compareSessions);
  return { sessions: ordered, errors };
}

function applyFilters(
  sessions: SessionSummary[],
  query: SessionListQuery
): SessionSummary[] {
  const agent = query.agent;
  const alias = query.alias;
  const normalizedQuery = query.q?.trim().toLowerCase();
  const hasQuery = Boolean(normalizedQuery);

  return sessions.filter((session) => {
    if (agent && session.agent !== agent) return false;
    if (alias && session.alias !== alias) return false;
    if (!hasQuery) return true;
    const needle = normalizedQuery as string;
    return (
      session.id.toLowerCase().includes(needle) ||
      session.title.toLowerCase().includes(needle)
    );
  });
}

function compareSessions(a: SessionSummary, b: SessionSummary): number {
  const timeA = Date.parse(a.updated_at);
  const timeB = Date.parse(b.updated_at);
  if (timeA !== timeB) {
    return timeB - timeA;
  }

  const agentDelta = AGENT_ORDER[a.agent] - AGENT_ORDER[b.agent];
  if (agentDelta !== 0) return agentDelta;

  return a.id.localeCompare(b.id);
}

async function collectSessions(
  registry: AdapterRegistry
): Promise<{ sessions: SessionSummary[]; errors: SessionListError[] }> {
  const results = await Promise.all(
    registry.adapters.map(async (adapter) => {
      try {
        const sessions = await adapter.listSessions();
        return { adapter, sessions };
      } catch (error) {
        return { adapter, error };
      }
    })
  );

  const sessions: SessionSummary[] = [];
  const errors: SessionListError[] = [];

  for (const result of results) {
    if ("error" in result) {
      errors.push({
        agent: result.adapter.agent,
        alias: result.adapter.alias,
        message: errorMessage(result.error),
      });
      continue;
    }
    sessions.push(...result.sessions);
  }

  return { sessions, errors };
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
