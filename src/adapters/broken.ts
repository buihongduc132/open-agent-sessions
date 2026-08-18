/**
 * Broken adapter — defers construction errors to query time.
 *
 * When an adapter factory fails during construction (missing DB, missing
 * path, schema mismatch, config validation), the registry must still build.
 * A single broken adapter must NOT kill the entire CLI (OT4).
 *
 * The stored error surfaces on the first query:
 * - Sync methods (listSessions*, searchSessions) throw synchronously —
 *   matching their sync `SessionSummary[]` interface contract; callers
 *   already wrap them in try/catch (src/core/list.ts, registry handles).
 * - The async method (getSessionDetail) returns a REJECTED promise —
 *   a sync throw would escape `.catch()` chains (TS#12192 semantics).
 *
 * Either way the per-adapter handlers surface `[agent:alias] <error>` as a
 * per-agent error — other adapters keep working.
 */

import type { Adapter } from "../core/types";
import { errorMessage } from "../core/utils";

/**
 * Create an adapter whose every query fails with the deferred construction
 * error (labeled). Registry build succeeds; failure surfaces at query time.
 */
export function createBrokenAdapter(label: string, error: unknown): Adapter {
  const message = `${label} ${errorMessage(error)}`;

  const throwSync = (): never => {
    throw new Error(message);
  };

  const rejectAsync = async (): Promise<never> => {
    throw new Error(message);
  };

  return {
    version: "0.0.0-broken",
    listSessions: throwSync,
    listSessionsByTimeRange: throwSync,
    searchSessions: throwSync,
    getSessionDetail: rejectAsync,
  };
}
