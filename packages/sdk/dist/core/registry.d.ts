import { AgentEntry, Config } from "../config/types";
import { Adapter, AdapterFactories, AdapterRegistry } from "./types";
/**
 * R-40: Clear the entire detail cache and list cache.
 * Also clears the list cache since session details and the list are coupled:
 * when a session is updated, its position/summary in the list may change.
 * Exported for use in tests; call this to reset cache state between tests.
 */
export declare function clearDetailCache(): void;
/**
 * R-40: Invalidate a single cached session detail entry.
 * Clears the list cache so the session list reflects the updated session.
 */
export declare function invalidateDetailCache(alias: string, sessionId: string): void;
export declare function createAdapterRegistry(config: Config, factories: Partial<AdapterFactories>): AdapterRegistry;
export declare function createRegistry(config: Config, factories: Partial<AdapterFactories>): AdapterRegistry;
export declare function createAdapter(entry: AgentEntry, factories: Partial<AdapterFactories>): Adapter | null;
