/**
 * src/sdk/workspace.ts
 *
 * Workspace-scoped session factory.
 *
 * Creates or retrieves a WorkspaceSession for a given agent:scope:name triple.
 * Scope defaults to the nearest git-root discovered by walking up from cwd.
 * Canonical alias = `agent:scope` or `agent:scope:name`.
 *
 * Design:
 *   - Singleton cache keyed by canonical alias (agent:scope:name).
 *   - Lazy adapter creation: if the adapter for this agent+scope is not in the
 *     registry, it is instantiated and registered on first use.
 *   - All normalization goes through src/core/normalize.ts.
 */
import { AgentKind } from "../config/types";
import { Adapter, AdapterFactories, AdapterRegistry } from "../core/types";
export interface WorkspaceConfig {
    /** Agent kind, e.g. "opencode", "codex", "claude" */
    agent: AgentKind;
    /**
     * Workspace scope: absolute path or omit to auto-detect the nearest git-root
     * from process.cwd().
     */
    scope?: string;
    /** Optional named session within the workspace scope */
    name?: string;
    /**
     * Optional storage config overrides passed through to the adapter.
     * For opencode agents this maps to OpenCodeStorageConfig.
     */
    storage?: {
        mode?: "auto" | "db" | "jsonl";
        db_path?: string;
        jsonl_path?: string;
    };
    /** @internal Test-only: override existsSync for findGitRoot */
    _existsSyncFn?: (path: string | URL | Buffer) => boolean;
}
export interface WorkspaceSession {
    /** The adapter registry (may contain adapters for multiple agents) */
    registry: AdapterRegistry;
    /** Canonical session reference */
    sessionRef: SessionRef;
    /** The active adapter for the requested agent */
    adapter: Adapter;
    /**
     * Resolved scope: the git-root if scope was omitted, otherwise the
     * user-provided absolute path.
     */
    scope: string;
}
/** Canonical session key = (agent, alias, sessionId) */
export interface SessionRef {
    agent: AgentKind;
    /** Canonical alias: `agent:scope` or `agent:scope:name` */
    alias: string;
    /** Unique session identifier for this (agent, scope, name) triple */
    sessionId: string;
}
/** WorkspaceSession cache keyed by canonical alias (agent:scope:name) */
export declare const sessionCache: Map<string, WorkspaceSession>;
/**
 * Adapter instance cache keyed by canonical alias (agent:scope).
 * Used to avoid re-instantiating the same adapter for different named sessions
 * within the same workspace scope.
 */
export declare const adapterCache: Map<string, Adapter>;
/** AdapterRegistry shared across all workspace sessions (mutable) */
export declare let sharedRegistry: AdapterRegistry;
/** Adapter factories — must be provided at module init or first use */
export declare let factories: Partial<AdapterFactories>;
/**
 * Set the adapter factories (typically called once at application startup).
 * Must be called before createWorkspaceSession if you need real adapters;
 * otherwise a stub adapter is used.
 */
export declare function setWorkspaceFactories(f: Partial<AdapterFactories>): void;
/**
 * Create or retrieve a WorkspaceSession for the given config.
 *
 * - If config.scope is omitted, the nearest git-root is discovered by walking
 *   up from process.cwd().
 * - If a session for this (agent, scope, name) already exists, it is returned
 *   unchanged (idempotent).
 * - The adapter for the given agent is created and registered if not present.
 *
 * @param config - WorkspaceConfig with agent (required) and optional scope/name
 * @returns WorkspaceSession
 */
export declare function createWorkspaceSession(config: WorkspaceConfig): WorkspaceSession;
/**
 * Resolve the workspace scope.
 * - If an absolute path is given, use it directly.
 * - If omitted, discover the nearest git-root from process.cwd().
 * - Falls back to process.cwd() if no git root is found.
 */
export declare function resolveScope(given?: string, existsSyncFn?: (path: string | URL | Buffer) => boolean): string;
/**
 * Walk upward from `startDir` looking for a `.git` directory.
 * Returns the path of the containing directory of `.git`, or null if not found.
 *
 * @param startDir - Directory to start searching from
 * @param existsSyncFn - Optional override of fs.existsSync for testing.
 *                      Defaults to the real node:fs.existsSync.
 */
export declare function findGitRoot(startDir: string, existsSyncFn?: (path: string | URL | Buffer) => boolean): string | null;
/**
 * Build the canonical alias string: `agent:scope` or `agent:scope:name`.
 * The scope is used as-is (absolute path); no hashing is applied.
 */
export declare function buildCanonicalAlias(agent: AgentKind, scope: string, name?: string): string;
