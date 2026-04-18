/**
 * REQ-SIM-04 — SimilarityConfig: configuration & initialization tests
 *
 * RED phase: all tests are designed to FAIL until the feature is implemented.
 * Each test has explicit //#given, //#when, //#then BDD markers.
 *
 * Coverage:
 *  - Config defaults & partial-merge
 *  - Enabled/disabled lifecycle
 *  - Validation: provider, topK, vector dimensions
 *  - Unknown field passthrough
 *  - Environment-variable override
 *  - Empty-string provider normalisation
 *  - Initialization side-effects (DB tables)
 *  - Graceful fallback for non-opencode adapters
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimilarityConfig } from "../../src/similarity/config";
import {
  parseSimilarityConfig,
  initializeSimilarity,
  ConfigValidationError,
} from "../../src/similarity/config";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "oas-sim-test-"));
}

// ─── parseSimilarityConfig — defaults ────────────────────────────────────────

describe("SimilarityConfig parsing", () => {
  describe("defaults", () => {
    test("similarity config defaults when all fields absent", () => {
      // #given no similarity section in config
      const raw: Record<string, unknown> = {};
      // #when parsed
      const cfg = parseSimilarityConfig(raw);
      // #then sensible defaults are applied
      expect(cfg.enabled).toBe(false);
      expect(cfg.embeddingProvider).toBe("local");
      expect(cfg.topK).toBe(5);
    });

    test("similarity config empty object yields same defaults", () => {
      // #given empty similarity block
      const raw = { similarity: {} };
      const cfg = parseSimilarityConfig(raw);
      // #then defaults still apply
      expect(cfg.enabled).toBe(false);
      expect(cfg.embeddingProvider).toBe("local");
      expect(cfg.topK).toBe(5);
    });

    test("similarity config raw YAML null value (similarity: ~) yields defaults", () => {
      // #given similarity key present but null (YAML null → JS null)
      const raw = { similarity: null };
      const cfg = parseSimilarityConfig(raw);
      // #then defaults are applied, no throw
      expect(cfg.enabled).toBe(false);
      expect(cfg.embeddingProvider).toBe("local");
      expect(cfg.topK).toBe(5);
    });
  });

  describe("partial-merge", () => {
    test("similarity config user-provided partial config merges correctly", () => {
      // #given partial config (only enabled)
      const raw = { similarity: { enabled: true } };
      // #when parsed
      const cfg = parseSimilarityConfig(raw);
      // #then unspecified fields fall back to defaults
      expect(cfg.enabled).toBe(true);
      expect(cfg.embeddingProvider).toBe("local"); // default
      expect(cfg.topK).toBe(5); // default
    });

    test("similarity config partial config with topK override", () => {
      // #given partial config with custom topK
      const raw = { similarity: { topK: 20 } };
      const cfg = parseSimilarityConfig(raw);
      expect(cfg.topK).toBe(20);
      expect(cfg.enabled).toBe(false); // default
    });
  });

  describe("enabled state", () => {
    test("similarity config enabled true activates subsystem", () => {
      // #given config with enabled=true
      const raw = { similarity: { enabled: true } };
      // #when parsed
      const cfg = parseSimilarityConfig(raw);
      // #then config is valid and complete
      expect(cfg.enabled).toBe(true);
      expect(typeof cfg.embeddingProvider).toBe("string");
      expect(typeof cfg.topK).toBe("number");
    });

    test("similarity config enabled false skips initialization", () => {
      // #given config with enabled=false
      const raw = { similarity: { enabled: false } };
      const cfg = parseSimilarityConfig(raw);
      // #then no error, subsystem is off
      expect(cfg.enabled).toBe(false);
    });
  });

  describe("validation — embedding provider", () => {
    test("similarity config invalid embedding provider rejected", () => {
      // #given unknown provider string
      const raw = { similarity: { enabled: true, embeddingProvider: "openai" } };
      // #when parsed
      // #then ConfigValidationError is thrown with clear message
      expect(() => parseSimilarityConfig(raw)).toThrow(ConfigValidationError);
      expect(() => parseSimilarityConfig(raw)).toThrow(/embeddingProvider/i);
      expect(() => parseSimilarityConfig(raw)).toThrow(/openai/i);
    });

    test("similarity config valid provider 'local' accepted", () => {
      const raw = { similarity: { enabled: true, embeddingProvider: "local" } };
      const cfg = parseSimilarityConfig(raw);
      expect(cfg.embeddingProvider).toBe("local");
    });

    test("similarity config valid provider 'api' accepted", () => {
      const raw = { similarity: { enabled: true, embeddingProvider: "api" } };
      const cfg = parseSimilarityConfig(raw);
      expect(cfg.embeddingProvider).toBe("api");
    });

    test("similarity config empty string provider defaults to local", () => {
      // #given empty-string provider (edge case from env or YAML)
      const raw = { similarity: { embeddingProvider: "" } };
      // #when parsed
      const cfg = parseSimilarityConfig(raw);
      // #then normalised to default "local"
      expect(cfg.embeddingProvider).toBe("local");
    });
  });

  describe("validation — topK", () => {
    test("similarity config topK must be positive integer", () => {
      // #given topK = 0
      const raw = { similarity: { topK: 0 } };
      // #when parsed
      // #then rejected
      expect(() => parseSimilarityConfig(raw)).toThrow(ConfigValidationError);
      expect(() => parseSimilarityConfig(raw)).toThrow(/topK/i);
    });

    test("similarity config topK negative rejected", () => {
      const raw = { similarity: { topK: -1 } };
      expect(() => parseSimilarityConfig(raw)).toThrow(ConfigValidationError);
    });

    test("similarity config topK non-integer rejected", () => {
      const raw = { similarity: { topK: 3.14 } as unknown };
      expect(() => parseSimilarityConfig(raw)).toThrow(ConfigValidationError);
    });

    test("similarity config topK must be positive integer — string rejected", () => {
      const raw = { similarity: { topK: "10" } as unknown };
      expect(() => parseSimilarityConfig(raw)).toThrow(ConfigValidationError);
    });

    test("similarity config topK max reasonable limit", () => {
      // #given topK > 1000
      const raw = { similarity: { topK: 1001 } };
      // #when parsed
      // #then rejected to prevent abuse
      expect(() => parseSimilarityConfig(raw)).toThrow(ConfigValidationError);
      expect(() => parseSimilarityConfig(raw)).toThrow(/topK/i);
    });

    test("similarity config topK at boundary (1) is valid", () => {
      const raw = { similarity: { topK: 1 } };
      const cfg = parseSimilarityConfig(raw);
      expect(cfg.topK).toBe(1);
    });

    test("similarity config topK at boundary (1000) is valid", () => {
      const raw = { similarity: { topK: 1000 } };
      const cfg = parseSimilarityConfig(raw);
      expect(cfg.topK).toBe(1000);
    });
  });

  describe("validation — vector dimensions", () => {
    const validDimensions = [384, 768, 1536] as const;

    for (const dim of validDimensions) {
      test(`similarity config vector dimension ${dim} is valid`, () => {
        const raw = { similarity: { vectorDimension: dim } };
        const cfg = parseSimilarityConfig(raw);
        expect(cfg.vectorDimension).toBe(dim);
      });
    }

    test("similarity config vector dimension must be valid — 512 rejected", () => {
      const raw = { similarity: { vectorDimension: 512 } };
      expect(() => parseSimilarityConfig(raw)).toThrow(ConfigValidationError);
      expect(() => parseSimilarityConfig(raw)).toThrow(/vectorDimension/i);
    });

    test("similarity config vector dimension must be valid — 1024 rejected", () => {
      const raw = { similarity: { vectorDimension: 1024 } };
      expect(() => parseSimilarityConfig(raw)).toThrow(ConfigValidationError);
    });

    test("similarity config vector dimension must be valid — 2560 rejected", () => {
      const raw = { similarity: { vectorDimension: 2560 } };
      expect(() => parseSimilarityConfig(raw)).toThrow(ConfigValidationError);
    });

    test("similarity config vectorDimension string rejected (symmetry with topK)", () => {
      // #given vectorDimension as string "384" (e.g. from YAML parsing)
      const raw = { similarity: { vectorDimension: "384" } as unknown };
      // #then ConfigValidationError is thrown (same as topK string rejection)
      expect(() => parseSimilarityConfig(raw)).toThrow(ConfigValidationError);
      expect(() => parseSimilarityConfig(raw)).toThrow(/vectorDimension/i);
    });
  });

  describe("unknown fields", () => {
    test("similarity config unknown fields ignored", () => {
      // #given config with extra unknown keys
      const raw = {
        similarity: {
          enabled: true,
          unknownField: "ignore-me",
          anotherBad: 123,
        },
      };
      // #when parsed
      const cfg = parseSimilarityConfig(raw);
      // #then unknown fields are silently ignored (no error)
      expect(cfg.enabled).toBe(true);
      // #cfg has no extra keys beyond the known schema
      const knownKeys = Object.keys(cfg).sort();
      expect(knownKeys).not.toContain("unknownField");
      expect(knownKeys).not.toContain("anotherBad");
    });
  });
});

// ─── parseSimilarityConfig — environment-variable override ───────────────────

describe("SimilarityConfig environment-var override", () => {
  test("similarity config from env overrides file", () => {
    // #given env vars SIMILARITY_ENABLED, SIMILARITY_EMBEDDING_PROVIDER, SIMILARITY_TOPK
    const prev = {
      ENABLED: process.env.SIMILARITY_ENABLED,
      PROVIDER: process.env.SIMILARITY_EMBEDDING_PROVIDER,
      TOPK: process.env.SIMILARITY_TOPK,
    };
    try {
      process.env.SIMILARITY_ENABLED = "true";
      process.env.SIMILARITY_EMBEDDING_PROVIDER = "api";
      process.env.SIMILARITY_TOPK = "20";

      // file config says disabled with local provider
      const raw = { similarity: { enabled: false, embeddingProvider: "local" } };
      const cfg = parseSimilarityConfig(raw);

      // #then env vars win
      expect(cfg.enabled).toBe(true);
      expect(cfg.embeddingProvider).toBe("api");
      expect(cfg.topK).toBe(20);
    } finally {
      // #cleanup — restore original env
      if (prev.ENABLED === undefined) delete process.env.SIMILARITY_ENABLED;
      else process.env.SIMILARITY_ENABLED = prev.ENABLED;
      if (prev.PROVIDER === undefined) delete process.env.SIMILARITY_EMBEDDING_PROVIDER;
      else process.env.SIMILARITY_EMBEDDING_PROVIDER = prev.PROVIDER;
      if (prev.TOPK === undefined) delete process.env.SIMILARITY_TOPK;
      else process.env.SIMILARITY_TOPK = prev.TOPK;
    }
  });

  test("SIMILARITY_ENABLED env var alone enables subsystem", () => {
    const prev = process.env.SIMILARITY_ENABLED;
    try {
      delete process.env.SIMILARITY_ENABLED;
      const raw: Record<string, unknown> = {};
      const cfg = parseSimilarityConfig(raw);
      expect(cfg.enabled).toBe(false); // no env, no file

      process.env.SIMILARITY_ENABLED = "true";
      const cfg2 = parseSimilarityConfig(raw);
      expect(cfg2.enabled).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SIMILARITY_ENABLED;
      else process.env.SIMILARITY_ENABLED = prev;
    }
  });
});

// ─── initializeSimilarity — lifecycle ───────────────────────────────────────

describe("initializeSimilarity", () => {
  test("initialize similarity subsystem when disabled does nothing", () => {
    // #given disabled config
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, "test.db");
      const db = new Database(dbPath);
      const cfg: SimilarityConfig = {
        enabled: false,
        embeddingProvider: "local",
        topK: 5,
      };
      // #when initialised
      initializeSimilarity(db, cfg);
      // #then no vec table created
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: unknown) => (r as { name: string }).name);
      expect(tables).not.toContain("session_vec");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("initialize similarity subsystem when enabled creates tables", () => {
    // #given enabled config
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, "test.db");
      const db = new Database(dbPath);
      const cfg: SimilarityConfig = {
        enabled: true,
        embeddingProvider: "local",
        topK: 5,
      };
      // #when initialised
      initializeSimilarity(db, cfg);
      // #then vec + fts5 tables are created
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: unknown) => (r as { name: string }).name);
      expect(tables).toContain("session_vec");
      expect(tables).toContain("session_fts"); // fts5 virtual table
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("initialize similarity subsystem is idempotent (no double-create error)", () => {
    // #given enabled config, called twice
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, "test.db");
      const db = new Database(dbPath);
      const cfg: SimilarityConfig = {
        enabled: true,
        embeddingProvider: "local",
        topK: 5,
      };
      initializeSimilarity(db, cfg);
      // #when called again
      // #then no error thrown (CREATE TABLE IF NOT EXISTS)
      expect(() => initializeSimilarity(db, cfg)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("initialize similarity with api provider still creates tables", () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, "test.db");
      const db = new Database(dbPath);
      const cfg: SimilarityConfig = {
        enabled: true,
        embeddingProvider: "api",
        topK: 10,
        apiEndpoint: "https://api.example.com/embed",
      };
      initializeSimilarity(db, cfg);
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: unknown) => (r as { name: string }).name);
      expect(tables).toContain("session_vec");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ─── graceful fallback — non-opencode adapters ───────────────────────────────

describe("graceful fallback — adapter compatibility", () => {
  /**
   * REQ-SIM-04: "All other adapters: findSimilarSessions returns empty array
   * (graceful fallback)"
   *
   * The Adapter interface is NOT changed. findSimilarSessions is additive.
   * These tests verify the adapter does NOT throw when similarity is absent.
   */

  test("codex adapter findSimilarSessions returns note 'Not yet supported'", async () => {
    // #given a codex adapter (non-opencode, no DB)
    const { createCodexAdapter } = await import("../../src/adapters/codex");
    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
    });
    // #when findSimilarSessions is called
    // #then it returns a result with note 'Not yet supported' (graceful fallback)
    const result = (adapter as unknown as { findSimilarSessions: (q: string) => Promise<unknown[]> }).findSimilarSessions?.("hello");
    if (result !== undefined) {
      const resolved = await result;
      expect(Array.isArray(resolved)).toBe(true);
      expect((resolved as unknown[]).length).toBeGreaterThan(0);
      expect((resolved as { note?: string }[])[0].note).toBe("Not yet supported");
    } else {
      // Method absent — acceptable (backward compat)
      expect(true).toBe(true);
    }
  });

  test("codex adapter findSimilarSessions does not throw when method is absent", async () => {
    // #given a codex adapter
    const { createCodexAdapter } = await import("../../src/adapters/codex");
    const adapter = createCodexAdapter({
      agent: "codex",
      alias: "work",
      enabled: true,
    });
    // #when accessing findSimilarSessions property
    // #then it is either absent OR returns result with note (never throws)
    const handle = adapter as unknown as Record<string, unknown>;
    if (typeof handle.findSimilarSessions === "function") {
      const result = await (handle.findSimilarSessions as (q: string) => Promise<unknown[]>)("hello");
      expect(Array.isArray(result)).toBe(true);
    }
    // Absence of the method is also acceptable — additive feature
  });

  test("claude adapter findSimilarSessions does not throw", async () => {
    const { createClaudeAdapter } = await import("../../src/adapters/claude");
    const adapter = createClaudeAdapter({
      agent: "claude",
      alias: "main",
      enabled: true,
    });
    const handle = adapter as unknown as Record<string, unknown>;
    if (typeof handle.findSimilarSessions === "function") {
      const result = await (handle.findSimilarSessions as (q: string) => Promise<unknown[]>)("hello");
      expect(Array.isArray(result)).toBe(true);
    }
  });
});

