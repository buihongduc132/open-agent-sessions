import { describe, expect, test } from "bun:test";
import {
  applyDetailKey,
  buildDetailLines,
  createDetailState,
  setDetailViewportHeight,
} from "../src/tui/detail-model";
import { type SessionDetail } from "../src/core/types";

const detail: SessionDetail = {
  id: "oc-200",
  agent: "opencode",
  alias: "personal",
  title: "Design doc",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
  message_count: 2,
  storage: "db",
  clone: {},
};

describe("tui detail model", () => {
  test("Esc returns to list, q/Ctrl+C exit", () => {
    let state = createDetailState(detail);
    let result = applyDetailKey(state, { name: "escape" });
    expect(result.effect?.type).toBe("back");

    result = applyDetailKey(state, { name: "q" });
    expect(result.effect?.type).toBe("exit");
    expect(result.effect?.reason).toBe("quit");

    result = applyDetailKey(state, { name: "c", ctrl: true });
    expect(result.effect?.type).toBe("exit");
    expect(result.effect?.reason).toBe("ctrl-c");
  });

  test("help overlay closes with Esc or ?", () => {
    let state = createDetailState(detail);
    let result = applyDetailKey(state, { name: "?" });
    state = result.state;
    expect(state.mode).toBe("help");

    result = applyDetailKey(state, { name: "escape" });
    state = result.state;
    expect(state.mode).toBe("detail");
  });

  test("scrolls with G to bottom", () => {
    let state = createDetailState(detail);
    const lines = buildDetailLines(detail);
    state = setDetailViewportHeight(state, 3);
    const maxOffset = Math.max(0, lines.length - 3);
    const result = applyDetailKey(state, { name: "G" });
    expect(result.state.scrollOffset).toBe(maxOffset);
  });

  test("title fallback and clone placeholders render n/a", () => {
    const withClone: SessionDetail = {
      ...detail,
      title: "",
      clone: { src: {}, dst: {} },
    };
    const lines = buildDetailLines(withClone);
    expect(lines).toContain("title: oc-200");
    expect(lines).toContain("src.agent: n/a");
    expect(lines).toContain("dst.session_id: n/a");
  });
});
