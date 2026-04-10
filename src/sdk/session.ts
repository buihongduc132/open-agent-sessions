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

import type {
  AdapterRegistry,
  ForkResult,
  SessionDetail,
  SessionRef,
} from "../core/types";

// Re-export types for consumers
export type { ForkResult, SessionRef };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when no adapter is registered for the given agent. */
export class AgentNotFoundError extends Error {
  constructor(agent: string) {
    super(`No adapter registered for agent: ${agent}`);
    this.name = "AgentNotFoundError";
  }
}

/** Thrown when no adapter is registered for the given agent + alias combo. */
export class AliasNotFoundError extends Error {
  constructor(agent: string, alias: string) {
    super(`No adapter registered for ${agent}:${alias}`);
    this.name = "AliasNotFoundError";
  }
}

/** Thrown when the destination adapter does not implement forkSession. */
export class ForkNotSupportedError extends Error {
  constructor(agent: string, alias: string) {
    super(
      `Adapter ${agent}:${alias} does not implement forkSession — ` +
        `native write to agent storage is deferred until R-18`
    );
    this.name = "ForkNotSupportedError";
  }
}

// ---------------------------------------------------------------------------
// forkSession — SDK entry point
// ---------------------------------------------------------------------------

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
export async function forkSession(
  registry: AdapterRegistry,
  source: SessionRef,
  dest: SessionRef
): Promise<ForkResult> {
  // --- Locate source adapter ---
  const sourceHandle = findHandle(registry.adapters, source.agent, source.alias);
  if (!sourceHandle) {
    if (!hasAgent(registry.adapters, source.agent)) {
      throw new AgentNotFoundError(source.agent);
    }
    throw new AliasNotFoundError(source.agent, source.alias);
  }

  // --- Locate destination adapter ---
  const destHandle = findHandle(registry.adapters, dest.agent, dest.alias);
  if (!destHandle) {
    if (!hasAgent(registry.adapters, dest.agent)) {
      throw new AgentNotFoundError(dest.agent);
    }
    throw new AliasNotFoundError(dest.agent, dest.alias);
  }

  // --- Read source session detail (optional but recommended) ---
  //#given source session exists in registry
  //#when getSessionDetail is available on the source adapter
  //#then enrich ForkResult with session metadata (deferred)
  let sourceDetail: SessionDetail | undefined;
  if (sourceHandle.getSessionDetail) {
    try {
      //#given read options — default to full session with all messages
      sourceDetail = await sourceHandle.getSessionDetail(source.sessionId, {
        mode: "all_with_tools",
      });
    } catch (err) {
      // Non-fatal: we can still fork without the detail.
      //#given source session may not exist or be unreadable
      //#when getSessionDetail throws
      //#then fall through to adapter-level fork without enrichment
      sourceDetail = undefined;
    }
  }

  // --- Verify destination adapter supports forkSession ---
  if (!destHandle.forkSession) {
    throw new ForkNotSupportedError(dest.agent, dest.alias);
  }

  // --- Delegate to destination adapter ---
  //#given dest adapter implements forkSession
  //#when forkSession is called
  //#then adapter creates new session and returns ForkResult
  const forkResult = await destHandle.forkSession(
    source.sessionId,
    dest.agent,
    dest.alias
  );

  // Validate the adapter returned a sane ForkResult
  if (!forkResult || typeof forkResult.newSessionId !== "string") {
    throw new Error(
      `${dest.agent}:${dest.alias} forkSession() returned invalid result: ` +
        `expected ForkResult with newSessionId string`
    );
  }

  return forkResult;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AdapterHandleWithFork = {
  agent: string;
  alias: string;
  version: string;
  listSessions: () => Promise<unknown[]>;
  getSessionDetail?: (sessionId: string, options?: unknown) => Promise<SessionDetail>;
  forkSession?: (
    sourceSessionId: string,
    destAgent: string,
    destAlias: string
  ) => Promise<ForkResult>;
};

/**
 * Find the adapter handle for a specific (agent, alias) pair.
 * Returns `undefined` if not found.
 */
function findHandle(
  adapters: AdapterRegistry["adapters"],
  agent: string,
  alias: string
): AdapterHandleWithFork | undefined {
  return adapters.find(
    (h) => h.agent === agent && h.alias === alias
  ) as AdapterHandleWithFork | undefined;
}

/**
 * Returns `true` if any adapter in the registry is for the given agent type.
 */
function hasAgent(
  adapters: AdapterRegistry["adapters"],
  agent: string
): boolean {
  return adapters.some((h) => h.agent === agent);
}
