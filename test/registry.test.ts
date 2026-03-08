import { describe, expect, test } from "bun:test";
import {
  createAdapterRegistry,
  normalizeSessionSummary,
  type AdapterFactories,
  type Config,
} from "../src/index";
import { createCodexAdapter } from "../src/adapters/codex";
import { createClaudeAdapter } from "../src/adapters/claude";

const baseFactories: AdapterFactories = {
  opencode: () => ({ version: "1.0.0", listSessions: () => [] }),
  codex: () => ({ version: "1.0.0", listSessions: () => [] }),
  claude: () => ({ version: "1.0.0", listSessions: () => [] }),
};

function makeConfig(agents: Config["agents"]): Config {
  return { agents };
}

describe("adapter registry", () => {
  test("registry filters enabled entries", async () => {
    const registry = createAdapterRegistry(
      makeConfig([
        { agent: "opencode", alias: "main", enabled: true, storage: { mode: "auto" } },
        { agent: "codex", alias: "work", enabled: false },
      ]),
      baseFactories
    );

    expect(registry.adapters.length).toBe(1);
    expect(registry.adapters[0].agent).toBe("opencode");
  });

  test("registry supports multiple aliases per agent", () => {
    const registry = createAdapterRegistry(
      makeConfig([
        { agent: "codex", alias: "alpha", enabled: true },
        { agent: "codex", alias: "beta", enabled: true },
      ]),
      baseFactories
    );

    expect(registry.adapters.length).toBe(2);
    expect(registry.adapters[0].alias).toBe("alpha");
    expect(registry.adapters[1].alias).toBe("beta");
  });

  test("registry rejects duplicate aliases", () => {
    expect(() =>
      createAdapterRegistry(
        makeConfig([
          { agent: "codex", alias: "dup", enabled: true },
          { agent: "opencode", alias: "dup", enabled: true, storage: { mode: "auto" } },
        ]),
        baseFactories
      )
    ).toThrow(/duplicate alias/i);
  });

  test("adapter errors include agent+alias context", async () => {
    const registry = createAdapterRegistry(
      makeConfig([{ agent: "codex", alias: "work", enabled: true }]),
      {
        ...baseFactories,
        codex: () => ({
          version: "1.0.0",
          listSessions: () => {
            throw new Error("boom");
          },
        }),
      }
    );

    const handle = registry.adapters[0];
    await expect(handle.listSessions()).rejects.toThrow(/\[codex:work\]/i);
  });

  test("adapter factory errors include agent+alias context", () => {
    expect(() =>
      createAdapterRegistry(
        makeConfig([{ agent: "codex", alias: "work", enabled: true }]),
        {
          ...baseFactories,
          codex: () => {
            throw new Error("boom");
          },
        }
      )
    ).toThrow(/\[codex:work\].*boom/i);
  });

  test("registry validation context includes entry index", async () => {
    const registry = createAdapterRegistry(
      makeConfig([{ agent: "codex", alias: "work", enabled: true }]),
      {
        ...baseFactories,
        codex: () => ({
          version: "1.0.0",
          listSessions: () => [
            {
              id: "s1",
              agent: "codex",
              alias: "other",
              title: "Hello",
              created_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-02T00:00:00Z",
              message_count: 1,
              storage: "other",
            },
          ],
        }),
      }
    );

    await expect(registry.adapters[0].listSessions()).rejects.toThrow(
      /agents\[0\].*codex:work/i
    );
  });

  test("registry order is deterministic", () => {
    const registry = createAdapterRegistry(
      makeConfig([
        { agent: "claude", alias: "b", enabled: true },
        { agent: "opencode", alias: "z", enabled: true, storage: { mode: "auto" } },
        { agent: "codex", alias: "c", enabled: true },
        { agent: "opencode", alias: "a", enabled: true, storage: { mode: "auto" } },
      ]),
      baseFactories
    );

    expect(registry.adapters.map((adapter) => `${adapter.agent}:${adapter.alias}`)).toEqual([
      "opencode:a",
      "opencode:z",
      "codex:c",
      "claude:b",
    ]);
  });

  test("registry handles empty state", () => {
    const registry = createAdapterRegistry(makeConfig([]), baseFactories);
    expect(registry.adapters).toEqual([]);
  });

  test("registry non-list errors include entry index", async () => {
    const registry = createAdapterRegistry(
      makeConfig([{ agent: "codex", alias: "work", enabled: true }]),
      {
        ...baseFactories,
        codex: () => ({ version: "1.0.0", listSessions: () => ({}) as any }),
      }
    );

    await expect(registry.adapters[0].listSessions()).rejects.toThrow(
      /agents\[0\].*codex:work/i
    );
  });

  test("registry normalizes adapter output", async () => {
    const registry = createAdapterRegistry(
      makeConfig([{ agent: "opencode", alias: "main", enabled: true, storage: { mode: "auto" } }]),
      {
        ...baseFactories,
        opencode: () => ({
          version: "1.0.0",
          listSessions: () => [
            {
              id: "",
              agent: "opencode",
              alias: "main",
              title: "",
              created_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-01T00:00:00Z",
              message_count: 0,
              storage: "db",
            },
          ],
        }),
      }
    );

    await expect(registry.adapters[0].listSessions()).rejects.toThrow(/session\[0\].*id/i);
  });

  test("registry enforces entry agent/alias", async () => {
    const registry = createAdapterRegistry(
      makeConfig([{ agent: "codex", alias: "work", enabled: true }]),
      {
        ...baseFactories,
        codex: () => ({
          version: "1.0.0",
          listSessions: () => [
            {
              id: "s1",
              agent: "opencode",
              alias: "work",
              title: "Hello",
              created_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-02T00:00:00Z",
              message_count: 1,
              storage: "db",
            },
          ],
        }),
      }
    );

    await expect(registry.adapters[0].listSessions()).rejects.toThrow(/agent must be \"codex\"/i);
  });
});

describe("session summary normalization", () => {
  test("normalizes timestamps to ISO strings", () => {
    const input = {
      id: "s1",
      agent: "opencode",
      alias: "main",
      title: "Hello",
      created_at: new Date("2024-01-01T00:00:00Z"),
      updated_at: "2024-01-02T00:00:00Z",
      message_count: 2,
      storage: "db",
    };

    const result = normalizeSessionSummary(input);
    expect(result.created_at).toBe("2024-01-01T00:00:00.000Z");
    expect(result.updated_at).toBe("2024-01-02T00:00:00.000Z");
  });

  test("rejects invalid timestamps", () => {
    expect(() =>
      normalizeSessionSummary({
        id: "s1",
        agent: "opencode",
        alias: "main",
        title: "Hello",
        created_at: "not a date",
        updated_at: "2024-01-02T00:00:00Z",
        message_count: 2,
        storage: "db",
      })
    ).toThrow(/created_at/i);
  });

  test("requires non-empty id", () => {
    expect(() =>
      normalizeSessionSummary({
        id: "",
        agent: "opencode",
        alias: "main",
        title: "Hello",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        message_count: 2,
        storage: "db",
      })
    ).toThrow(/id must be a non-empty string/i);
  });

  test("requires non-negative integer message_count", () => {
    expect(() =>
      normalizeSessionSummary({
        id: "s1",
        agent: "opencode",
        alias: "main",
        title: "Hello",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        message_count: -1,
        storage: "db",
      })
    ).toThrow(/message_count/i);
  });

  test("normalization is read-only", () => {
    const input = {
      id: "s1",
      agent: "opencode",
      alias: "main",
      title: "Hello",
      created_at: new Date("2024-01-01T00:00:00Z"),
      updated_at: new Date("2024-01-02T00:00:00Z"),
      message_count: 2,
      storage: "db",
    };
    const original = { ...input };

    const result = normalizeSessionSummary(input);

    expect(result).not.toBe(input);
    expect(input).toEqual(original);
  });
});

describe("adapter version metadata", () => {
  test("adapter handle exposes version from adapter", async () => {
    const registry = createAdapterRegistry(
      makeConfig([{ agent: "codex", alias: "work", enabled: true }]),
      {
        ...baseFactories,
        codex: () => ({ version: "2.5.0", listSessions: () => [] }),
      }
    );

    expect(registry.adapters[0].version).toBe("2.5.0");
  });

  test("all built-in adapters have version property", async () => {
    const codexAdapter = createCodexAdapter({ agent: "codex", alias: "test", enabled: true });
    const claudeAdapter = createClaudeAdapter({ agent: "claude", alias: "test", enabled: true });

    expect(codexAdapter.version).toBeDefined();
    expect(typeof codexAdapter.version).toBe("string");
    expect(claudeAdapter.version).toBeDefined();
    expect(typeof claudeAdapter.version).toBe("string");
  });
});
