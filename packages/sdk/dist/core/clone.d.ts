import { AgentKind } from "../config/types";
export type CloneRequest = {
    source: {
        agent: AgentKind;
        alias?: string;
        session_id: string;
    };
    destination: {
        agent: AgentKind;
        alias: string;
    };
};
export type CloneResult = {
    destinationId: string;
};
export type CloneMetadata = {
    src: {
        agent: AgentKind;
        session_id: string;
        version: string;
    };
    dst: {
        agent: AgentKind;
        session_id: string;
        version: string;
    };
};
export type CloneMessage = {
    role: string;
    content: string;
    created_at: string;
    attachments?: unknown;
    images?: unknown;
    tool_calls?: unknown;
    [key: string]: unknown;
};
export type CloneSession = {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
    messages: CloneMessage[];
    [key: string]: unknown;
};
export interface CloneSourceAdapter {
    agent: "codex";
    alias: string;
    version: string;
    getSession(session_id: string): Promise<CloneSession | null>;
}
export interface CloneDestinationAdapter {
    agent: "opencode";
    alias: string;
    version: string;
    createSession(input: {
        session: CloneSession;
        metadata: CloneMetadata;
        session_id: string;
    }): Promise<void>;
    hasSession?(session_id: string): Promise<boolean> | boolean;
    generateSessionId?(): string;
    isIdConflictError?(error: unknown): boolean;
}
export interface CloneRegistry {
    getSource(source: CloneRequest["source"]): CloneSourceAdapter | undefined;
    getDestination(destination: CloneRequest["destination"]): CloneDestinationAdapter | undefined;
    listDestinations?(agent: AgentKind): string[];
    listSources?(agent: AgentKind): string[];
}
export interface CloneServiceOptions {
    maxIdAttempts?: number;
    generateId?: () => string;
    isIdConflictError?: (error: unknown) => boolean;
}
export declare function createCloneService(registry: CloneRegistry, options?: CloneServiceOptions): (request: CloneRequest) => Promise<CloneResult>;
export declare function cloneSession(request: CloneRequest, registry: CloneRegistry, options?: CloneServiceOptions): Promise<CloneResult>;
export declare function formatList(values: string[]): string;
