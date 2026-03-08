import { describe, expect, test } from "bun:test";
import {
  CloneDestinationAdapter,
  CloneMetadata,
  CloneRegistry,
  CloneSession,
  CloneSourceAdapter,
  cloneSession,
  createCloneService,
  formatList,
} from "../src/core/clone";

const baseSession: CloneSession = {
  id: "cx-1",
  title: "Test Session",
  created_at: "2026-02-01T00:00:00.000Z",
  updated_at: "2026-02-01T00:10:00.000Z",
  messages: [
    {
      role: "user",
      content: "hi",
      created_at: "2026-02-01T00:00:01.000Z",
    },
    {
      role: "assistant",
      content: "hello",
      created_at: "2026-02-01T00:00:02.000Z",
    },
  ],
};

function buildRegistry(options: {
  sourceSession?: CloneSession | null;
  destination?: Partial<CloneDestinationAdapter>;
}) {
  const sourceAdapter: CloneSourceAdapter = {
    agent: "codex",
    alias: "work",
    version: "codex-v1",
    getSession: async (session_id) => {
      if (session_id !== "cx-1") return null;
      if (Object.prototype.hasOwnProperty.call(options, "sourceSession")) {
        return options.sourceSession ?? null;
      }
      return baseSession;
    },
  };

  const destinationAdapter: CloneDestinationAdapter = {
    agent: "opencode",
    alias: "personal",
    version: "oc-v2",
    createSession: async () => undefined,
    ...options.destination,
  };

  const registry: CloneRegistry = {
    getSource: (source) =>
      source.agent === "codex" && source.alias === "work" ? sourceAdapter : undefined,
    getDestination: (destination) =>
      destination.agent === "opencode" && destination.alias === "personal"
        ? destinationAdapter
        : undefined,
    listSources: (agent) => (agent === "codex" ? ["work"] : []),
    listDestinations: (agent) => (agent === "opencode" ? ["personal"] : []),
  };

  return { registry, sourceAdapter, destinationAdapter };
}

