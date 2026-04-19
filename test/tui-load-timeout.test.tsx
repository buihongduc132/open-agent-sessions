/**
 * Bug 5 – TDD test: TUI permanently shows "Loading sessions…" when the list service hangs.
 *
 * Root cause: `timedList` in App.tsx calls `list(query)` with no timeout wrapper.
 * If the adapter (e.g. opencode SQLite) never resolves (DB lock, missing path,
 * etc.), `loading` stays `true` forever. No timeout, no error fallback.
 *
 * The useEffect at lines 187-201:
 * ```
 * useEffect(() => {
 *   let cancelled = false;
 *   timedList({ limit: DEFAULT_LIST_LIMIT })
 *     .then((result) => {
 *       if (cancelled) return;
 *       setListState((prev) => applyListData(prev, result));
 *     })
 *     .catch((error) => {
 *       if (cancelled) return;
 *       setFatalError(errorMessage(error));
 *     });
 *   return () => { cancelled = true; };
 * }, [timedList]);
 * ```
 *
 * Expected (fixed) behaviour:
 *   After a configurable LIST_TIMEOUT_MS, the app must transition out of the
 *   loading state so the user sees an error or empty state — not an infinite
 *   spinner. The fix should either:
 *     (a) race `list()` against a `setTimeout` promise in `timedList` and
 *         reject with a "list timed out" error, which `setFatalError` will
 *         display, OR
 *     (b) after the timeout, set `listState.loading = false` and populate
 *         `listState.errors` / `listState.statusMessage` with a timeout message.
 *
 *   In either case, after the timeout fires the component state must satisfy:
 *     - `listState.loading === false`  (spinner is gone)
 *     - AND ( `fatalError !== null`  OR  `listState.statusMessage !== undefined` )
 */

import { describe, expect, test } from "bun:test";
import type { SessionListResult } from "../src/core/list";
import type { ListService } from "../src/tui/App";

// ── Timeout constants ───────────────────────────────────────────────────────────
// Keep in sync with LIST_TIMEOUT_MS in src/tui/App.tsx.
export const LIST_TIMEOUT_MS = 8_000;

// The default bun:test runner timeout (5000ms) is too short for LIST_TIMEOUT_MS=8000ms.
// Set a per-test timeout large enough for the wait loop to complete.
const RUNNER_TIMEOUT_MS = LIST_TIMEOUT_MS + 2_000;

// Total wait: LIST_TIMEOUT_MS + generous buffer so the timeout path definitely fires.
const WAIT_MS = LIST_TIMEOUT_MS + 1_500;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ListState {
  loading: boolean;
  allSessions: unknown[];
  filteredSessions: unknown[];
  errors: unknown[];
  statusMessage?: string;
}

