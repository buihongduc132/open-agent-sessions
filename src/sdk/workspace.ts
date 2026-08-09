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

import { dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AgentKind } from "../config/types";
import type { AgentEntry, OpenCodeAgentEntry } from "../config/types";
import { Adapter, AdapterFactories, AdapterRegistry } from "../core/types";
import { createAdapter } from "../core/registry";
import { errorMessage } from "../core/utils";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_AGENTS: AgentKind[] = ["opencode", "codex", "claude", "hermes", "gemini", "antigravity", "pi", "zcode"];

// ---------------------------------------------------------------------------
// Internal state (exported for test reset)
// ---------------------------------------------------------------------------

/** WorkspaceSession cache keyed by canonical alias (agent:scope:name) */
export const sessionCache = new Map<string, WorkspaceSession>();

/**
 * Adapter instance cache keyed by canonical alias (agent:scope).
 * Used to avoid re-instantiating the same adapter for different named sessions
 * within the same workspace scope.
 */
export const adapterCache = new Map<string, Adapter>();

/** AdapterRegistry shared across all workspace sessions (mutable) */
export let sharedRegistry: AdapterRegistry = { adapters: [] };

/** Adapter factories — must be provided at module init or first use */
export let factories: Partial<AdapterFactories> = {};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set the adapter factories (typically called once at application startup).
 * Must be called before createWorkspaceSession if you need real adapters;
 * otherwise a stub adapter is used.
 */
export function setWorkspaceFactories(f: Partial<AdapterFactories>): void {
  factories = f;
}

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
export function createWorkspaceSession(config: WorkspaceConfig): WorkspaceSession {
  // ── 1. Validate agent ───────────────────────────────────────────────────
  if (!VALID_AGENTS.includes(config.agent)) {
    throw new Error(
      `createWorkspaceSession: agent must be one of ${VALID_AGENTS.join(", ")}, got "${config.agent}"`
    );
  }

  // ── 2. Resolve scope ─────────────────────────────────────────────────────
  const scope = resolveScope(config.scope, config._existsSyncFn);

  // ── 3. Build canonical alias ──────────────────────────────────────────────
  const alias = buildCanonicalAlias(config.agent, scope, config.name);

  // ── 4. Idempotent return ──────────────────────────────────────────────────
  const cached = sessionCache.get(alias);
  if (cached) return cached;

  // ── 5. Ensure adapter is registered ─────────────────────────────────────
  ensureAdapterRegistered(config.agent, scope, config.storage);

  // ── 6. Get or create adapter instance ────────────────────────────────────
  const adapter = getOrCreateAdapter(config.agent, scope, config.storage);

  // ── 7. Generate sessionId ─────────────────────────────────────────────────
  const sessionId = randomUUID();

  // ── 8. Build sessionRef ───────────────────────────────────────────────────
  const sessionRef: SessionRef = {
    agent: config.agent,
    alias,
    sessionId,
  };

  // ── 9. Build and cache WorkspaceSession ───────────────────────────────────
  const session: WorkspaceSession = {
    registry: sharedRegistry,
    sessionRef,
    adapter,
    scope,
  };

  sessionCache.set(alias, session);
  return session;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace scope.
 * - If an absolute path is given, use it directly.
 * - If omitted, discover the nearest git-root from process.cwd().
 * - Falls back to process.cwd() if no git root is found.
 */
export function resolveScope(
  given?: string,
  existsSyncFn?: (path: string | URL | Buffer) => boolean
): string {
  if (given !== undefined) {
    if (!isAbsolute(given)) {
      throw new Error(
        `resolveScope: scope must be an absolute path, got "${given}"`
      );
    }
    return resolve(given);
  }

  const cwd = process.cwd();
  const gitRoot = findGitRoot(cwd, existsSyncFn);
  return gitRoot ?? cwd;
}

/**
 * Walk upward from `startDir` looking for a `.git` directory.
 * Returns the path of the containing directory of `.git`, or null if not found.
 *
 * @param startDir - Directory to start searching from
 * @param existsSyncFn - Optional override of fs.existsSync for testing.
 *                      Defaults to the real node:fs.existsSync.
 */
export function findGitRoot(
  startDir: string,
  existsSyncFn?: (path: string | URL | Buffer) => boolean
): string | null {
  const existsSync = existsSyncFn ?? _realExistsSync;
  let current = resolve(startDir);
  const root = resolve("/");

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }

    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break; // safety guard for root edge-case
    current = parent;
  }

  return null;
}