describe("clone core", () => {
  test("clones codex to opencode with metadata", async () => {
    const captured: Array<{ session_id: string; metadata: unknown; session: CloneSession }> = [];
    const { registry } = buildRegistry({
      destination: {
        createSession: async (input) => {
          captured.push(input);
        },
      },
    });

    const result = await cloneSession(
      {
        source: { agent: "codex", alias: "work", session_id: "cx-1" },
        destination: { agent: "opencode", alias: "personal" },
      },
      registry,
      { generateId: () => "oc-new" }
    );

    expect(result.destinationId).toBe("oc-new");
    expect(captured).toHaveLength(1);
    expect(captured[0].session_id).toBe("oc-new");
    expect(captured[0].session.id).toBe("oc-new");
    expect(captured[0].session.created_at).toBe(baseSession.created_at);
    expect(captured[0].session.updated_at).toBe(baseSession.updated_at);
    expect(captured[0].session.messages).toEqual(baseSession.messages);
    expect(captured[0].metadata).toEqual({
      src: { agent: "codex", session_id: "cx-1", version: "codex-v1" },
      dst: { agent: "opencode", session_id: "oc-new", version: "oc-v2" },
    });
  });

  test("returns clear error when source session is missing", async () => {
    const { registry } = buildRegistry({ sourceSession: null });

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry
      )
    ).rejects.toThrow(/source session not found/i);
  });

  test("does not write when unsupported content exists", async () => {
    const session: CloneSession = {
      ...baseSession,
      messages: [
        {
          role: "user",
          content: "file",
          created_at: "2026-02-01T00:00:01.000Z",
          attachments: ["file.png"],
        },
      ],
    };

    let wrote = false;
    const { registry } = buildRegistry({
      sourceSession: session,
      destination: {
        createSession: async () => {
          wrote = true;
        },
      },
    });

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry,
        { generateId: () => "oc-new" }
      )
    ).rejects.toThrow(/unsupported content/i);

    expect(wrote).toBe(false);
  });

  test("rejects unsupported direction", async () => {
    const { registry } = buildRegistry({});

    await expect(
      cloneSession(
        {
          source: { agent: "opencode", alias: "personal", session_id: "oc-1" },
          destination: { agent: "codex", alias: "work" },
        },
        registry
      )
    ).rejects.toThrow(/not supported/i);
  });

  test("unknown destination alias lists available aliases", async () => {
    const { registry } = buildRegistry({});

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "unknown" },
        },
        registry
      )
    ).rejects.toThrow(/available aliases: personal/i);
  });

  test("rejects missing source alias", async () => {
    const { registry } = buildRegistry({});

    await expect(
      cloneSession(
        {
          source: { agent: "codex", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry
      )
    ).rejects.toThrow(/alias is required/i);
  });

  test("unknown source alias lists available aliases", async () => {
    const { registry } = buildRegistry({});

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "unknown", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry
      )
    ).rejects.toThrow(/available aliases: work/i);
  });

  test("rejects images and tool calls", async () => {
    const base = {
      ...baseSession,
      messages: [
        {
          role: "assistant",
          content: "img",
          created_at: "2026-02-01T00:00:01.000Z",
          images: ["img.png"],
        },
      ],
    };
    const withTools = {
      ...baseSession,
      messages: [
        {
          role: "assistant",
          content: "tool",
          created_at: "2026-02-01T00:00:01.000Z",
          tool_calls: [{ id: "t1" }],
        },
      ],
    };

    const { registry } = buildRegistry({ sourceSession: base });
    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry
      )
    ).rejects.toThrow(/unsupported content/i);

    const { registry: registryTools } = buildRegistry({ sourceSession: withTools });
    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registryTools
      )
    ).rejects.toThrow(/unsupported content/i);
  });

  test("allows empty attachment payloads but rejects empty objects", async () => {
    let wrote = false;
    const { registry } = buildRegistry({
      sourceSession: {
        ...baseSession,
        messages: [
          {
            role: "user",
            content: "ok",
            created_at: "2026-02-01T00:00:01.000Z",
            attachments: [],
            images: "",
            tool_calls: [],
          },
        ],
      },
      destination: {
        createSession: async () => {
          wrote = true;
        },
      },
    });

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry,
        { generateId: () => "oc-new" }
      )
    ).resolves.toEqual({ destinationId: "oc-new" });

    expect(wrote).toBe(true);

    const { registry: registryReject } = buildRegistry({
      sourceSession: {
        ...baseSession,
        messages: [
          {
            role: "user",
            content: "bad",
            created_at: "2026-02-01T00:00:01.000Z",
            attachments: {},
          },
        ],
      },
    });

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registryReject
      )
    ).rejects.toThrow(/unsupported content/i);
  });

  test("retries destination id on conflict", async () => {
    const ids = ["oc-dup", "oc-free"];
    const created: string[] = [];
    const { registry } = buildRegistry({
      destination: {
        hasSession: async (id) => id === "oc-dup",
        generateSessionId: () => ids.shift() ?? "oc-fallback",
        createSession: async (input) => {
          created.push(input.session_id);
        },
      },
    });

    const result = await cloneSession(
      {
        source: { agent: "codex", alias: "work", session_id: "cx-1" },
        destination: { agent: "opencode", alias: "personal" },
      },
      registry
    );

    expect(result.destinationId).toBe("oc-free");
    expect(created).toEqual(["oc-free"]);
  });

  test("retries when createSession returns a conflict error", async () => {
    const ids = ["oc-dup", "oc-free"];
    let attempt = 0;
    const created: string[] = [];
    const { registry } = buildRegistry({
      destination: {
        generateSessionId: () => ids.shift() ?? "oc-fallback",
        createSession: async (input) => {
          attempt += 1;
          if (attempt === 1) {
            throw new Error("conflict");
          }
          created.push(input.session_id);
        },
        isIdConflictError: (error) =>
          error instanceof Error && error.message === "conflict",
      },
    });

    const result = await cloneSession(
      {
        source: { agent: "codex", alias: "work", session_id: "cx-1" },
        destination: { agent: "opencode", alias: "personal" },
      },
      registry
    );

    expect(result.destinationId).toBe("oc-free");
    expect(created).toEqual(["oc-free"]);
  });

  test("collision exhaustion returns context and attempt count", async () => {
    let createCalls = 0;
    const { registry } = buildRegistry({
      destination: {
        hasSession: async () => true,
        createSession: async () => {
          createCalls += 1;
        },
      },
    });

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry,
        { maxIdAttempts: 2 }
      )
    ).rejects.toThrow(/\[opencode:personal\].*2 attempts/i);

    expect(createCalls).toBe(0);
  });

  test("non-conflict createSession errors do not retry", async () => {
    let calls = 0;
    const { registry } = buildRegistry({
      destination: {
        createSession: async () => {
          calls += 1;
          throw new Error("boom");
        },
        isIdConflictError: () => false,
      },
    });

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry,
        { generateId: () => "oc-new" }
      )
    ).rejects.toThrow(/\[opencode:personal\].*boom/i);

    expect(calls).toBe(1);
  });

  test("destination errors include adapter context", async () => {
    const { registry } = buildRegistry({
      destination: {
        createSession: async () => {
          throw new Error("write failed");
        },
      },
    });

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry,
        { generateId: () => "oc-new" }
      )
    ).rejects.toThrow(/\[opencode:personal\].*write failed/i);
  });

  test("missing source adapter error when no aliases configured", async () => {
    const registry: CloneRegistry = {
      getSource: () => undefined,
      getDestination: () => undefined,
      listSources: () => [],
      listDestinations: () => ["personal"],
    };

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "missing", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry
      )
    ).rejects.toThrow(/source adapter not found.*codex:missing/i);
  });

  test("missing destination adapter error when no aliases configured", async () => {
    const sourceAdapter: CloneSourceAdapter = {
      agent: "codex",
      alias: "work",
      version: "codex-v1",
      getSession: async () => baseSession,
    };

    const registry: CloneRegistry = {
      getSource: () => sourceAdapter,
      getDestination: () => undefined,
      listSources: () => ["work"],
      listDestinations: () => [],
    };

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "missing" },
        },
        registry
      )
    ).rejects.toThrow(/destination adapter not found.*opencode:missing/i);
  });

  test("unknown direction claude to opencode is rejected", async () => {
    const registry: CloneRegistry = {
      getSource: () => undefined,
      getDestination: () => undefined,
      listSources: () => [],
      listDestinations: () => [],
    };

    await expect(
      cloneSession(
        {
          source: { agent: "claude", alias: "team", session_id: "cl-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry
      )
    ).rejects.toThrow(/not supported.*claude -> opencode/i);
  });

  test("unknown direction codex to claude is rejected", async () => {
    const registry: CloneRegistry = {
      getSource: () => undefined,
      getDestination: () => undefined,
      listSources: () => [],
      listDestinations: () => [],
    };

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "claude", alias: "team" },
        },
        registry
      )
    ).rejects.toThrow(/not supported.*codex -> claude/i);
  });

  test("unsupported pair opencode to codex is rejected", async () => {
    const registry: CloneRegistry = {
      getSource: () => undefined,
      getDestination: () => undefined,
      listSources: () => [],
      listDestinations: () => [],
    };

    await expect(
      cloneSession(
        {
          source: { agent: "opencode", alias: "personal", session_id: "oc-1" },
          destination: { agent: "codex", alias: "work" },
        },
        registry
      )
    ).rejects.toThrow(/not supported.*opencode -> codex/i);
  });

  test("adapter version property is included in metadata", async () => {
    const captured: Array<{ metadata: CloneMetadata }> = [];
    const { registry } = buildRegistry({
      destination: {
        createSession: async (input) => {
          captured.push(input);
        },
      },
    });

    await cloneSession(
      {
        source: { agent: "codex", alias: "work", session_id: "cx-1" },
        destination: { agent: "opencode", alias: "personal" },
      },
      registry,
      { generateId: () => "oc-new" }
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].metadata.src.version).toBe("codex-v1");
    expect(captured[0].metadata.dst.version).toBe("oc-v2");
  });

  test("id collision retry success with multiple attempts", async () => {
    const ids = ["oc-dup1", "oc-dup2", "oc-free"];
    const created: string[] = [];
    const { registry } = buildRegistry({
      destination: {
        hasSession: async (id) => id === "oc-dup1" || id === "oc-dup2",
        generateSessionId: () => ids.shift() ?? "oc-fallback",
        createSession: async (input) => {
          created.push(input.session_id);
        },
      },
    });

    const result = await cloneSession(
      {
        source: { agent: "codex", alias: "work", session_id: "cx-1" },
        destination: { agent: "opencode", alias: "personal" },
      },
      registry
    );

    expect(result.destinationId).toBe("oc-free");
    expect(created).toEqual(["oc-free"]);
  });

  test("clone error propagation surfaces adapter error", async () => {
    const { registry } = buildRegistry({
      destination: {
        createSession: async () => {
          throw new Error("disk full");
        },
      },
    });

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry,
        { generateId: () => "oc-new" }
      )
    ).rejects.toThrow(/disk full/);
  });

  test("message content is preserved during clone", async () => {
    const captured: Array<{ session: CloneSession }> = [];
    const { registry } = buildRegistry({
      sourceSession: {
        ...baseSession,
        messages: [
          { role: "user", content: "original message", created_at: "2026-02-01T00:00:01.000Z" },
          { role: "assistant", content: "assistant reply", created_at: "2026-02-01T00:00:02.000Z" },
        ],
      },
      destination: {
        createSession: async (input) => {
          captured.push(input);
        },
      },
    });

    await cloneSession(
      {
        source: { agent: "codex", alias: "work", session_id: "cx-1" },
        destination: { agent: "opencode", alias: "personal" },
      },
      registry,
      { generateId: () => "oc-new" }
    );

    expect(captured[0].session.messages).toHaveLength(2);
    expect(captured[0].session.messages[0].content).toBe("original message");
    expect(captured[0].session.messages[1].content).toBe("assistant reply");
  });

  test("session title is preserved during clone", async () => {
    const captured: Array<{ session: CloneSession }> = [];
    const { registry } = buildRegistry({
      sourceSession: {
        ...baseSession,
        title: "Important Discussion",
      },
      destination: {
        createSession: async (input) => {
          captured.push(input);
        },
      },
    });

    await cloneSession(
      {
        source: { agent: "codex", alias: "work", session_id: "cx-1" },
        destination: { agent: "opencode", alias: "personal" },
      },
      registry,
      { generateId: () => "oc-new" }
    );

    expect(captured[0].session.title).toBe("Important Discussion");
  });

  test("metadata contains correct source and destination agent fields", async () => {
    const captured: Array<{ metadata: CloneMetadata }> = [];
    const { registry } = buildRegistry({
      destination: {
        createSession: async (input) => {
          captured.push(input);
        },
      },
    });

    await cloneSession(
      {
        source: { agent: "codex", alias: "work", session_id: "cx-1" },
        destination: { agent: "opencode", alias: "personal" },
      },
      registry,
      { generateId: () => "oc-new" }
    );

    expect(captured[0].metadata.src.agent).toBe("codex");
    expect(captured[0].metadata.src.session_id).toBe("cx-1");
    expect(captured[0].metadata.dst.agent).toBe("opencode");
    expect(captured[0].metadata.dst.session_id).toBe("oc-new");
  });

  test("createCloneService returns a function that clones sessions", async () => {
    const captured: Array<{ session_id: string; metadata: unknown; session: CloneSession }> = [];
    const { registry } = buildRegistry({
      destination: {
        createSession: async (input) => {
          captured.push(input);
        },
      },
    });

    const cloneService = createCloneService(registry, { generateId: () => "oc-new" });

    const result = await cloneService({
      source: { agent: "codex", alias: "work", session_id: "cx-1" },
      destination: { agent: "opencode", alias: "personal" },
    });

    expect(result.destinationId).toBe("oc-new");
    expect(captured).toHaveLength(1);
    expect(captured[0].session_id).toBe("oc-new");
  });

  test("formatList returns (none) for empty array", () => {
    expect(formatList([])).toBe("(none)");
  });

  test("formatList joins values with comma for non-empty array", () => {
    expect(formatList(["a", "b", "c"])).toBe("a, b, c");
  });

  test("destination adapter with string error in createSession", async () => {
    const { registry } = buildRegistry({
      destination: {
        createSession: async () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw "string error message";
        },
        isIdConflictError: () => false,
      },
    });

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry,
        { generateId: () => "oc-new" }
      )
    ).rejects.toThrow(/string error message/);
  });

  test("destination adapter with unknown error type in createSession", async () => {
    const { registry } = buildRegistry({
      destination: {
        createSession: async () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw { code: 123, custom: true };
        },
        isIdConflictError: () => false,
      },
    });

    await expect(
      cloneSession(
        {
          source: { agent: "codex", alias: "work", session_id: "cx-1" },
          destination: { agent: "opencode", alias: "personal" },
        },
        registry,
        { generateId: () => "oc-new" }
      )
    ).rejects.toThrow(/unknown error/i);
  });
});
