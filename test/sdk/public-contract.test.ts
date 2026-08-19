/**
 * test/sdk/public-contract.test.ts
 *
 * TDD RED — Phase 1 contract tests for @open-agent-sessions/sdk
 *
 * These tests define the PUBLIC SDK contract that oas-command-stats (and other
 * consumers) depend on. Per OT1-G1/OT49, the SDK must expose a stable, versioned
 * import boundary with:
 *   1. Package subpath resolution via exports map
 *   2. Exactly six core type exports (Adapter, SessionSummary, SessionDetail,
 *      SessionReadOptions, SearchQuery, TimeRangeOptions)
 *   3. Pinned SessionDetail shape (field set is locked)
 *   4. Consumer import resolution fixture (proves the import pattern works)
 *
 * These tests FAIL (RED) because the contract is not yet implemented.
 * GREEN phase will add the runtime artifacts to make them pass.
 *
 * @file test/sdk/public-contract.test.ts
 */

import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// 1. Package subpath resolution — exports map
// ---------------------------------------------------------------------------

describe("SDK package subpath resolution", () => {
  test("open-agent-sessions/sdk subpath resolves via exports map", async () => {
    // The package.json "exports" field must include "./sdk" subpath.
    // This import must resolve without error.
    const sdk = await import("open-agent-sessions/sdk");
    expect(sdk).toBeDefined();
    expect(typeof sdk).toBe("object");
  });

  test("SDK exports map includes ./types subpath for type-only consumers", async () => {
    // Consumers who only need types (no runtime deps) import from ./types
    const types = await import("open-agent-sessions/types");
    expect(types).toBeDefined();
  });

  test("SDK contract version is exported as runtime constant", async () => {
    // The SDK must export a contract version for consumers to pin against.
    // This enables lock-step versioning (oas-stats locks to exact oas version).
    const sdk = await import("open-agent-sessions/sdk");
    expect(sdk.SDK_CONTRACT_VERSION).toBeDefined();
    expect(typeof sdk.SDK_CONTRACT_VERSION).toBe("string");
    // Semver format: major.minor.patch
    expect(sdk.SDK_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ---------------------------------------------------------------------------
// 2. Exact six type exports — runtime artifacts
// ---------------------------------------------------------------------------

describe("SDK six core type exports", () => {
  test("exports exactly six core type guard functions", async () => {
    // The SDK must export runtime type guards for the six core types.
    // These enable consumers to validate data shapes at runtime (not just compile-time).
    const sdk = await import("open-agent-sessions/sdk");

    const requiredGuards = [
      "isAdapter",
      "isSessionSummary",
      "isSessionDetail",
      "isSessionReadOptions",
      "isSearchQuery",
      "isTimeRangeOptions",
    ];

    for (const guardName of requiredGuards) {
      expect(sdk[guardName]).toBeDefined();
      expect(typeof sdk[guardName]).toBe("function");
    }

    // Ensure no extra type guards are exported (exactly six)
    const exportedGuards = Object.keys(sdk).filter((k) => k.startsWith("is"));
    expect(exportedGuards.length).toBe(6);
  });

  test("isSessionDetail validates pinned shape", async () => {
    const sdk = await import("open-agent-sessions/sdk");

    // Valid SessionDetail must pass
    const validDetail = {
      id: "test-session-id",
      agent: "opencode",
      alias: "main",
      title: "Test Session",
      created_at: "2026-08-04T00:00:00Z",
      updated_at: "2026-08-04T01:00:00Z",
      message_count: 10,
      storage: "db",
      messages: [],
    };
    expect(sdk.isSessionDetail(validDetail)).toBe(true);

    // Invalid SessionDetail (missing required field) must fail
    const invalidDetail = { id: "test", agent: "opencode" };
    expect(sdk.isSessionDetail(invalidDetail)).toBe(false);
  });

  test("isAdapter validates Adapter interface shape", async () => {
    const sdk = await import("open-agent-sessions/sdk");

    // Minimal valid Adapter
    const validAdapter = {
      version: "1.0.0",
      listSessions: () => [],
    };
    expect(sdk.isAdapter(validAdapter)).toBe(true);

    // Invalid Adapter (missing required method)
    const invalidAdapter = { version: "1.0.0" };
    expect(sdk.isAdapter(invalidAdapter)).toBe(false);
  });

  test("isSessionSummary validates SessionSummary shape", async () => {
    const sdk = await import("open-agent-sessions/sdk");

    const validSummary = {
      id: "sess-123",
      agent: "claude",
      alias: "main",
      title: "Test",
      created_at: "2026-08-04T00:00:00Z",
      updated_at: "2026-08-04T01:00:00Z",
      message_count: 5,
      storage: "jsonl",
    };
    expect(sdk.isSessionSummary(validSummary)).toBe(true);

    const invalidSummary = { id: "sess-123" };
    expect(sdk.isSessionSummary(invalidSummary)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Pinned SessionDetail shape
// ---------------------------------------------------------------------------

describe("Pinned SessionDetail shape", () => {
  test("SessionDetail required fields are exported as constant", async () => {
    // The SDK must export the exact field set for SessionDetail.
    // This allows consumers to validate data and detect schema drift.
    const sdk = await import("open-agent-sessions/sdk");

    expect(sdk.SESSION_DETAIL_FIELDS).toBeDefined();
    expect(Array.isArray(sdk.SESSION_DETAIL_FIELDS)).toBe(true);

    // Pinned field set (from src/core/types.ts SessionDetail interface)
    const expectedFields = [
      "id",
      "agent",
      "alias",
      "title",
      "created_at",
      "updated_at",
      "message_count",
      "storage",
      "messages",
      "clone",
      "warning",
    ];

    expect(sdk.SESSION_DETAIL_FIELDS.sort()).toEqual(expectedFields.sort());
  });

  test("SessionDetail extends SessionSummary (inherits base fields)", async () => {
    const sdk = await import("open-agent-sessions/sdk");

    // SessionDetail must include all SessionSummary fields
    const sessionSummaryFields = [
      "id",
      "agent",
      "alias",
      "title",
      "created_at",
      "updated_at",
      "message_count",
      "storage",
    ];

    for (const field of sessionSummaryFields) {
      expect(sdk.SESSION_DETAIL_FIELDS).toContain(field);
    }
  });

  test("SessionDetail optional fields are marked in metadata", async () => {
    const sdk = await import("open-agent-sessions/sdk");

    // SDK must export which fields are optional
    expect(sdk.SESSION_DETAIL_OPTIONAL_FIELDS).toBeDefined();
    expect(Array.isArray(sdk.SESSION_DETAIL_OPTIONAL_FIELDS)).toBe(true);

    // Optional fields (from SessionDetail interface)
    const optionalFields = ["clone", "warning", "messages"];
    expect(sdk.SESSION_DETAIL_OPTIONAL_FIELDS.sort()).toEqual(optionalFields.sort());
  });
});

// ---------------------------------------------------------------------------
// 4. Consumer import resolution fixture
// ---------------------------------------------------------------------------

describe("Consumer import resolution fixture", () => {
  test("consumer can import all six core types from sdk subpath", async () => {
    // This test simulates how oas-command-stats would import the SDK.
    // Pattern: import { Type1, Type2, ... } from "open-agent-sessions/sdk"
    const sdk = await import("open-agent-sessions/sdk");

    // All six core type guards must be importable
    const {
      isAdapter,
      isSessionSummary,
      isSessionDetail,
      isSessionReadOptions,
      isSearchQuery,
      isTimeRangeOptions,
    } = sdk;

    expect(isAdapter).toBeDefined();
    expect(isSessionSummary).toBeDefined();
    expect(isSessionDetail).toBeDefined();
    expect(isSessionReadOptions).toBeDefined();
    expect(isSearchQuery).toBeDefined();
    expect(isTimeRangeOptions).toBeDefined();
  });

  test("consumer can import SessionDetail shape metadata", async () => {
    // Consumer needs to validate SessionDetail at runtime (e.g., after parsing)
    const sdk = await import("open-agent-sessions/sdk");

    const { SESSION_DETAIL_FIELDS, SESSION_DETAIL_OPTIONAL_FIELDS } = sdk;

    expect(SESSION_DETAIL_FIELDS).toBeDefined();
    expect(SESSION_DETAIL_OPTIONAL_FIELDS).toBeDefined();
  });

  test("consumer can import SDK contract version for pinning", async () => {
    // Consumer locks to exact SDK version to prevent silent breaking changes
    const sdk = await import("open-agent-sessions/sdk");

    const { SDK_CONTRACT_VERSION } = sdk;

    expect(SDK_CONTRACT_VERSION).toBeDefined();
    expect(typeof SDK_CONTRACT_VERSION).toBe("string");
  });

  test("consumer import pattern: type-safe session detail validation", async () => {
    // Simulate oas-command-stats ingestion pattern:
    // 1. Import SDK
    // 2. Fetch session detail via adapter
    // 3. Validate shape before processing
    const sdk = await import("open-agent-sessions/sdk");

    const { isSessionDetail, SESSION_DETAIL_FIELDS } = sdk;

    // Mock session detail from adapter
    const mockDetail = {
      id: "abc-123",
      agent: "pi",
      alias: "omo",
      title: "Test Session",
      created_at: "2026-08-04T00:00:00Z",
      updated_at: "2026-08-04T01:00:00Z",
      message_count: 42,
      storage: "jsonl",
      messages: [],
    };

    // Validate shape
    expect(isSessionDetail(mockDetail)).toBe(true);

    // Ensure all required fields present
    for (const field of SESSION_DETAIL_FIELDS) {
      if (!sdk.SESSION_DETAIL_OPTIONAL_FIELDS.includes(field)) {
        expect(mockDetail).toHaveProperty(field);
      }
    }
  });
});