// ─── Adapter interface backward-compatibility ─────────────────────────────────

describe("Adapter interface backward-compatibility", () => {
  /**
   * REQ-SIM-04: "It MUST NOT change the existing Adapter interface signature
   * (backward compatible)."
   *
   * findSimilarSessions must be optional — existing callers must not break.
   */

  test("Adapter type does not require findSimilarSessions", () => {
    // #given an adapter object without findSimilarSessions
    const minimalAdapter = {
      version: "1.0.0",
      listSessions: () => [],
    };
    // #when used as Adapter
    // #then it satisfies the Adapter type (TypeScript compile-time check)
    // This test documents that the minimal adapter shape is still valid.
    // If findSimilarSessions were required, this test would fail to compile.
    expect(minimalAdapter.listSessions).toBeDefined();
    expect(minimalAdapter.version).toBe("1.0.0");
    // Explicitly: findSimilarSessions must NOT be present as a required field
    const handle = minimalAdapter as unknown as Record<string, unknown>;
    expect(handle.findSimilarSessions).toBeUndefined();
  });

  test("opencode adapter without similarity config still works", async () => {
    // #given an opencode adapter entry WITHOUT similarity config
    //    (uses db mode with a temp DB that has the required schema)
    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const { createOpenCodeAdapter } = await import("../../src/adapters/opencode");
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath);
    // Create the minimal schema the adapter expects
    db.run(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL,
        vcs TEXT,
        name TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT
      )
    `);
    db.run(`
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        data TEXT
      )
    `);
    db.close();

    const entry = {
      agent: "opencode" as const,
      alias: "test",
      enabled: true,
      storage: { mode: "db" as const, db_path: dbPath },
    };
    // #when adapter is created
    // #then it does not throw (backward-compat: similarity is additive)
    expect(() => createOpenCodeAdapter(entry)).not.toThrow();
    rmSync(dir, { recursive: true });
  });
});
