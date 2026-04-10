/**
 * test/sdk/workspace.test.ts
 *
 * Tests for src/sdk/workspace.ts — workspace-scoped session factory.
 *
 * NOTE: Tests that use real filesystem paths (git-root auto-discovery) use
 * process.cwd() rather than hardcoded paths so they work identically on
 * any machine (local dev machine, CI runner, etc.).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { Adapter, AdapterFactory, AdapterHandle, AdapterRegistry } from "../../src/core/types";
import type { WorkspaceConfig, WorkspaceSession, SessionRef } from "../../src/sdk/workspace";
import {
  createWorkspaceSession,
  setWorkspaceFactories,
  resolveScope,
  findGitRoot,
  buildCanonicalAlias,
  // Expose internal state for test resets
  sessionCache,
  adapterCache,
  sharedRegistry,
} from "../../src/sdk/workspace";

export type { WorkspaceConfig, WorkspaceSession, SessionRef };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The real CI repo root — works on GitHub Actions Ubuntu and local dev */
const REAL_REPO_ROOT = process.cwd();

/** Reset all workspace module state between tests */
function resetState() {
  sessionCache.clear();
  adapterCache.clear();
  sharedRegistry.adapters = [];
  setWorkspaceFactories({});
}

/** Stub adapter factory that always succeeds with an empty list */
function stubFactory(agent: "opencode" | "codex" | "claude"): AdapterFactory {
  return () => ({ version: "1.0.0-stub", listSessions: () => [] });
}

// ---------------------------------------------------------------------------
// Tests — resolveScope
// ---------------------------------------------------------------------------

describe("resolveScope", () => {
  beforeEach(() => {
    resetState();
    // No need to override process.cwd — our tests use absolute paths only
  });

  afterEach(() => {
    resetState();
  });

  test("returns absolute path as-is when provided", () => {
    const result = resolveScope("/home/user/repos/backend");
    expect(result).toBe("/home/user/repos/backend");
  });

  test("throws when given a relative path", () => {
    expect(() => resolveScope("relative/path")).toThrow(/absolute path/i);
  });

  test("throws when given an empty string", () => {
    expect(() => resolveScope("")).toThrow(/absolute path/i);
  });
});

// ---------------------------------------------------------------------------
// Tests — findGitRoot
// ---------------------------------------------------------------------------

describe("findGitRoot", () => {
  beforeEach(() => resetState);
  afterEach(() => resetState);

  test("returns the directory containing .git when found", () => {
    // Simulate: startDir has no .git, parent has .git
    // findGitRoot walks up, finds .git in parent
    const fakeExistsSync = (path: string | URL | Buffer) =>
      String(path) === "/home/user/repos/backend/.git";

    const result = findGitRoot("/home/user/repos/backend/src", fakeExistsSync);
    expect(result).toBe("/home/user/repos/backend");
  });

  test("returns null when no .git is found", () => {
    const fakeExistsSync = () => false;

    const result = findGitRoot("/tmp/no-git-here", fakeExistsSync);
    expect(result).toBeNull();
  });

  test("returns null when at root and no .git", () => {
    const fakeExistsSync = () => false;

    const result = findGitRoot("/", fakeExistsSync);
    expect(result).toBeNull();
  });

  test("finds .git at the starting directory itself", () => {
    const fakeExistsSync = (path: string | URL | Buffer) =>
      String(path) === "/project/.git";

    const result = findGitRoot("/project", fakeExistsSync);
    expect(result).toBe("/project");
  });
});

// ---------------------------------------------------------------------------
// Tests — buildCanonicalAlias
// ---------------------------------------------------------------------------

describe("buildCanonicalAlias", () => {
  beforeEach(() => resetState());
  afterEach(() => resetState());

  test("agent:scope when name is omitted", () => {
    const alias = buildCanonicalAlias("opencode", "/home/user/repos/backend");
    expect(alias).toBe("opencode:/home/user/repos/backend");
  });

  test("agent:scope:name when name is provided", () => {
    const alias = buildCanonicalAlias("opencode", "/home/user/repos/backend", "api");
    expect(alias).toBe("opencode:/home/user/repos/backend:api");
  });

  test("works for all agent types", () => {
    expect(buildCanonicalAlias("codex", "/tmp", "test")).toBe("codex:/tmp:test");
    expect(buildCanonicalAlias("claude", "/tmp", "test")).toBe("claude:/tmp:test");
  });

  test("scope path is used literally — no hashing", () => {
    const longPath = "/home/user/repos/backend/src/api/v1/endpoints";
    const alias = buildCanonicalAlias("opencode", longPath);
    expect(alias).toBe(`opencode:${longPath}`);
  });
});