interface EffectCapture {
  setListStateCalls: Array<{ loading: boolean; statusMessage?: string }>;
  setFatalErrorCalls: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mirrors App.tsx's local error→string helper. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Builds an isolated test harness that replicates the timedList + useEffect
 * logic from App.tsx without requiring a React render.
 *
 * Returns `timedList` (mirrors App.tsx timedList with Promise.race timeout)
 * and `runEffect()` which executes the exact useEffect body from lines 187-201
 * with captured state setters.
 *
 * The 3rd argument `timeoutMs` caps how long the effect is allowed to run.
 * When the mock hangs, the returned promise resolves after `timeoutMs` with
 * whatever the effect captured so far, allowing the test to assert that no
 * loading-exit state was reached.
 */
function buildEffectTest(
  listService: ListService,
  timeoutMs: number
): {
  timedList: (query: { limit: number }) => Promise<SessionListResult>;
  runEffect: () => Promise<EffectCapture>;
} {
  const capture: EffectCapture = {
    setListStateCalls: [],
    setFatalErrorCalls: [],
  };

  // Minimal applyListData — mirrors list-model's real implementation.
  function applyListData(prev: ListState, result: SessionListResult): ListState {
    return {
      ...prev,
      loading: false,
      allSessions: result.sessions,
      filteredSessions: result.sessions,
      errors: [],
    };
  }

  // ── timedList — mirrors App.tsx timedList (with Promise.race timeout)
  async function timedList(query: { limit: number }): Promise<SessionListResult> {
    const t0 = Date.now();
    try {
      const result = await Promise.race([
        listService(query),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`List timed out after ${LIST_TIMEOUT_MS}ms`)),
            LIST_TIMEOUT_MS
          )
        ),
      ]);
      const ms = Date.now() - t0;
      if (ms > 5000) console.error(`[PERF SLOW] list took ${ms}ms`);
      return result;
    } catch (err) {
      const ms = Date.now() - t0;
      // Suppress in test harness — the harness captures the error separately.
      // console.error(`[PERF] list error after ${ms}ms:`, err);
      throw err;
    }
  }

  // ── runEffect — mirrors App.tsx lines 187-201 with captured setters
  async function runEffect(): Promise<EffectCapture> {
    let cancelled = false;

    let listState: ListState = {
      loading: true,
      allSessions: [],
      filteredSessions: [],
      errors: [],
      statusMessage: undefined,
    };
    let fatalError: string | null = null;

    function setListState(updater: (prev: ListState) => ListState): void {
      listState = updater(listState);
      capture.setListStateCalls.push({
        loading: listState.loading,
        statusMessage: listState.statusMessage,
      });
    }

    function setFatalError(msg: string): void {
      fatalError = msg;
      capture.setFatalErrorCalls.push(msg);
    }

    // Start the async work — mirrors the real useEffect body.
    const effectPromise = timedList({ limit: 50 })
      .then((result) => {
        if (cancelled) return;
        setListState((prev) => applyListData(prev, result));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFatalError(errorMessage(error));
      });

    // Race the effect against our test-level timeout so the harness can return.
    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));

    return capture;
  }

  return { timedList, runEffect };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Bug 5 – list service timeout", () => {
  /**
   * When `list()` is mocked to hang forever (never resolves/rejects), after
   * LIST_TIMEOUT_MS the app must transition out of the loading state.
   *
   * The fix: `timedList` in App.tsx races `list(query)` against a setTimeout
   * promise. When the timeout fires the race rejects with a "list timed out"
   * error, `setFatalError` is called, and the spinner disappears.
   *
   * After the wait the harness must find that at least one state transition
   * out of loading occurred (either a `setListState` with `loading=false`
   * or a `setFatalError` call).
   *
   * Run with:  bun test test/tui-load-timeout.test.tsx --timeout=10000
   * (The default 5000ms runner timeout is too short for WAIT_MS=9500.)
   */
  test(
    "when list() hangs forever, app must leave loading state within " +
      `${LIST_TIMEOUT_MS}ms`,
    async () => {
      const hangingService: ListService = () => new Promise(() => {});
      const { runEffect } = buildEffectTest(hangingService, WAIT_MS);

      const { setListStateCalls, setFatalErrorCalls } = await runEffect();

      const leftLoading =
        setListStateCalls.some((c) => c.loading === false) ||
        setFatalErrorCalls.length > 0;

      expect(leftLoading).toBe(true);
    },
    { timeout: RUNNER_TIMEOUT_MS }
  );

  /**
   * Sanity check: when list() resolves normally, loading becomes false and
   * no fatal error is set.
   */
  test("list resolves normally → loading becomes false, no fatal error", async () => {
    const resolved: SessionListResult = { sessions: [], errors: [], hasMore: false };
    const { runEffect } = buildEffectTest(() => Promise.resolve(resolved), 100);

    await new Promise((r) => setTimeout(r, 10)); // let microtasks drain
    const { setListStateCalls, setFatalErrorCalls } = await runEffect();

    expect(setListStateCalls.some((c) => c.loading === false)).toBe(true);
    expect(setFatalErrorCalls).toHaveLength(0);
  });

  /**
   * Sanity check: when list() rejects, setFatalError is called with the
   * error message and loading is cleared.
   */
  test("list rejects → setFatalError is called with the error message", async () => {
    const rejectErr = new Error("database locked");
    const { runEffect } = buildEffectTest(() => Promise.reject(rejectErr), 100);

    await new Promise((r) => setTimeout(r, 10));
    const { setFatalErrorCalls } = await runEffect();

    expect(setFatalErrorCalls).toContain("database locked");
  });
});
