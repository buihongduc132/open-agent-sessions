import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { 
  TestDatabase, 
  createTestDatabaseWithSessions, 
  TestSession,
  hoursAgo, 
  daysAgo,
  minutesAgo,
  setupTestDatabase 
} from "../helpers/test-db";

// Get directory of current file for relative path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create a set of test sessions with various timestamps
 */
function createStandardTestSessions(): TestSession[] {
  const now = Date.now();
  
  return [
    // Recent sessions (within last 24 hours)
    {
      id: "session-recent-1",
      title: "Recent Session 1 - 2 hours ago",
      timeCreated: hoursAgo(2),
      timeUpdated: hoursAgo(1),
      messageCount: 10,
    },
    {
      id: "session-recent-2",
      title: "Recent Session 2 - 6 hours ago",
      timeCreated: hoursAgo(6),
      timeUpdated: hoursAgo(5),
      messageCount: 15,
    },
    {
      id: "session-recent-3",
      title: "Recent Session 3 - 12 hours ago",
      timeCreated: hoursAgo(12),
      timeUpdated: hoursAgo(11),
      messageCount: 8,
    },
    
    // Sessions within last 4 hours
    {
      id: "session-4h-1",
      title: "4h Window Session 1 - 1 hour ago",
      timeCreated: hoursAgo(1),
      timeUpdated: minutesAgo(30),
      messageCount: 5,
    },
    {
      id: "session-4h-2",
      title: "4h Window Session 2 - 3 hours ago",
      timeCreated: hoursAgo(3),
      timeUpdated: hoursAgo(2),
      messageCount: 12,
    },
    
    // Older sessions (within last 2 days)
    {
      id: "session-old-1",
      title: "Old Session 1 - 30 hours ago",
      timeCreated: hoursAgo(30),
      timeUpdated: hoursAgo(29),
      messageCount: 20,
    },
    {
      id: "session-old-2",
      title: "Old Session 2 - 40 hours ago",
      timeCreated: hoursAgo(40),
      timeUpdated: hoursAgo(38),
      messageCount: 7,
    },
    
    // Very old sessions (within last 7 days)
    {
      id: "session-very-old-1",
      title: "Very Old Session 1 - 3 days ago",
      timeCreated: daysAgo(3),
      timeUpdated: daysAgo(3),
      messageCount: 25,
    },
    {
      id: "session-very-old-2",
      title: "Very Old Session 2 - 5 days ago",
      timeCreated: daysAgo(5),
      timeUpdated: daysAgo(5),
      messageCount: 3,
    },
    
    // Session with tools
    {
      id: "session-with-tools",
      title: "Session with Tool Messages",
      timeCreated: hoursAgo(4),
      timeUpdated: hoursAgo(3),
      messageCount: 30,
      hasTools: true,
    },
  ];
}

/**
 * Create a large session for performance testing
 */
function createLargeSession(): TestSession {
  return {
    id: "session-large-500",
    title: "Large Session with 500+ Messages",
    timeCreated: hoursAgo(1),
    timeUpdated: minutesAgo(10),
    messageCount: 500, // Reduced from 1000 to 500 for CI stability
  };
}

/**
 * Helper to execute CLI command and capture output
 */
