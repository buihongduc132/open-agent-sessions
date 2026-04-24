import { AgentKind } from "../config/types";
import { AdapterRegistry, SessionSummary, SearchQuery } from "./types";
import { errorMessage } from "./utils";

export type SearchError = {
  agent: AgentKind;
  alias: string;
  message: string;
};

export type SearchResult = {
  sessions: SessionSummary[];
  errors: SearchError[];
};

export async function searchSessions(
  registry: AdapterRegistry,
  query: SearchQuery
): Promise<SessionSummary[]> {
  const result = await searchSessionsWithErrors(registry, query);
  return result.sessions;
}

export async function searchSessionsWithErrors(
  registry: AdapterRegistry,
  query: SearchQuery
): Promise<SearchResult> {
  const sessions: SessionSummary[] = [];
  const errors: SearchError[] = [];

  // Filter adapters by agent if requested
  const targetAdapters = query.agent
    ? registry.adapters.filter(a => a.agent === query.agent)
    : registry.adapters;

  const results = await Promise.all(
    targetAdapters.map(async (adapter) => {
      if (!adapter.searchSessions) {
        // Fallback: list and filter if search not supported
        try {
          const all = await adapter.listSessions();
          const needle = query.text.toLowerCase();
          const matched = all.filter(s => 
            s.id.toLowerCase().includes(needle) || 
            s.title.toLowerCase().includes(needle)
          );
          return { adapter, sessions: matched };
        } catch (error) {
          return { adapter, error };
        }
      }

      try {
        const matched = await adapter.searchSessions(query);
        return { adapter, sessions: matched };
      } catch (error) {
        return { adapter, error };
      }
    })
  );

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

  // Final sort by updated_at desc
  return {
    sessions: sessions.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    errors,
  };
}
