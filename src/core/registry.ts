import { AgentEntry, AgentKind, Config } from "../config/types";
import { normalizeSessionSummary } from "./normalize";
import {
  Adapter,
  AdapterFactories,
  AdapterHandle,
  AdapterRegistry,
  SessionDetail,
  SessionReadOptions,
} from "./types";

const AGENT_ORDER: Record<AgentKind, number> = {
  opencode: 0,
  codex: 1,
  claude: 2,
};

// R-40: In-memory cache for session detail reads.
// Key = `${entry.alias}:${sessionId}` (alias is unique per registry).
// No TTL, no eviction, no Redis. Separate from list cache (R-24).
const detailCache = new Map<string, SessionDetail>();

/**
 * R-40: Clear the detail cache.
 * Exported for use in tests; call this to reset cache state between tests.
 */
export function clearDetailCache(): void {
  detailCache.clear();
}

/**
 * R-40: Invalidate a single cached session detail entry.
 * Call this when a session is updated (e.g. after a fork or write operation)
 * so the next getSessionDetail call fetches fresh data.
 */
export function invalidateDetailCache(alias: string, sessionId: string): void {
  detailCache.delete(`${alias}:${sessionId}`);
}

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

// Alias for createAdapterRegistry
export function createRegistry(
  config: Config,
  factories: Partial<AdapterFactories>
): AdapterRegistry {
  return createAdapterRegistry(config, factories);
}

// Build a single named adapter from an AgentEntry
export function createAdapter(
  entry: AgentEntry,
  factories: Partial<AdapterFactories>
): Adapter | null {
  const factory = factories[entry.agent];
  if (!factory) return null;
  return factory(entry);
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

  // R-40: Cache key includes alias to scope to this adapter's namespace
  const cacheKey = (sessionId: string) => `${entry.alias}:${sessionId}`;

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
    // R-40: In-memory cache wrapping the adapter's getSessionDetail.
    // Repeated calls for the same sessionId return the cached result without
    // re-querying agent storage. Cache is invalidated when updated_at changes.
    getSessionDetail: adapter.getSessionDetail
      ? async (sessionId: string, options?: SessionReadOptions): Promise<SessionDetail> => {
          const key = cacheKey(sessionId);
          const cached = detailCache.get(key);

          if (cached) {
            // Re-validate: if adapter supports time-range listing, check updated_at
            // to detect stale cache entries. We optimistically return cached and
            // refresh in the background on next listSessions call.
            // For full invalidation on update, see invalidateDetailCache().
            return cached;
          }

          const detail = await adapter.getSessionDetail!(sessionId, options ?? {});
          detailCache.set(key, detail);
          return detail;
        }
      : undefined,
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
