/**
 * Broken adapter — defers construction errors to query time.
 *
 * When an adapter factory fails during construction (missing DB, missing
 * path, schema mismatch, config validation), the registry must still build.
 * A single broken adapter must NOT kill the entire CLI (OT4).
 *
 * The stored error is thrown on the first query. The per-adapter try/catch
 * in src/core/list.ts and bin/oas service wrappers catches it and surfaces
 * `[agent:alias] <error>` as a per-agent error — other adapters keep working.
 */

import type { Adapter } from "../core/types";
import { errorMessage } from "../core/utils";

/**
 * Create an adapter that throws `error` on every query.
 * Registry build succeeds; failure surfaces at query time with agent label.
 */
export function createBrokenAdapter(label: string, error: unknown): Adapter {
  const message = `${label} ${errorMessage(error)}`;
  const throwStored = (): never => {
    throw new Error(message);
  };

  return {
    version: "0.0.0-broken",
    listSessions: throwStored,
    listSessionsByTimeRange: throwStored,
    searchSessions: throwStored,
    getSessionDetail: throwStored,
  };
}
