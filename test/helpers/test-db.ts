import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestSession {
  id: string;
  title: string;
  timeCreated: number;
  timeUpdated: number;
  messageCount: number;
  hasTools?: boolean;
}

export interface TestMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  timeCreated: number;
  text: string;
}

export interface TestPart {
  id: string;
  messageId: string;
  sessionId: string;
  type: "text" | "tool";
  content: Record<string, unknown>;
  timeCreated: number;
}

export class TestDatabase {
  private db: Database;
  private tempDir: string;
  public dbPath: string;
  public cwd: string;
  public projectId: string;

  constructor() {
    this.tempDir = join(tmpdir(), `oas-integration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(this.tempDir, { recursive: true });
    this.dbPath = join(this.tempDir, "opencode.db");
    this.cwd = join(this.tempDir, "project");
    mkdirSync(this.cwd, { recursive: true });
    this.projectId = "test-project-001";
    
    this.db = new Database(this.dbPath);
    this.initializeSchema();
    this.seedProject();
  }

  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL,
        vcs TEXT,
        name TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )
    `);

    this.db.run(`
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

    this.db.run(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);

    // Create indexes for time-based queries optimization
    // Session indexes for time-based filtering and sorting
    this.db.run(`
      CREATE INDEX idx_session_time_updated ON session(time_updated)
    `);
    this.db.run(`
      CREATE INDEX idx_session_time_created ON session(time_created)
    `);
    // Composite index for project_id + time_updated (common query pattern)
    this.db.run(`
      CREATE INDEX idx_session_project_time ON session(project_id, time_updated)
    `);

    // Message indexes for time-based ordering
    this.db.run(`
      CREATE INDEX idx_message_time_created ON message(time_created)
    `);
    // Composite index for session_id + time_created (common query pattern)
    this.db.run(`
      CREATE INDEX idx_message_session_time ON message(session_id, time_created)
    `);

    // Part indexes for time-based ordering
    this.db.run(`
      CREATE INDEX idx_part_time_created ON part(time_created)
    `);
    // Composite index for message_id + time_created (common query pattern)
    this.db.run(`
      CREATE INDEX idx_part_message_time ON part(message_id, time_created)
    `);
  }

  private seedProject(): void {
    this.db.run(
      `INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)`,
      [this.projectId, this.cwd, Date.now(), Date.now()]
    );
  }

  addSession(session: TestSession): void {
    this.db.run(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        this.projectId,
        session.id.slice(0, 8),
        this.cwd,
        session.title,
        "v1",
        session.timeCreated,
        session.timeUpdated,
      ]
    );

    // Add messages
    for (let i = 0; i < session.messageCount; i++) {
      const msgId = `${session.id}-msg-${i}`;
      const role = i % 2 === 0 ? "user" : "assistant";
      const timeCreated = session.timeCreated + i * 1000; // 1 second apart
      
      this.addMessage({
        id: msgId,
        sessionId: session.id,
        role: session.hasTools && i % 3 === 2 ? "tool" : role,
        timeCreated,
        text: `Message ${i + 1} in session ${session.title}`,
      });
    }
  }

  addMessage(message: TestMessage): void {
    const data = JSON.stringify({
      role: message.role,
      time: { created: message.timeCreated },
    });
    
    this.db.run(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
      [message.id, message.sessionId, message.timeCreated, message.timeCreated, data]
    );

    // Add a text part for the message
    this.addPart({
      id: `${message.id}-part-1`,
      messageId: message.id,
      sessionId: message.sessionId,
      type: message.role === "tool" ? "tool" : "text",
      content: message.role === "tool" 
        ? { tool: "test_tool", state: { status: "completed" } }
        : { type: "text", text: message.text },
      timeCreated: message.timeCreated,
    });
  }

  addPart(part: TestPart): void {
    const data = JSON.stringify(part.content);
    this.db.run(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
      [part.id, part.messageId, part.sessionId, part.timeCreated, part.timeCreated, data]
    );
  }

  close(): void {
    this.db.close();
    rmSync(this.tempDir, { recursive: true, force: true });
  }

  getConfig(): { dbPath: string; cwd: string; projectId: string } {
    return {
      dbPath: this.dbPath,
      cwd: this.cwd,
      projectId: this.projectId,
    };
  }

  /**
   * Create a config file in the test directory that points to the test database
   */
  createConfigFile(): string {
    const configPath = join(this.cwd, "oas.config.yaml");
    const configContent = `agents:
  - agent: opencode
    alias: default
    enabled: true
    storage:
      mode: db
      db_path: ${this.dbPath}
`;
    writeFileSync(configPath, configContent, "utf-8");
    return configPath;
  }
}

/**
 * Create a test database with pre-populated sessions
 */
export function createTestDatabaseWithSessions(sessions: TestSession[]): TestDatabase {
  const testDb = new TestDatabase();
  
  for (const session of sessions) {
    testDb.addSession(session);
  }
  
  return testDb;
}

/**
 * Helper to create timestamps relative to now
 */
export function hoursAgo(hours: number): number {
  return Date.now() - hours * 60 * 60 * 1000;
}

export function daysAgo(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

export function minutesAgo(minutes: number): number {
  return Date.now() - minutes * 60 * 1000;
}

/**
 * Helper to create ISO timestamp strings
 */
export function toISO(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Helper to setup test database and config for integration tests
 */
export function setupTestDatabase(sessions: TestSession[]): TestDatabase {
  const testDb = createTestDatabaseWithSessions(sessions);
  testDb.createConfigFile();
  return testDb;
}
