/**
 * SDK: Session fork API (R-39)
 *
 * Provides `forkSession(registry, source, dest)` which:
 *  1. Reads the source session via the registry's source adapter.
 *  2. Delegates to the destination adapter's `forkSession()` to create a new session.
 *  3. Returns a `ForkResult` linking the new session to its parent.
 *
 * ## Deferred (R-18)
 * The write path to native agent storage (creating a real session in
 * OpenCode/Codex/etc.) is not yet implemented. The fork result is prepared
 * in CSF format (R-16) and returned, but not persisted to agent-native storage.
 *
 * @file src/sdk/session.ts
 */
import type { AdapterRegistry, ForkResult, SessionRef } from "../core/types";
export type { ForkResult, SessionRef };
/** Thrown when no adapter is registered for the given agent. */
export declare class AgentNotFoundError extends Error {
    constructor(agent: string);
}
/** Thrown when no adapter is registered for the given agent + alias combo. */
export declare class AliasNotFoundError extends Error {
    constructor(agent: string, alias: string);
}
/** Thrown when the destination adapter does not implement forkSession. */
export declare class ForkNotSupportedError extends Error {
    constructor(agent: string, alias: string);
}
/**
 * Fork a session from a source agent/alias to a destination agent/alias.
 *
 * ## Algorithm
 *  1. Locate the source adapter via `registry.adapters` by `(source.agent, source.alias)`.
 *  2. Locate the destination adapter via `registry.adapters` by `(dest.agent, dest.alias)`.
 *  3. Read the source session detail via `sourceAdapter.getSessionDetail()` (if available).
 *     - This populates `SessionDetail.parentSessionId` with `source.sessionId`.
 *  4. Call `destAdapter.forkSession(source.sessionId, dest.agent, dest.alias)`.
 *  5. Return the `ForkResult`.
 *
 * ## Deferred write (R-18)
 * The actual write to native agent storage is not yet done here.
 * The `destAdapter.forkSession()` call creates the stub ForkResult;
 * real persistence (importing CSF into OpenCode/Codex) is handled by R-18.
 *
 * @param registry  The AdapterRegistry containing all registered adapters.
 * @param source    SessionRef pointing to the source session.
 * @param dest      SessionRef pointing to the destination (fork target) adapter.
 * @returns ForkResult linking the new session to its parent.
 * @throws AgentNotFoundError   If no adapter is registered for `source.agent`.
 * @throws AliasNotFoundError   If no adapter is registered for `source.alias` or `dest.alias`.
 * @throws ForkNotSupportedError If the destination adapter does not implement `forkSession`.
 */
export declare function forkSession(registry: AdapterRegistry, source: SessionRef, dest: SessionRef): Promise<ForkResult>;
