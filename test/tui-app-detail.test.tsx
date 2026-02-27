import { describe, expect, test } from "bun:test";
import { render } from "@opentui/react";
import { TuiAppView } from "../src/tui/App";
import { type Config } from "../src/config/types";
import { type SessionDetail } from "../src/core/types";

const config: Config = {
  agents: [
    { agent: "opencode", alias: "personal", enabled: true, storage: { mode: "auto" } },
    { agent: "codex", alias: "work", enabled: true },
  ],
};

function makeDetail(overrides: Partial<SessionDetail>): SessionDetail {
  return {
    id: "cx-100",
    agent: "codex",
    alias: "work",
    title: "Refactor notes",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    message_count: 2,
    storage: "other",
    clone: {},
    ...overrides,
  };
}

describe("tui app detail flow", () => {
  test("missing session sets status error and remains in list", async () => {
    const list = async () => ({
      sessions: [
        {
          id: "cx-100",
          agent: "codex",
          alias: "work",
          title: "Refactor notes",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
          message_count: 2,
          storage: "other",
        },
      ],
      errors: [],
    });

    const getSession = async () => null;

    const frame = render(
      <TuiAppView
        config={config}
        list={list}
        getSession={getSession}
        viewportHeightOverride={8}
      />
    );

    await frame.waitFor(() => frame.text().includes("Sessions"));

    frame.keypress("return");
    await frame.waitFor(() => frame.text().includes("Session not found"));
    expect(frame.text()).toContain("[codex:work]");
  });

  test("detail view renders clone placeholders", async () => {
    const list = async () => ({
      sessions: [
        {
          id: "oc-200",
          agent: "opencode",
          alias: "personal",
          title: "Design doc",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
          message_count: 2,
          storage: "db",
        },
      ],
      errors: [],
    });

    const getSession = async () => makeDetail({ id: "oc-200", agent: "opencode", alias: "personal" });

    const frame = render(
      <TuiAppView
        config={config}
        list={list}
        getSession={getSession}
        viewportHeightOverride={8}
      />
    );

    await frame.waitFor(() => frame.text().includes("Sessions"));
    frame.keypress("return");
    await frame.waitFor(() => frame.text().includes("Session Detail"));
    expect(frame.text()).toContain("src.agent: n/a");
    expect(frame.text()).toContain("dst.version: n/a");
  });
});
