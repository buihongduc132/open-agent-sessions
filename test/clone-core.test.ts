import { describe, expect, test } from "bun:test";
import {
  CloneDestinationAdapter,
  CloneRegistry,
  CloneSession,
  CloneSourceAdapter,
  cloneSession,
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
});
