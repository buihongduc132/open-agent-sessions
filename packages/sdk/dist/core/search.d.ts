import { AgentKind } from "../config/types";
import { AdapterRegistry, SessionSummary, SearchQuery } from "./types";
export type SearchError = {
    agent: AgentKind;
    alias: string;
    message: string;
};
export type SearchResult = {
    sessions: SessionSummary[];
    errors: SearchError[];
};
export declare function searchSessions(registry: AdapterRegistry, query: SearchQuery): Promise<SessionSummary[]>;
export declare function searchSessionsWithErrors(registry: AdapterRegistry, query: SearchQuery): Promise<SearchResult>;