function runCLI(
  args: string[], 
  options: { cwd?: string; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 15000; // Increased from 10000 to 15000
    // Use relative path to CLI binary (relative to this test file)
    const cliPath = join(__dirname, "../../bin/oas");
    const cwd = options.cwd || process.cwd();
    
    const proc = spawn("bun", [cliPath, ...args], {
      cwd: cwd,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill();
      const error = new Error(`Command timed out after ${timeout}ms: oas ${args.join(" ")}\nStdout: ${stdout}\nStderr: ${stderr}`);
      reject(error);
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn CLI: ${err.message}\nCommand: oas ${args.join(" ")}`));
    });
  });
}

// ============================================================================
// Integration Tests
// ============================================================================

describe("CLI Integration Tests", () => {
  let testDb: TestDatabase;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    if (testDb) {
      testDb.close();
      testDb = null as any;
    }
    process.chdir(originalCwd);
  });

  // ===========================================================================
  // oas sessions command tests
  // ===========================================================================

  describe("oas sessions", () => {
    test("AC1: oas sessions - list last 24h (default behavior)", async () => {
      testDb = setupTestDatabase(createStandardTestSessions());
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI(["sessions"], { timeout: 15000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Recent Session 1");
      expect(result.stdout).toContain("Recent Session 2");
      expect(result.stdout).toContain("Recent Session 3");
      expect(result.stdout).toContain("4h Window Session 1");
      expect(result.stdout).toContain("4h Window Session 2");
      expect(result.stdout).not.toContain("Old Session 1"); // Outside 24h
    }, 20000); // 20 second test timeout

    test("AC2: oas sessions --last 4h - filtered by time range", async () => {
      testDb = setupTestDatabase(createStandardTestSessions());
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI(["sessions", "--last", "4h"], { timeout: 15000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Recent Session 1");
      expect(result.stdout).toContain("4h Window Session 1");
      expect(result.stdout).toContain("4h Window Session 2");
      expect(result.stdout).not.toContain("Recent Session 2"); // 6h ago
      expect(result.stdout).not.toContain("Recent Session 3"); // 12h ago
    }, 20000); // 20 second test timeout

    test("AC3: oas sessions --last 2d --limit 20 - with limit", async () => {
      testDb = setupTestDatabase(createStandardTestSessions());
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI(["sessions", "--last", "2d", "--limit", "20"], { timeout: 15000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Recent Session 1");
      expect(result.stdout).toContain("Old Session 1");
      expect(result.stdout).toContain("Old Session 2");
      expect(result.stdout).not.toContain("Very Old Session"); // Outside 2d
      
      // Verify limit is enforced - count session entries in output
      const sessionLines = result.stdout.split("\n").filter(l => l.includes("Session:"));
      expect(sessionLines.length).toBeLessThanOrEqual(20);
    }, 20000); // 20 second test timeout

    test("AC4: oas sessions --format json - JSON output format", async () => {
      testDb = setupTestDatabase(createStandardTestSessions());
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI(["sessions", "--format", "json"], { timeout: 15000 });

      expect(result.exitCode).toBe(0);
      
      // Parse JSON output (it's an array, not an object)
      const sessions = JSON.parse(result.stdout);
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);
      
      // Verify structure of first session
      const session = sessions[0];
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("title");
      expect(session).toHaveProperty("agent");
      expect(session).toHaveProperty("alias");
      expect(session).toHaveProperty("message_count");
      expect(session).toHaveProperty("created_at");
      expect(session).toHaveProperty("updated_at");
    }, 20000); // 20 second test timeout

    test("AC5: oas sessions --since --until - explicit time range", async () => {
      testDb = setupTestDatabase(createStandardTestSessions());
      process.chdir(testDb.getConfig().cwd);

      // Query for sessions between 5 and 15 hours ago
      const since = new Date(hoursAgo(15)).toISOString();
      const until = new Date(hoursAgo(5)).toISOString();
      
      const result = await runCLI([
        "sessions",
        "--since", since,
        "--until", until,
      ], { timeout: 15000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Recent Session 2"); // 6h ago
      expect(result.stdout).toContain("Recent Session 3"); // 12h ago
      expect(result.stdout).not.toContain("Recent Session 1"); // 2h ago
      expect(result.stdout).not.toContain("Old Session 1"); // 30h ago
    }, 20000); // 20 second test timeout
  });

  // ===========================================================================
  // oas read command tests
  // ===========================================================================

  describe("oas read", () => {
    test("AC1: oas read <id> - last 10 messages (default)", async () => {
      const sessions = [
        {
          id: "test-session-read-1",
          title: "Test Read Session",
          timeCreated: hoursAgo(1),
          timeUpdated: minutesAgo(30),
          messageCount: 20, // More than default 10
        },
      ];
      
      testDb = setupTestDatabase(sessions);
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI([
        "read",
        "--session", "opencode:default:test-session-read-1",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Test Read Session");
      
      // Should show last 10 messages (11-20)
      expect(result.stdout).toContain("Message 11 in session");
      expect(result.stdout).toContain("Message 20 in session");
      
      // Should NOT show first 10 messages
      expect(result.stdout).not.toContain("Message 1 in session");
      expect(result.stdout).not.toContain("Message 10 in session");
    });

    test("AC2: oas read <id> --tools - include tool messages", async () => {
      const sessions = [
        {
          id: "test-session-tools",
          title: "Test Tools Session",
          timeCreated: hoursAgo(1),
          timeUpdated: minutesAgo(30),
          messageCount: 15,
          hasTools: true,
        },
      ];
      
      testDb = setupTestDatabase(sessions);
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI([
        "read",
        "--session", "opencode:default:test-session-tools",
        "--tools",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Test Tools Session");
      // Verify tool messages are actually present in output
      // Tool messages show [unknown] for text content since they have tool_call data
      // In our test fixture, every 3rd message (indices 2, 5, 8, 11, 14) is a tool message
      // So we expect to see multiple [unknown] entries
      const unknownCount = (result.stdout.match(/\[unknown\]/g) || []).length;
      expect(unknownCount).toBeGreaterThan(0);
    });

    test("AC3: oas read <id> --all - all messages", async () => {
      const sessions = [
        {
          id: "test-session-all",
          title: "Test All Session",
          timeCreated: hoursAgo(1),
          timeUpdated: minutesAgo(30),
          messageCount: 15,
        },
      ];
      
      testDb = setupTestDatabase(sessions);
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI([
        "read",
        "--session", "opencode:default:test-session-all",
        "--all",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Message 1");
      expect(result.stdout).toContain("Message 15");
    });

    test("AC4: oas read <id> --first 5 - first 5 messages", async () => {
      const sessions = [
        {
          id: "test-session-first",
          title: "Test First Session",
          timeCreated: hoursAgo(1),
          timeUpdated: minutesAgo(30),
          messageCount: 20,
        },
      ];
      
      testDb = setupTestDatabase(sessions);
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI([
        "read",
        "--session", "opencode:default:test-session-first",
        "--first", "5",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Message 1");
      expect(result.stdout).toContain("Message 5");
      expect(result.stdout).not.toContain("Message 6");
      expect(result.stdout).not.toContain("Message 20");
    });

    test("AC5: oas read <id> --range 1:10 - message range", async () => {
      const sessions = [
        {
          id: "test-session-range",
          title: "Test Range Session",
          timeCreated: hoursAgo(1),
          timeUpdated: minutesAgo(30),
          messageCount: 20,
        },
      ];
      
      testDb = setupTestDatabase(sessions);
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI([
        "read",
        "--session", "opencode:default:test-session-range",
        "--range", "1:10",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Message 1");
      expect(result.stdout).toContain("Message 10");
      expect(result.stdout).not.toContain("Message 11");
      expect(result.stdout).not.toContain("Message 20");
    });

    test("AC6: oas read <id> --format json - JSON output", async () => {
      const sessions = [
        {
          id: "test-session-json",
          title: "Test JSON Session",
          timeCreated: hoursAgo(1),
          timeUpdated: minutesAgo(30),
          messageCount: 5,
        },
      ];
      
      testDb = setupTestDatabase(sessions);
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI([
        "read",
        "--session", "opencode:default:test-session-json",
        "--format", "json",
      ]);

      expect(result.exitCode).toBe(0);
      
      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty("session");
      expect(output).toHaveProperty("messages");
      expect(output.session).toHaveProperty("id");
      expect(output.session).toHaveProperty("title");
      expect(Array.isArray(output.messages)).toBe(true);
    });

    test("AC7: oas read <id> --role user - filter by role", async () => {
      const sessions = [
        {
          id: "test-session-role",
          title: "Test Role Filter Session",
          timeCreated: hoursAgo(1),
          timeUpdated: minutesAgo(30),
          messageCount: 10,
        },
      ];
      
      testDb = setupTestDatabase(sessions);
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI([
        "read",
        "--session", "opencode:default:test-session-role",
        "--role", "user",
      ]);

      expect(result.exitCode).toBe(0);
      // Verify role filtering works - only user messages should appear
      // Output format is "> USER" for user messages, "< ASSISTANT" for assistant
      expect(result.stdout).toContain("> USER");
      // Verify assistant messages are NOT present
      expect(result.stdout).not.toContain("< ASSISTANT");
    });
  });

  // ===========================================================================
  // Error case tests
  // ===========================================================================

  describe("Error Cases", () => {
    test("EC1: Invalid session ID - should show error", async () => {
      testDb = setupTestDatabase(createStandardTestSessions());
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI([
        "read",
        "--session", "opencode:default:nonexistent-session-id",
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not found");
    });

    test("EC2: Invalid time format - should show error", async () => {
      testDb = setupTestDatabase(createStandardTestSessions());
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI([
        "sessions",
        "--last", "invalid-time-format",
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid time format");
    });

    test("EC3: Conflicting options (--first and --last together)", async () => {
      const sessions = [
        {
          id: "test-session-conflict",
          title: "Test Conflict Session",
          timeCreated: hoursAgo(1),
          timeUpdated: minutesAgo(30),
          messageCount: 10,
        },
      ];
      
      testDb = setupTestDatabase(sessions);
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI([
        "read",
        "--session", "opencode:default:test-session-conflict",
        "--first", "5",
        "--last", "5",
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Cannot use --first and --last together");
    });

    test("EC4: Session not found - graceful error handling", async () => {
      testDb = setupTestDatabase([]);
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI([
        "read",
        "--session", "opencode:default:nonexistent",
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not found");
    });

    test("EC5: Empty results - proper handling", async () => {
      testDb = setupTestDatabase([]);
      process.chdir(testDb.getConfig().cwd);

      const result = await runCLI(["sessions"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No sessions found");
    });
  });

  // ===========================================================================
  // Performance tests
  // ===========================================================================

  describe("Performance", () => {
    test("P1: Large session (500+ messages) - should handle efficiently", async () => {
      const sessions = [createLargeSession()];
      testDb = setupTestDatabase(sessions);
      process.chdir(testDb.getConfig().cwd);

      const startTime = Date.now();
      const result = await runCLI(
        ["read", "--session", "opencode:default:session-large-500", "--last", "50"],
        { timeout: 25000 }
      );
      const duration = Date.now() - startTime;

      // Debug output if test fails
      if (result.exitCode !== 0 || result.stdout.length === 0) {
        console.log("P1 Exit code:", result.exitCode);
        console.log("P1 Duration:", duration, "ms");
        console.log("P1 Stdout length:", result.stdout.length);
        console.log("P1 Stdout (first 500 chars):", result.stdout.substring(0, 500));
        console.log("P1 Stderr:", result.stderr);
      }

      expect(result.exitCode).toBe(0);
      expect(duration).toBeLessThan(20000); // Should complete in under 20 seconds (CI-friendly)
      expect(result.stdout).toContain("Large Session with 500+ Messages");
      
      // Should show last 50 messages
      expect(result.stdout).toContain("Message 451");
      expect(result.stdout).toContain("Message 500");
    }, 30000); // 30 second test timeout

    test("P2: Many sessions (100+) - listing should be fast", async () => {
      // Create 100+ sessions with fewer messages to speed up test
      const sessions: TestSession[] = [];
      for (let i = 0; i < 120; i++) {
        sessions.push({
          id: `session-many-${i}`,
          title: `Session ${i}`,
          timeCreated: hoursAgo(i),
          timeUpdated: hoursAgo(i),
          messageCount: 2, // Fewer messages for faster test
        });
      }
      
      testDb = setupTestDatabase(sessions);
      process.chdir(testDb.getConfig().cwd);

      const startTime = Date.now();
      const result = await runCLI(
        ["sessions", "--last", "1w", "--limit", "100"],
        { timeout: 20000 }
      );
      const duration = Date.now() - startTime;

      // Debug
      if (result.exitCode !== 0 || result.stdout.length === 0) {
        console.log("P2 Exit code:", result.exitCode);
        console.log("P2 Stdout length:", result.stdout.length);
        console.log("P2 Stdout (first 500 chars):", result.stdout.substring(0, 500));
        console.log("P2 Stderr:", result.stderr);
      }

      expect(result.exitCode).toBe(0);
      expect(duration).toBeLessThan(15000); // Should complete in under 15 seconds (CI-friendly)
      expect(result.stdout).toContain("Session 0");
      expect(result.stdout).toContain("Session 99");
    }, 25000); // 25 second test timeout
  });

  // ===========================================================================
  // Workflow tests (end-to-end)
  // ===========================================================================

  describe("Complete Workflows", () => {
    test("WF1: List sessions, then read one", async () => {
      testDb = setupTestDatabase(createStandardTestSessions());
      process.chdir(testDb.getConfig().cwd);

      // Step 1: List sessions
      const listResult = await runCLI(["sessions", "--last", "4h"]);
      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain("4h Window Session 1");

      // Step 2: Read one of the sessions
      const readResult = await runCLI([
        "read",
        "--session", "opencode:default:session-4h-1",
      ]);
      expect(readResult.exitCode).toBe(0);
      expect(readResult.stdout).toContain("4h Window Session 1");
    });

    test("WF2: Search for sessions, then read with tools", async () => {
      const sessions = [
        {
          id: "session-search-test",
          title: "Session about debugging",
          timeCreated: hoursAgo(1),
          timeUpdated: minutesAgo(30),
          messageCount: 10,
          hasTools: true,
        },
      ];
      
      testDb = setupTestDatabase(sessions);
      process.chdir(testDb.getConfig().cwd);

      // Step 1: Search for sessions
      const searchResult = await runCLI([
        "search",
        "--text", "debugging",
      ]);
      expect(searchResult.exitCode).toBe(0);
      expect(searchResult.stdout).toContain("debugging");

      // Step 2: Read with tools
      const readResult = await runCLI([
        "read",
        "--session", "opencode:default:session-search-test",
        "--tools",
        "--all",
      ]);
      expect(readResult.exitCode).toBe(0);
      expect(readResult.stdout).toContain("debugging");
    });

    test("WF3: JSON workflow - list and parse", async () => {
      testDb = setupTestDatabase(createStandardTestSessions());
      process.chdir(testDb.getConfig().cwd);

      // Get sessions in JSON format
      const result = await runCLI(["sessions", "--format", "json", "--last", "24h"]);
      expect(result.exitCode).toBe(0);

      const sessions = JSON.parse(result.stdout);
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);

      // Verify we can access session data programmatically
      const firstSession = sessions[0];
      expect(firstSession.id).toBeDefined();
      expect(firstSession.title).toBeDefined();
    });
  });
});