// ---------------------------------------------------------------------------
// Tests — createWorkspaceSession (idempotency & aliasing)
// ---------------------------------------------------------------------------

describe("createWorkspaceSession idempotency", () => {
  beforeEach(() => {
    resetState();
    setWorkspaceFactories({
      opencode: stubFactory("opencode"),
      codex: stubFactory("codex"),
      claude: stubFactory("claude"),
    });
  });

  afterEach(() => {
    resetState();
    setWorkspaceFactories({});
  });

  test("returns same session for identical (agent, scope, name)", () => {
    const scope = "/home/user/repos/backend";

    const s1 = createWorkspaceSession({ agent: "opencode", scope });
    const s2 = createWorkspaceSession({ agent: "opencode", scope });

    expect(s1).toBe(s2);
  });

  test("returns same session for (agent, scope) with name omitted both times", () => {
    const scope = "/home/user/repos/backend";

    const s1 = createWorkspaceSession({ agent: "opencode", scope });
    const s2 = createWorkspaceSession({ agent: "opencode", scope });

    expect(s1).toBe(s2);
    expect(s1.sessionRef.alias).toBe("opencode:/home/user/repos/backend");
  });

  test("returns different sessions for different names", () => {
    const scope = "/home/user/repos/backend";

    const s1 = createWorkspaceSession({ agent: "opencode", scope, name: "a" });
    const s2 = createWorkspaceSession({ agent: "opencode", scope, name: "b" });

    expect(s1).not.toBe(s2);
    expect(s1.sessionRef.alias).toBe("opencode:/home/user/repos/backend:a");
    expect(s2.sessionRef.alias).toBe("opencode:/home/user/repos/backend:b");
  });

  test("returns different sessions for different agents", () => {
    const scope = "/home/user/repos/backend";

    const opencode = createWorkspaceSession({ agent: "opencode", scope });
    const codex = createWorkspaceSession({ agent: "codex", scope });
    const claude = createWorkspaceSession({ agent: "claude", scope });

    expect(opencode).not.toBe(codex);
    expect(codex).not.toBe(claude);
    expect(opencode.sessionRef.agent).toBe("opencode");
    expect(codex.sessionRef.agent).toBe("codex");
    expect(claude.sessionRef.agent).toBe("claude");
  });

  test("returns different sessions for different scopes", () => {
    const s1 = createWorkspaceSession({ agent: "opencode", scope: "/path/one" });
    const s2 = createWorkspaceSession({ agent: "opencode", scope: "/path/two" });

    expect(s1).not.toBe(s2);
    expect(s1.scope).toBe("/path/one");
    expect(s2.scope).toBe("/path/two");
  });

  test("named sessions get unique sessionIds", () => {
    const scope = "/home/user/repos/backend";

    const s1 = createWorkspaceSession({ agent: "opencode", scope, name: "x" });
    const s2 = createWorkspaceSession({ agent: "opencode", scope, name: "y" });

    expect(s1.sessionRef.sessionId).not.toBe(s2.sessionRef.sessionId);
  });
});

// ---------------------------------------------------------------------------
// Tests — WorkspaceSession shape
// ---------------------------------------------------------------------------

describe("createWorkspaceSession — returned shape", () => {
  beforeEach(() => {
    resetState();
    setWorkspaceFactories({
      opencode: stubFactory("opencode"),
      codex: stubFactory("codex"),
      claude: stubFactory("claude"),
    });
  });

  afterEach(() => {
    resetState();
    setWorkspaceFactories({});
  });

  test("returns WorkspaceSession with registry, adapter, sessionRef, scope", () => {
    const scope = "/home/user/repos/backend";
    const session = createWorkspaceSession({ agent: "opencode", scope });

    expect(session).toHaveProperty("registry");
    expect(session).toHaveProperty("adapter");
    expect(session).toHaveProperty("sessionRef");
    expect(session).toHaveProperty("scope");

    expect(typeof session.adapter.listSessions).toBe("function");
    expect(session.scope).toBe(scope);
  });

  test("sessionRef has agent, alias, and sessionId", () => {
    const scope = "/home/user/repos/backend";
    const session = createWorkspaceSession({ agent: "opencode", scope, name: "test" });

    expect(session.sessionRef.agent).toBe("opencode");
    expect(session.sessionRef.alias).toBe("opencode:/home/user/repos/backend:test");
    expect(typeof session.sessionRef.sessionId).toBe("string");
    expect(session.sessionRef.sessionId.length).toBeGreaterThan(0);
  });

  test("adapter is the same across named sessions with same agent+scope", () => {
    const scope = "/home/user/repos/backend";

    const s1 = createWorkspaceSession({ agent: "opencode", scope, name: "a" });
    const s2 = createWorkspaceSession({ agent: "opencode", scope, name: "b" });

    // Adapters are shared for the same agent+scope
    expect(s1.adapter).toBe(s2.adapter);
  });
});