// Re-exported so tests can use the real implementation when not mocking
const { existsSync: _realExistsSync } = await import("node:fs");

// ---------------------------------------------------------------------------
// Alias construction
// ---------------------------------------------------------------------------

/**
 * Build the canonical alias string: `agent:scope` or `agent:scope:name`.
 * The scope is used as-is (absolute path); no hashing is applied.
 */
export function buildCanonicalAlias(
  agent: AgentKind,
  scope: string,
  name?: string
): string {
  if (name) {
    return `${agent}:${scope}:${name}`;
  }
  return `${agent}:${scope}`;
}

// ---------------------------------------------------------------------------
// Adapter management
// ---------------------------------------------------------------------------

/**
 * Ensure an adapter handle for the given agent+scope is registered in
 * sharedRegistry. No-op if already present.
 */
function ensureAdapterRegistered(
  agent: AgentKind,
  scope: string,
  _storage?: WorkspaceConfig["storage"]
): void {
  const alias = `${agent}:${scope}`;

  const alreadyRegistered = sharedRegistry.adapters.some(
    (h) => h.agent === agent && h.alias === alias
  );
  if (alreadyRegistered) return;

  const adapter = getOrCreateAdapter(agent, scope, _storage);

  const handle = buildHandle(agent, alias, adapter);
  sharedRegistry.adapters.push(handle);
}

/**
 * Get or create the adapter instance for the given agent+scope.
 * Uses the adapterCache to avoid re-instantiation.
 */
function getOrCreateAdapter(
  agent: AgentKind,
  scope: string,
  _storage?: WorkspaceConfig["storage"]
): Adapter {
  const cacheKey = `${agent}:${scope}`;

  const cached = adapterCache.get(cacheKey);
  if (cached) return cached;

  const adapter = instantiateAdapter(agent, scope, _storage);
  adapterCache.set(cacheKey, adapter);
  return adapter;
}

/**
 * Instantiate an adapter for the given agent.
 * Falls back to a stub adapter if no factory is registered.
 */
function instantiateAdapter(
  agent: AgentKind,
  _scope: string,
  _storage?: WorkspaceConfig["storage"]
): Adapter {
  const factory = factories[agent];
  if (!factory) {
    // Return a stub adapter so the workspace can still be used without
    // a full factory setup
    return {
      version: "0.0.0-stub",
      listSessions: () => [],
    };
  }

  // Build an AgentEntry for the factory
  const alias = `${agent}:${_scope}`;
  const entry: AgentEntry = buildAgentEntry(agent, alias, _storage);

  const adapter = createAdapter(entry, factories);
  if (!adapter) {
    throw new Error(
      `createWorkspaceSession: adapter factory for "${agent}" returned null`
    );
  }

  return adapter;
}

/**
 * Build a minimal AgentEntry from the given parameters.
 */
function buildAgentEntry(
  agent: AgentKind,
  alias: string,
  storage?: WorkspaceConfig["storage"]
): AgentEntry {
  if (agent === "opencode") {
    return {
      agent: "opencode",
      alias,
      enabled: true,
      storage: {
        mode: storage?.mode ?? "auto",
        db_path: storage?.db_path,
        jsonl_path: storage?.jsonl_path,
      },
    } as OpenCodeAgentEntry;
  }

  return {
    agent,
    alias,
    enabled: true,
  };
}

/**
 * Build an AdapterHandle from an agent, alias, and adapter.
 */
function buildHandle(
  agent: AgentKind,
  alias: string,
  adapter: Adapter
): import("../core/types").AdapterHandle {
  return {
    agent,
    alias,
    version: adapter.version,
    listSessions: async () => {
      try {
        const sessions = adapter.listSessions();
        return sessions;
      } catch (error) {
        throw new Error(
          `[${agent}:${alias}] listSessions: ${errorMessage(error)}`
        );
      }
    },
  };
}

// (Test reset done by clearing sessionCache, adapterCache, and resetting sharedRegistry/factories)
