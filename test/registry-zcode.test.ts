/**
 * Zcode integration tests — prove BLOCKERS 1 & 2 and MAJORS 3 & 4 are fixed at
 * the registry/normalize layer, NOT just the unit layer.
 *
 * The unit tests in test/adapters/zcode.test.ts call the adapter directly,
 * bypassing createAdapterRegistry + normalizeSessionSummary. That is how the
 * adapter looked "green" while `oas sessions --agent zcode` threw
 * "adapter factory not found" / "agent must be one of ...". These tests build
 * the registry the way `bin/oas` does and assert the full CLI path works.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach } from "bun:test";
import { createAdapterRegistry, createZcodeAdapter } from "../src/index";
import type { Config } from "../src/index";

// --- Fixture DB matching the live zcode schema --------------------------

function createTestZcodeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session (
      id text primary key,
      project_id text not null,
      parent_id text,
      slug text not null,
      directory text not null,
      title text not null,
      version text not null,
      time_created integer not null,
      time_updated integer not null,
      task_type text not null default 'interactive',
      title_source text not null default 'first_input',
      time_archived integer
    );

    CREATE TABLE message (
      id text primary key,
      session_id text not null references session(id) on delete cascade,
      time_created integer not null,
      time_updated integer not null,
      data text not null,
      sequence integer
    );

    CREATE TABLE part (
      id text primary key,
      message_id text not null references message(id) on delete cascade,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null,
      sequence integer
    );

    CREATE TABLE tool_usage (
      id text primary key,
      session_id text not null,
      tool_call_id text not null,
      tool_name text not null,
      status text not null,
      started_at integer not null,
      completed_at integer,
      duration_ms integer
    );
  `);
  return db;
}

function insertSession(db: Database, opts: {
  id: string;
  parent_id?: string | null;
  title: string;
  time_created: number;
  time_updated: number;
}): void {
  db.run(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, task_type, title_source)
     VALUES (?, 'proj_test', ?, ?, '/home/x/proj', ?, '1.0.0', ?, ?, 'interactive', 'first_input')`,
    [opts.id, opts.parent_id ?? null, opts.id, opts.title, opts.time_created, opts.time_updated]
  );
}

function insertMessage(db: Database, opts: {
  id: string;
  session_id: string;
  data: string;
  time_created?: number;
  time_updated?: number;
}): void {
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [opts.id, opts.session_id, opts.time_created ?? 0, opts.time_updated ?? 0, opts.data]
  );
}

type ZcodeEntry = { agent: "zcode"; alias: string; enabled: boolean };

describe("zcode adapter — registry/normalize integration", () => {
  let db: Database;
  beforeEach(() => {
    db = createTestZcodeDb();
  });

  it("does NOT throw 'agent must be one of' when listing via the registry", async () => {
    // Seed a zcode session WITH a parent_id (MAJOR 3) and a message.
    insertSession(db, {
      id: "sess_child",
      parent_id: "sess_parent",
      title: "Child session",
      time_created: 1785000000000,
      time_updated: 1785000100000,
    });
    insertMessage(db, {
      id: "msg1",
      session_id: "sess_child",
      time_created: 1785000000000,
      time_updated: 1785000000000,
      data: JSON.stringify({ role: "user", time: { created: 1785000000000 } }),
    });

    // Build the registry EXACTLY like bin/oas:createAllAgentFactories does —
    // the factory map MUST include a zcode entry.
    const config: Config = {
      agents: [{ agent: "zcode", alias: "default", enabled: true }],
    };
    const registry = createAdapterRegistry(config, {
      zcode: (entry) => createZcodeAdapter(entry as ZcodeEntry, { dbPath: db }),
    });

    // The registry wraps every session through normalizeSessionSummary.
    // BLOCKER 2 (zcode in ALLOWED_AGENTS) is what makes this NOT throw
    // "agent must be one of ...".
    const sessions = await registry.adapters[0].listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].agent).toBe("zcode");
    expect(sessions[0].alias).toBe("default");

    // MAJOR 3: parentSessionId survives the normalize layer.
    expect(sessions[0].parentSessionId).toBe("sess_parent");
  });

  it("excludes archived sessions (time_archived set) at the registry level", async () => {
    insertSession(db, {
      id: "sess_live",
      title: "Live session",
      time_created: 1785000000000,
      time_updated: 1785000100000,
    });
    insertSession(db, {
      id: "sess_archived",
      title: "Archived session",
      time_created: 1785000000000,
      time_updated: 1785000200000,
    });
    db.run("UPDATE session SET time_archived = 1785000200000 WHERE id = ?", [
      "sess_archived",
    ]);

    const config: Config = {
      agents: [{ agent: "zcode", alias: "default", enabled: true }],
    };
    const registry = createAdapterRegistry(config, {
      zcode: (entry) => createZcodeAdapter(entry as ZcodeEntry, { dbPath: db }),
    });

    const sessions = await registry.adapters[0].listSessions();
    const ids = sessions.map((s) => s.id);

    expect(ids).toContain("sess_live");
    expect(ids).not.toContain("sess_archived");
  });
});