// ---------------------------------------------------------------------------
// Tests — adapter registry integration
// ---------------------------------------------------------------------------

describe("createWorkspaceSession — registry integration", () => {
  beforeEach(() => {
    resetState();
    setWorkspaceFactories({
      opencode: stubFactory("opencode"),
      codex: stubFactory("codex"),
    });
  });

  afterEach(() => {
    resetState();
    setWorkspaceFactories({});
  });

  test("adapter is registered in registry on first use", () => {
    const scope = "/home/user/repos/backend";
    const session = createWorkspaceSession({ agent: "opencode", scope });

    const handle = session.registry.adapters.find(
      (h) => h.agent === "opencode" && h.alias === `opencode:${scope}`
    );

    expect(handle).toBeDefined();
  });

  test("adding second agent registers second handle", () => {
    const scope = "/home/user/repos/backend";

    createWorkspaceSession({ agent: "opencode", scope });
    createWorkspaceSession({ agent: "codex", scope });

    const session = createWorkspaceSession({ agent: "opencode", scope });

    expect(session.registry.adapters).toHaveLength(2);
  });

  test("same agent+scope does not duplicate registry entry", () => {
    const scope = "/home/user/repos/backend";

    createWorkspaceSession({ agent: "opencode", scope });
    createWorkspaceSession({ agent: "opencode", scope });

    const session = createWorkspaceSession({ agent: "opencode", scope });

    const opencodeHandles = session.registry.adapters.filter(
      (h) => h.agent === "opencode"
    );
    expect(opencodeHandles).toHaveLength(1);
  });

  test("different scopes create different registry entries", () => {
    createWorkspaceSession({ agent: "opencode", scope: "/path/one" });
    createWorkspaceSession({ agent: "opencode", scope: "/path/two" });

    // sharedRegistry is module-level — get it via the session
    const session = createWorkspaceSession({ agent: "opencode", scope: "/path/one" });

    expect(session.registry.adapters).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests — validation
// ---------------------------------------------------------------------------

describe("createWorkspaceSession — validation", () => {
  beforeEach(() => {
    resetState();
    setWorkspaceFactories({
      opencode: stubFactory("opencode"),
    });
  });

  afterEach(() => {
    resetState();
    setWorkspaceFactories({});
  });

  test("throws for invalid agent kind", () => {
    expect(() =>
      createWorkspaceSession({ agent: "unknown-agent" as any, scope: "/tmp" })
    ).toThrow(/agent must be one of/i);
  });

  test("throws for relative scope path", () => {
    expect(() =>
      createWorkspaceSession({ agent: "opencode", scope: "relative/path" })
    ).toThrow(/absolute path/i);
  });

  test("throws for empty scope string", () => {
    expect(() =>
      createWorkspaceSession({ agent: "opencode", scope: "" })
    ).toThrow(/absolute path/i);
  });
});

// ---------------------------------------------------------------------------
// Tests — git-root auto-discovery
// ---------------------------------------------------------------------------

describe("createWorkspaceSession — git-root auto-discovery", () => {
  beforeEach(() => {
    resetState();
    setWorkspaceFactories({
      opencode: stubFactory("opencode"),
    });
  });

  afterEach(() => {
    resetState();
    setWorkspaceFactories({});
  });

  test("auto-discovers git-root when scope is omitted", async () => {
    // process.cwd() is already the real repo root (with .git) on both
    // the local dev machine and the GitHub Actions Ubuntu runner.
    // createWorkspaceSession without a scope calls findGitRoot(process.cwd())
    // which should return the repo root since it walks up looking for .git.
    const session = createWorkspaceSession({ agent: "opencode" });
    expect(session.scope).toBe(REAL_REPO_ROOT);
  });

  test("falls back to cwd when no git root is found", async () => {
    const { mkdirSync, rmdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { randomUUID } = await import("node:crypto");

    const tmpDir = join("/tmp", `no-git-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });

    Object.defineProperty(process, "cwd", {
      value: () => tmpDir,
      writable: true,
      configurable: true,
    });

    try {
      const session = createWorkspaceSession({ agent: "opencode" });
      expect(session.scope).toBe(tmpDir);
    } finally {
      rmdirSync(tmpDir);
      // Restore cwd
      Object.defineProperty(process, "cwd", {
        value: () => REAL_REPO_ROOT,
        writable: true,
        configurable: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — named sessions scoping
// ---------------------------------------------------------------------------

describe("createWorkspaceSession — named session scoping", () => {
  beforeEach(() => {
    resetState();
    setWorkspaceFactories({
      opencode: stubFactory("opencode"),
      codex: stubFactory("codex"),
    });
  });

  afterEach(() => {
    resetState();
    setWorkspaceFactories({});
  });

  test("multiple named sessions share adapter but have different sessionIds", () => {
    const scope = "/home/user/repos/backend";

    const api = createWorkspaceSession({ agent: "opencode", scope, name: "api" });
    const cli = createWorkspaceSession({ agent: "opencode", scope, name: "cli" });
    const web = createWorkspaceSession({ agent: "opencode", scope, name: "web" });

    // All share the same adapter (agent+scope same)
    expect(api.adapter).toBe(cli.adapter);
    expect(cli.adapter).toBe(web.adapter);

    // But different sessionRefs
    expect(api.sessionRef.sessionId).not.toBe(cli.sessionRef.sessionId);
    expect(cli.sessionRef.sessionId).not.toBe(web.sessionRef.sessionId);

    // Unique aliases
    expect(api.sessionRef.alias).toBe("opencode:/home/user/repos/backend:api");
    expect(cli.sessionRef.alias).toBe("opencode:/home/user/repos/backend:cli");
    expect(web.sessionRef.alias).toBe("opencode:/home/user/repos/backend:web");
  });

  test("same name in different scopes produce different sessions", () => {
    const session1 = createWorkspaceSession({
      agent: "opencode",
      scope: "/repos/backend",
      name: "api",
    });
    const session2 = createWorkspaceSession({
      agent: "opencode",
      scope: "/repos/frontend",
      name: "api",
    });

    expect(session1).not.toBe(session2);
    expect(session1.sessionRef.alias).toBe("opencode:/repos/backend:api");
    expect(session2.sessionRef.alias).toBe("opencode:/repos/frontend:api");
  });
});

// ---------------------------------------------------------------------------
// Tests — WorkspaceConfig interface completeness
// ---------------------------------------------------------------------------

describe("WorkspaceConfig — all optional fields", () => {
  beforeEach(() => {
    resetState();
    setWorkspaceFactories({
      opencode: stubFactory("opencode"),
    });
  });

  afterEach(() => {
    resetState();
    setWorkspaceFactories({});
  });

  test("accepts config with agent only (scope auto-detected)", () => {
    // process.cwd() is the repo root — findGitRoot returns it since .git exists.
    const session = createWorkspaceSession({ agent: "opencode" });
    expect(session.sessionRef.agent).toBe("opencode");
    expect(session.scope).toBe(REAL_REPO_ROOT);
  });

  test("accepts config with agent + scope", () => {
    const session = createWorkspaceSession({
      agent: "codex",
      scope: "/custom/path",
    });

    expect(session.scope).toBe("/custom/path");
    expect(session.sessionRef.agent).toBe("codex");
  });

  test("accepts config with agent + scope + name", () => {
    const session = createWorkspaceSession({
      agent: "claude",
      scope: "/project",
      name: "analysis",
    });

    expect(session.sessionRef.alias).toBe("claude:/project:analysis");
  });

  test("accepts config with storage overrides", () => {
    const session = createWorkspaceSession({
      agent: "opencode",
      scope: "/project",
      name: "test",
      storage: { mode: "db", db_path: "/custom/db" },
    });

    expect(session).toBeDefined();
    expect(session.sessionRef.agent).toBe("opencode");
  });
});