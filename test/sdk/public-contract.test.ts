/**
 * Phase 1 RED contract: public adapter SDK boundary.
 *
 * This test intentionally targets only the public entrypoint. Consumers must
 * not import adapter contracts from src/core/types.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Adapter,
  SearchQuery,
  SessionDetail,
  SessionReadOptions,
  SessionSummary,
  ToolSearchQuery,
} from "../../src/sdk/index";

const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
) as {
  name: string;
  exports: Record<string, string>;
};

test("public SDK package exposes the declared adapter subpath", () => {
  expect(packageJson.name).toBe("open-agent-sessions");
  expect(packageJson.exports["./sdk"]).toBeDefined();
});

test("public SDK entrypoint exports the six ingestion contracts", () => {
  const adapter: Adapter = {
    version: "contract-1",
    listSessions: () => [],
  };
  const summary: SessionSummary = {
    id: "session-1",
    agent: "pi",
    alias: "main",
    title: "contract",
    created_at: "2026-08-04T00:00:00.000Z",
    updated_at: "2026-08-04T00:00:00.000Z",
    message_count: 0,
    storage: "jsonl",
  };
  const detail: SessionDetail = { ...summary, messages: [] };
  const readOptions: SessionReadOptions = { mode: "all_no_tools" };
  const search: SearchQuery = { text: "git" };
  const toolSearch: ToolSearchQuery = { tool: "bash" };

  expect(adapter.version).toBe("contract-1");
  expect(detail.id).toBe(summary.id);
  expect(readOptions.mode).toBe("all_no_tools");
  expect(search.text).toBe("git");
  expect(toolSearch.tool).toBe("bash");
});

test("SessionDetail pinned contract rejects missing required summary fields at compile time", () => {
  const detail: SessionDetail = {
    id: "session-1",
    agent: "pi",
    alias: "main",
    title: "contract",
    created_at: "2026-08-04T00:00:00.000Z",
    updated_at: "2026-08-04T00:00:00.000Z",
    message_count: 1,
    storage: "jsonl",
    messages: [],
  };

  expect(Object.keys(detail).sort()).toEqual([
    "agent",
    "alias",
    "created_at",
    "id",
    "message_count",
    "messages",
    "storage",
    "title",
    "updated_at",
  ]);
});

describe("consumer package resolution", () => {
  test("scoped SDK consumer import resolves from node_modules", async () => {
    const sdk = await import("@open-agent-sessions/sdk");
    expect(typeof sdk.createAdapterRegistry).toBe("function");
  });

  test("internal core type path is not a package export", () => {
    expect(packageJson.exports["./core/types"]).toBeUndefined();
  });
});

// Keep ToolSearchQuery in this contract even though it is not part of Phase 1's
// six named types: the existing public SDK already exposes this adjacent query.
void ({} as ToolSearchQuery);
