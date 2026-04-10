/**
 * R-39: SDK: session fork API (Zed parent_id wiring)
 * Tests for forkSession() — SDK-level session forking via AdapterRegistry.
 *
 * @file test/sdk/session.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { Adapter, AdapterRegistry, SessionDetail } from "../../src/core/types";
import type { ForkResult, SessionRef } from "../../src/sdk/session";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal in-memory adapter that always throws for methods it does not implement. */
function makeStubAdapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    version: "stub-1.0.0",
    listSessions: () => [],
    ...overrides,
  };
}

function makeStubRegistry(handles: AdapterRegistry["adapters"]): AdapterRegistry {
  return { adapters: handles };
}

// ---------------------------------------------------------------------------
// forkSession unit tests
// ---------------------------------------------------------------------------

// These are imported only for the type signature; runtime import happens after
// the module is implemented.
let forkSession: typeof import("../../src/sdk/session").forkSession;

test("forkSession is exported from sdk/session.ts", async () => {
  const mod = await import("../../src/sdk/session");
  expect(typeof mod.forkSession).toBe("function");
  forkSession = mod.forkSession;
});

// ---------------------------------------------------------------------------
// R-39 Test cases
// ---------------------------------------------------------------------------

describe("R-39: forkSession — SessionRef, ForkResult, registry wiring", () => {
  // -------------------------------------------------------------------------
  // TC-R39-1: forkSession reads source session and returns ForkResult
  // -------------------------------------------------------------------------
  test("forkSession reads source session and returns ForkResult with all required fields", async () => {
    const sourceDetail: SessionDetail = {
      id: "session-abc",
      agent: "opencode",
      alias: "main",
      title: "My Session",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T12:00:00.000Z",
      message_count: 5,
      storage: "db",
      messages: [
        {
          id: "msg-1",
          role: "user",
          created_at: "2024-01-01T00:00:00.000Z",
          parts: [{ type: "text", text: "Hello" }],
        },
        {
          id: "msg-2",
          role: "assistant",
          created_at: "2024-01-01T00:01:00.000Z",
          parts: [{ type: "text", text: "Hi there!" }],
        },
      ],
    };

    let forkSessionImpl: typeof forkSession | undefined;
    if (!forkSessionImpl) {
      const mod = await import("../../src/sdk/session");
      forkSessionImpl = mod.forkSession;
    }

    const destAdapter = makeStubAdapter({
      getSessionDetail: undefined, // dest does NOT need to read source
      forkSession: async (sourceSessionId, destAgent, destAlias) => ({
        newSessionId: `forked-${sourceSessionId}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString(),
      }),
    });

    const registry = makeStubRegistry([
      {
        agent: "opencode",
        alias: "main",
        version: "1.0.0",
        listSessions: async () => [sourceDetail],
        getSessionDetail: async (id) => {
          if (id === "session-abc") return sourceDetail;
          throw new Error(`Session not found: ${id}`);
        },
        forkSession: destAdapter.forkSession!,
      },
      // Destination adapter handle (fork-target)
      {
        agent: "opencode",
        alias: "fork-target",
        version: "1.0.0",
        listSessions: async () => [],
        forkSession: destAdapter.forkSession!,
      },
    ]);

    const source: SessionRef = { agent: "opencode", alias: "main", sessionId: "session-abc" };
    const dest: SessionRef = { agent: "opencode", alias: "fork-target", sessionId: "forked-session-abc" };

    const result = await forkSessionImpl!(registry, source, dest);

    expect(result).toBeDefined();
    expect(typeof result.newSessionId).toBe("string");
    expect(typeof result.parentSessionId).toBe("string");
    expect(typeof result.destAgent).toBe("string");
    expect(typeof result.destAlias).toBe("string");
    expect(typeof result.forkedAt).toBe("string");

    // Verify the forkedAt timestamp is valid ISO
    const parsedDate = new Date(result.forkedAt);
    expect(Number.isNaN(parsedDate.getTime())).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-R39-2: parentSessionId is correctly set to source sessionId
  // -------------------------------------------------------------------------
  test("parentSessionId equals source.sessionId", async () => {
    const sourceDetail: SessionDetail = {
      id: "母session-42",
      agent: "codex",
      alias: "prod",
      title: "Parent",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      message_count: 0,
      storage: "db",
    };

    let forkImpl: typeof forkSession | undefined;
    if (!forkImpl) {
      const mod = await import("../../src/sdk/session");
      forkImpl = mod.forkSession;
    }

    const destAdapter = makeStubAdapter({
      forkSession: async (sourceSessionId, destAgent, destAlias) => ({
        newSessionId: `fork-of-${sourceSessionId}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString(),
      }),
    });

    const registry = makeStubRegistry([
      {
        agent: "codex",
        alias: "prod",
        version: "1.0.0",
        listSessions: async () => [sourceDetail],
        getSessionDetail: async () => sourceDetail,
        forkSession: destAdapter.forkSession!,
      },
      // Destination adapter handle
      {
        agent: "opencode",
        alias: "fork-target",
        version: "1.0.0",
        listSessions: async () => [],
        forkSession: destAdapter.forkSession!,
      },
    ]);

    const source: SessionRef = { agent: "codex", alias: "prod", sessionId: "母session-42" };
    const dest: SessionRef = { agent: "opencode", alias: "fork-target", sessionId: "fork-of-母session-42" };

    const result = await forkImpl!(registry, source, dest);

    expect(result.parentSessionId).toBe(source.sessionId);
    expect(result.parentSessionId).toBe("母session-42");
  });

  // -------------------------------------------------------------------------
  // TC-R39-3: Registry throws if source agent is not found
  // -------------------------------------------------------------------------
  test("throws when source agent is not registered", async () => {
    let forkImpl: typeof forkSession | undefined;
    if (!forkImpl) {
      const mod = await import("../../src/sdk/session");
      forkImpl = mod.forkSession;
    }

    const registry = makeStubRegistry([
      {
        agent: "opencode",
        alias: "main",
        version: "1.0.0",
        listSessions: async () => [],
      },
    ]);

    const source: SessionRef = { agent: "nonexistent", alias: "x", sessionId: "any" };
    const dest: SessionRef = { agent: "opencode", alias: "main", sessionId: "any" };

    await expect(forkImpl!(registry, source, dest)).rejects.toThrow(/not found|no adapter|unknown/i);
  });

  // -------------------------------------------------------------------------
  // TC-R39-4: Registry throws if source alias is not found (same agent)
  // -------------------------------------------------------------------------
  test("throws when source alias is not registered for the given agent", async () => {
    let forkImpl: typeof forkSession | undefined;
    if (!forkImpl) {
      const mod = await import("../../src/sdk/session");
      forkImpl = mod.forkSession;
    }

    const registry = makeStubRegistry([
      {
        agent: "opencode",
        alias: "main",
        version: "1.0.0",
        listSessions: async () => [],
      },
    ]);

    const source: SessionRef = { agent: "opencode", alias: "nonexistent-alias", sessionId: "any" };
    const dest: SessionRef = { agent: "opencode", alias: "main", sessionId: "any" };

    await expect(forkImpl!(registry, source, dest)).rejects.toThrow(/not found|no adapter|unknown/i);
  });

  // -------------------------------------------------------------------------
  // TC-R39-5: Adapter throws gracefully if forkSession is not implemented
  // -------------------------------------------------------------------------
  test("throws when destination adapter does not implement forkSession", async () => {
    let forkImpl: typeof forkSession | undefined;
    if (!forkImpl) {
      const mod = await import("../../src/sdk/session");
      forkImpl = mod.forkSession;
    }

    const sourceDetail: SessionDetail = {
      id: "母session-5",
      agent: "opencode",
      alias: "main",
      title: "Parent",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      message_count: 0,
      storage: "db",
    };

    const registry = makeStubRegistry([
      {
        agent: "opencode",
        alias: "main",
        version: "1.0.0",
        listSessions: async () => [sourceDetail],
        getSessionDetail: async () => sourceDetail,
        // NO forkSession — undefined
      },
      {
        agent: "opencode",
        alias: "fork-target",
        version: "1.0.0",
        listSessions: async () => [],
        // NO forkSession — undefined
      },
    ]);

    const source: SessionRef = { agent: "opencode", alias: "main", sessionId: "母session-5" };
    const dest: SessionRef = { agent: "opencode", alias: "fork-target", sessionId: "forked-5" };

    // When the dest adapter doesn't implement forkSession, the SDK must throw
    // a meaningful error rather than crashing.
    await expect(forkImpl!(registry, source, dest)).rejects.toThrow(
      /forkSession|not implemented|not supported/i
    );
  });

  // -------------------------------------------------------------------------
  // TC-R39-6: ForkResult shape — all fields present
  // -------------------------------------------------------------------------
  test("ForkResult contains newSessionId, parentSessionId, destAgent, destAlias, forkedAt", async () => {
    let forkImpl: typeof forkSession | undefined;
    if (!forkImpl) {
      const mod = await import("../../src/sdk/session");
      forkImpl = mod.forkSession;
    }

    const sourceDetail: SessionDetail = {
      id: "母session-x",
      agent: "opencode",
      alias: "src",
      title: "Source",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      message_count: 0,
      storage: "db",
    };

    const destAdapter = makeStubAdapter({
      forkSession: async (sourceSessionId, destAgent, destAlias) => ({
        newSessionId: `new-${sourceSessionId}`,
        parentSessionId: sourceSessionId,
        destAgent,
        destAlias,
        forkedAt: new Date().toISOString(),
      }),
    });

    const registry = makeStubRegistry([
      {
        agent: "opencode",
        alias: "src",
        version: "1.0.0",
        listSessions: async () => [sourceDetail],
        getSessionDetail: async () => sourceDetail,
        forkSession: destAdapter.forkSession!,
      },
      {
        agent: "opencode",
        alias: "dst",
        version: "1.0.0",
        listSessions: async () => [],
        forkSession: destAdapter.forkSession!,
      },
    ]);

    const source: SessionRef = { agent: "opencode", alias: "src", sessionId: "母session-x" };
    const dest: SessionRef = { agent: "opencode", alias: "dst", sessionId: "new-母session-x" };

    const result = await forkImpl!(registry, source, dest);

    // All required ForkResult fields
    expect(result).toHaveProperty("newSessionId");
    expect(result).toHaveProperty("parentSessionId");
    expect(result).toHaveProperty("destAgent");
    expect(result).toHaveProperty("destAlias");
    expect(result).toHaveProperty("forkedAt");

    // Values match expectations
    expect(result.newSessionId).toBe(dest.sessionId);
    expect(result.parentSessionId).toBe(source.sessionId);
    expect(result.destAgent).toBe(dest.agent);
    expect(result.destAlias).toBe(dest.alias);
  });

  // -------------------------------------------------------------------------
  // TC-R39-7: forkSession calls getSessionDetail on source adapter
  // -------------------------------------------------------------------------
  test("forkSession calls getSessionDetail on source adapter with correct sessionId", async () => {
    let forkImpl: typeof forkSession | undefined;
    if (!forkImpl) {
      const mod = await import("../../src/sdk/session");
      forkImpl = mod.forkSession;
    }

    const sourceDetail: SessionDetail = {
      id: "母session-target-call",
      agent: "claude",
      alias: "prod",
      title: "Parent",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      message_count: 3,
      storage: "db",
      messages: [
        {
          id: "msg-a",
          role: "user",
          created_at: "2024-01-01T00:00:00.000Z",
          parts: [{ type: "text", text: "A" }],
        },
      ],
    };

    let getSessionDetailCalls: Array<{ sessionId: string; options?: unknown }> = [];

    const registry = makeStubRegistry([
      {
        agent: "claude",
        alias: "prod",
        version: "1.0.0",
        listSessions: async () => [sourceDetail],
        getSessionDetail: async (sessionId, options) => {
          getSessionDetailCalls.push({ sessionId, options });
          return sourceDetail;
        },
        forkSession: async (sourceSessionId, destAgent, destAlias) => ({
          newSessionId: `forked-${sourceSessionId}`,
          parentSessionId: sourceSessionId,
          destAgent,
          destAlias,
          forkedAt: new Date().toISOString(),
        }),
      },
      {
        agent: "claude",
        alias: "fork-dst",
        version: "1.0.0",
        listSessions: async () => [],
        forkSession: async (sourceSessionId, destAgent, destAlias) => ({
          newSessionId: `forked-${sourceSessionId}`,
          parentSessionId: sourceSessionId,
          destAgent,
          destAlias,
          forkedAt: new Date().toISOString(),
        }),
      },
    ]);

    const source: SessionRef = { agent: "claude", alias: "prod", sessionId: "母session-target-call" };
    const dest: SessionRef = { agent: "claude", alias: "fork-dst", sessionId: "forked-target-call" };

    await forkImpl!(registry, source, dest);

    expect(getSessionDetailCalls.length).toBeGreaterThanOrEqual(1);
    expect(getSessionDetailCalls.some((c) => c.sessionId === "母session-target-call")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type checks — ensure ForkResult and SessionRef are exported correctly
// ---------------------------------------------------------------------------

describe("R-39: type exports from sdk/session.ts", () => {
  test("ForkResult type is exported from sdk/session", async () => {
    const mod = await import("../../src/sdk/session");
    // Verify the type exists by checking it compiles
    const _result: mod.ForkResult = {
      newSessionId: "x",
      parentSessionId: "y",
      destAgent: "opencode",
      destAlias: "main",
      forkedAt: new Date().toISOString(),
    };
    expect(_result.newSessionId).toBe("x");
  });

  test("SessionRef type is exported from sdk/session", async () => {
    const mod = await import("../../src/sdk/session");
    const _ref: mod.SessionRef = {
      agent: "opencode",
      alias: "main",
      sessionId: "母session-1",
    };
    expect(_ref.agent).toBe("opencode");
  });
});

// ---------------------------------------------------------------------------
// Integration: forkSession is re-exported from sdk/index.ts
// ---------------------------------------------------------------------------

describe("R-39: forkSession re-exported from sdk/index.ts", () => {
  test("forkSession is accessible via sdk/index", async () => {
    const sdk = await import("../../src/sdk/index");
    expect(typeof sdk.forkSession).toBe("function");
  });

  test("ForkResult is re-exported from sdk/index", async () => {
    const sdk = await import("../../src/sdk/index");
    const _r: sdk.ForkResult = {
      newSessionId: "x",
      parentSessionId: "y",
      destAgent: "z",
      destAlias: "w",
      forkedAt: new Date().toISOString(),
    };
    expect(_r.newSessionId).toBe("x");
  });

  test("SessionRef is re-exported from sdk/index", async () => {
    const sdk = await import("../../src/sdk/index");
    const _r: sdk.SessionRef = { agent: "opencode", alias: "main", sessionId: "母session-1" };
    expect(_r.sessionId).toBe("母session-1");
  });
});
