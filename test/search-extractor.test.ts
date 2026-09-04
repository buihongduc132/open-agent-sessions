import { describe, expect, test } from "bun:test";
import { extractTurnPayload } from "../src/search/extractor";
import type { ExtractedTurnPayload } from "../src/search/types";

describe("Selective Payload Extraction (Milestone 2: Tasks 7-10)", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. extract-user-text (Task 7)
  // Isolates user conversational prompts and query text while omitting system
  // boilerplate prompts.
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. extract-user-text (Task 7)", () => {
    test("extracts plain conversational text from user string message", () => {
      const line = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T10:00:00.000Z",
        content: "How do I optimize SQLite full-text search with FTS5?",
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(1);
      expect(payload!.user_text).toBe(
        "How do I optimize SQLite full-text search with FTS5?"
      );
      expect(payload!.assistant_text).toBe("");
      expect(payload!.tool_name).toBe("");
      expect(payload!.tool_args).toBe("");
      expect(payload!.timestamp).toBe(Date.parse("2026-09-04T10:00:00.000Z"));
    });

    test("extracts user text from structured content parts array", () => {
      const line = JSON.stringify({
        type: "message",
        timestamp: "2026-09-04T10:05:00.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Can you analyze this memory leak?" },
            { type: "text", text: "The RSS RAM grows beyond 50MB." },
          ],
        },
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(1);
      expect(payload!.user_text).toContain("Can you analyze this memory leak?");
      expect(payload!.user_text).toContain("The RSS RAM grows beyond 50MB.");
      expect(payload!.assistant_text).toBe("");
    });

    test("omits <system>...</system> XML boilerplate from user prompts", () => {
      const line = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T10:10:00.000Z",
        content:
          "<system>\nYou are a helpful AI assistant. Always produce clean code.\n</system>\nPlease implement a binary search algorithm in TypeScript.",
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(1);
      expect(payload!.user_text).toContain(
        "Please implement a binary search algorithm in TypeScript."
      );
      expect(payload!.user_text).not.toContain("You are a helpful AI assistant");
      expect(payload!.user_text).not.toContain("<system>");
    });

    test("omits [SYSTEM PROMPT] / [INSTRUCTIONS] boilerplate headers", () => {
      const line = JSON.stringify({
        type: "message",
        timestamp: "2026-09-04T10:15:00.000Z",
        message: {
          role: "user",
          content:
            "[SYSTEM INSTRUCTION]\nNever execute rm -rf. Adhere strictly to safe commands.\n[/SYSTEM INSTRUCTION]\nFind all files matching *.test.ts in the project.",
        },
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(1);
      expect(payload!.user_text).toContain(
        "Find all files matching *.test.ts in the project."
      );
      expect(payload!.user_text).not.toContain("Never execute rm -rf");
      expect(payload!.user_text).not.toContain("[SYSTEM INSTRUCTION]");
    });

    test("omits markdown '# System Instructions' preamble from user prompt", () => {
      const line = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T10:20:00.000Z",
        content:
          "# System Instructions\nYou must operate within the workspace.\n\nExplain the difference between WAL mode and DELETE journal mode in SQLite.",
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(1);
      expect(payload!.user_text).toContain(
        "Explain the difference between WAL mode and DELETE journal mode in SQLite."
      );
      expect(payload!.user_text).not.toContain("You must operate within the workspace");
    });

    test("returns null for pure system prompt messages (no user conversational intent)", () => {
      const line = JSON.stringify({
        type: "message",
        timestamp: "2026-09-04T10:25:00.000Z",
        message: {
          role: "system",
          content: "You are an autonomous engineering agent with specialized skills.",
        },
      });

      const payload = extractTurnPayload(line);
      expect(payload).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. extract-assistant-text (Task 8)
  // Isolates assistant textual answers and reasoning summaries while skipping
  // raw binary chunks.
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. extract-assistant-text (Task 8)", () => {
    test("extracts plain assistant response text", () => {
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-04T11:00:00.000Z",
        content: [
          {
            type: "text",
            text: "SQLite FTS5 contentless tables (content='') store only inverted index b-trees.",
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(2);
      expect(payload!.user_text).toBe("");
      expect(payload!.assistant_text).toContain(
        "SQLite FTS5 contentless tables (content='') store only inverted index b-trees."
      );
      expect(payload!.tool_name).toBe("");
      expect(payload!.tool_args).toBe("");
      expect(payload!.timestamp).toBe(Date.parse("2026-09-04T11:00:00.000Z"));
    });

    test("extracts assistant reasoning/thinking summaries alongside answer text", () => {
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-04T11:05:00.000Z",
        content: [
          {
            type: "thinking",
            thinking: "First investigate index footprint. Then check if mtime changed.",
          },
          {
            type: "text",
            text: "I have verified that mtime comparison avoids redundant disk I/O.",
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(2);
      expect(payload!.assistant_text).toContain(
        "First investigate index footprint. Then check if mtime changed."
      );
      expect(payload!.assistant_text).toContain(
        "I have verified that mtime comparison avoids redundant disk I/O."
      );
    });

    test("extracts reasoning blocks in Pi format ({ type: 'reasoning', text: '...' })", () => {
      const line = JSON.stringify({
        type: "message",
        timestamp: "2026-09-04T11:10:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Need to verify byte_length offsets for context slicing.",
            },
            {
              type: "text",
              text: "The byte length correctly spans the raw JSON line including newline.",
            },
          ],
        },
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(2);
      expect(payload!.assistant_text).toContain(
        "Need to verify byte_length offsets for context slicing."
      );
      expect(payload!.assistant_text).toContain(
        "The byte length correctly spans the raw JSON line including newline."
      );
    });

    test("skips base64 image data and raw binary blocks while preserving text", () => {
      const hugeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" + "A".repeat(4000);
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-04T11:15:00.000Z",
        content: [
          {
            type: "text",
            text: "Here is the architectural diagram of the search engine pipeline.",
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: hugeBase64,
            },
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(2);
      expect(payload!.assistant_text).toContain(
        "Here is the architectural diagram of the search engine pipeline."
      );
      expect(payload!.assistant_text).not.toContain(hugeBase64.slice(0, 50));
      expect(payload!.assistant_text).not.toContain("iVBORw0KGgo");
    });

    test("skips embedded data:image/png;base64 URIs inside text bodies", () => {
      const inlineDataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA" + "Z".repeat(2000);
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-04T11:20:00.000Z",
        content: [
          {
            type: "text",
            text: `Generated screenshot preview: ${inlineDataUri} and finished rendering.`,
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(2);
      expect(payload!.assistant_text).toContain("Generated screenshot preview:");
      expect(payload!.assistant_text).toContain("and finished rendering.");
      expect(payload!.assistant_text).not.toContain("data:image/png;base64");
      expect(payload!.assistant_text).not.toContain("ZZZZZZZZZZ");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. extract-tool-payload (Task 9)
  // Captures toolCall.name (e.g. bash, edit, read) and structured arguments
  // (command strings, file paths, regex patterns).
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. extract-tool-payload (Task 9)", () => {
    test("captures tool name and bash command string from Claude tool_use block", () => {
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-04T12:00:00.000Z",
        content: [
          {
            type: "tool_use",
            id: "call_bash_001",
            name: "bash",
            input: {
              command: "bun test test/search-db.test.ts --watch",
            },
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(2);
      expect(payload!.tool_name).toBe("bash");
      expect(payload!.tool_args).toContain("bun test test/search-db.test.ts --watch");
    });

    test("captures file paths and regex patterns from tool arguments", () => {
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-04T12:05:00.000Z",
        content: [
          {
            type: "tool_use",
            id: "call_grep_002",
            name: "grep_search",
            input: {
              SearchPath: "/home/bhd/open-agent-sessions/src/search",
              Query: "contentless_delete=1",
              IsRegex: false,
            },
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.tool_name).toBe("grep_search");
      expect(payload!.tool_args).toContain("/home/bhd/open-agent-sessions/src/search");
      expect(payload!.tool_args).toContain("contentless_delete=1");
    });

    test("extracts tool name and arguments from Pi content part ({ type: 'tool', tool, state })", () => {
      const line = JSON.stringify({
        type: "message",
        timestamp: "2026-09-04T12:10:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool",
              tool: "edit",
              state: {
                path: "src/search/extractor.ts",
                instruction: "Implement selective payload extractor",
              },
            },
          ],
        },
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(2);
      expect(payload!.tool_name).toBe("edit");
      expect(payload!.tool_args).toContain("src/search/extractor.ts");
      expect(payload!.tool_args).toContain("Implement selective payload extractor");
    });

    test("extracts tool calls from Grok assistant turn (tool_calls array)", () => {
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-04T12:15:00.000Z",
        content: "Checking git repository status.",
        tool_calls: [
          {
            id: "call_git_003",
            name: "run_command",
            arguments: {
              CommandLine: "git diff --stat HEAD~1",
              Cwd: "/workspace",
            },
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(2);
      expect(payload!.assistant_text).toContain("Checking git repository status.");
      expect(payload!.tool_name).toBe("run_command");
      expect(payload!.tool_args).toContain("git diff --stat HEAD~1");
    });

    test("handles multiple tool calls in a single turn by joining names and args cleanly", () => {
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-04T12:20:00.000Z",
        content: [
          {
            type: "tool_use",
            name: "read_file",
            input: { path: "package.json" },
          },
          {
            type: "tool_use",
            name: "view_file",
            input: { AbsolutePath: "/etc/hosts" },
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.tool_name).toContain("read_file");
      expect(payload!.tool_name).toContain("view_file");
      expect(payload!.tool_args).toContain("package.json");
      expect(payload!.tool_args).toContain("/etc/hosts");
    });

    test("handles standalone tool invocation turns with role = 3", () => {
      const line = JSON.stringify({
        type: "tool",
        timestamp: "2026-09-04T12:25:00.000Z",
        tool: "bash",
        arguments: { command: "cargo check --workspace" },
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(3);
      expect(payload!.tool_name).toBe("bash");
      expect(payload!.tool_args).toContain("cargo check --workspace");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. extract-skip-bulk (Task 10)
  // Skips raw toolResult bulk stdout/stderr dumps and large file reads (>64KB),
  // bounding index dictionary size.
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. extract-skip-bulk (Task 10)", () => {
    test("skips raw toolResult stdout dump nested inside Claude user message", () => {
      const massiveStdout = "compilation unit line 1\n".repeat(2000);
      const line = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T13:00:00.000Z",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_bash_001",
            content: massiveStdout,
          },
        ],
      });

      const payload = extractTurnPayload(line);
      // When a user message consists strictly of bulk tool_result stdout, it is skipped
      // or returns null / empty text to prevent polluting FTS5 dictionary.
      if (payload !== null) {
        expect(payload.user_text).not.toContain(massiveStdout.slice(0, 100));
        expect(payload.user_text.trim()).toBe("");
      } else {
        expect(payload).toBeNull();
      }
    });

    test("preserves user prompt while omitting nested bulk tool_result in mixed turn", () => {
      const bulkStderr = "ERROR: Failed to allocate memory [0x7fff0000]\n".repeat(500);
      const line = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T13:05:00.000Z",
        content: [
          {
            type: "text",
            text: "Here is the crash report from production. Please identify the root cause.",
          },
          {
            type: "tool_result",
            tool_use_id: "call_exec_002",
            content: bulkStderr,
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(1);
      expect(payload!.user_text).toContain(
        "Here is the crash report from production. Please identify the root cause."
      );
      expect(payload!.user_text).not.toContain("ERROR: Failed to allocate memory");
    });

    test("skips standalone tool_result records (e.g. Grok or generic event streams)", () => {
      const line = JSON.stringify({
        type: "tool_result",
        timestamp: "2026-09-04T13:10:00.000Z",
        tool_call_id: "call_bash_003",
        content: "Build successful: 45 packages compiled in 12.3s\n" + "x".repeat(5000),
      });

      const payload = extractTurnPayload(line);
      expect(payload).toBeNull();
    });

    test("truncates/bounds any extracted payload field exceeding 64KB (65,536 bytes)", () => {
      // Create an abnormally large tool command or message exceeding 70KB
      const hugeCommand = "git log --all --grep=" + "A".repeat(70000);
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-04T13:15:00.000Z",
        content: [
          {
            type: "tool_use",
            name: "bash",
            input: { command: hugeCommand },
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      // SQLite FTS5 dictionary bound: must not exceed 65,536 bytes
      const byteLength = Buffer.byteLength(payload!.tool_args, "utf8");
      expect(byteLength).toBeLessThanOrEqual(65536);
    });

    test("truncates/bounds huge assistant textual output exceeding 64KB", () => {
      const hugeText = "Explanation of full text search indexes: " + "B".repeat(80000);
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-04T13:20:00.000Z",
        content: [{ type: "text", text: hugeText }],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      const byteLength = Buffer.byteLength(payload!.assistant_text, "utf8");
      expect(byteLength).toBeLessThanOrEqual(65536);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Agent Session Format Compatibility
  // Verifies parsing across Pi / OMP, Claude, OpenCode, Codex, and Grok.
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Agent Session Format Compatibility", () => {
    describe("Pi / Oh-My-Pi (OMP) format", () => {
      test("parses Pi user turn with nested message object", () => {
        const line = JSON.stringify({
          type: "message",
          id: "pi-msg-001",
          timestamp: "2026-09-04T14:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "How does the Pi session adapter work?" }],
          },
        });

        const payload = extractTurnPayload(line);
        expect(payload).not.toBeNull();
        expect(payload!.role).toBe(1);
        expect(payload!.user_text).toBe("How does the Pi session adapter work?");
        expect(payload!.timestamp).toBe(Date.parse("2026-09-04T14:00:00.000Z"));
      });

      test("parses Pi assistant turn with text and tool state", () => {
        const line = JSON.stringify({
          type: "message",
          id: "pi-msg-002",
          timestamp: "2026-09-04T14:02:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I will check the configuration files." },
              {
                type: "tool",
                tool: "read_file",
                state: { path: "~/.pi/agent/config.json" },
              },
            ],
          },
        });

        const payload = extractTurnPayload(line);
        expect(payload).not.toBeNull();
        expect(payload!.role).toBe(2);
        expect(payload!.assistant_text).toContain("I will check the configuration files.");
        expect(payload!.tool_name).toBe("read_file");
        expect(payload!.tool_args).toContain("~/.pi/agent/config.json");
      });

      test("ignores non-message Pi events (session, model_change, thinking_level_change)", () => {
        const sessionMeta = JSON.stringify({
          type: "session",
          version: 1,
          id: "pi-sess-123",
          cwd: "/home/bhd",
        });
        const modelChange = JSON.stringify({
          type: "model_change",
          model: "claude-3-7-sonnet",
        });
        const compaction = JSON.stringify({
          type: "compaction",
          tokens_before: 120000,
          tokens_after: 40000,
        });

        expect(extractTurnPayload(sessionMeta)).toBeNull();
        expect(extractTurnPayload(modelChange)).toBeNull();
        expect(extractTurnPayload(compaction)).toBeNull();
      });
    });

    describe("Claude format", () => {
      test("parses Claude user record with string content", () => {
        const line = JSON.stringify({
          type: "user",
          id: "claude-msg-001",
          timestamp: "2026-09-04T14:10:00.000Z",
          content: "Please inspect the git status of our project repository.",
        });

        const payload = extractTurnPayload(line);
        expect(payload).not.toBeNull();
        expect(payload!.role).toBe(1);
        expect(payload!.user_text).toBe(
          "Please inspect the git status of our project repository."
        );
      });

      test("parses Claude assistant record with thinking and tool_use blocks", () => {
        const line = JSON.stringify({
          type: "assistant",
          id: "claude-msg-002",
          timestamp: "2026-09-04T14:12:00.000Z",
          content: [
            {
              type: "thinking",
              thinking: "Need to check if working tree is clean before merging.",
            },
            {
              type: "text",
              text: "Running git status to verify working tree status.",
            },
            {
              type: "tool_use",
              id: "toolu_01",
              name: "bash",
              input: { command: "git status --porcelain" },
            },
          ],
        });

        const payload = extractTurnPayload(line);
        expect(payload).not.toBeNull();
        expect(payload!.role).toBe(2);
        expect(payload!.assistant_text).toContain(
          "Need to check if working tree is clean before merging."
        );
        expect(payload!.assistant_text).toContain(
          "Running git status to verify working tree status."
        );
        expect(payload!.tool_name).toBe("bash");
        expect(payload!.tool_args).toContain("git status --porcelain");
      });
    });

    describe("OpenCode format", () => {
      test("parses OpenCode user message row format", () => {
        const line = JSON.stringify({
          type: "message",
          id: "opencode-msg-001",
          timestamp: 1725450000000,
          role: "user",
          content: "Add unit tests for the selective extractor module.",
        });

        const payload = extractTurnPayload(line);
        expect(payload).not.toBeNull();
        expect(payload!.role).toBe(1);
        expect(payload!.user_text).toBe(
          "Add unit tests for the selective extractor module."
        );
        expect(payload!.timestamp).toBe(1725450000000);
      });

      test("parses OpenCode assistant message row format", () => {
        const line = JSON.stringify({
          type: "message",
          id: "opencode-msg-002",
          timestamp: 1725450010000,
          role: "assistant",
          content: "Unit tests added to test/search-extractor.test.ts.",
        });

        const payload = extractTurnPayload(line);
        expect(payload).not.toBeNull();
        expect(payload!.role).toBe(2);
        expect(payload!.assistant_text).toBe(
          "Unit tests added to test/search-extractor.test.ts."
        );
      });
    });

    describe("Codex format", () => {
      test("parses Codex response_item user turn", () => {
        const line = JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-04T14:30:00.000Z",
          payload: {
            role: "user",
            content: [{ type: "input_text", text: "Implement LRU cache in Go." }],
          },
        });

        const payload = extractTurnPayload(line);
        expect(payload).not.toBeNull();
        expect(payload!.role).toBe(1);
        expect(payload!.user_text).toBe("Implement LRU cache in Go.");
        expect(payload!.timestamp).toBe(Date.parse("2026-09-04T14:30:00.000Z"));
      });

      test("parses Codex response_item assistant turn", () => {
        const line = JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-04T14:32:00.000Z",
          payload: {
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Here is the LRU cache implementation using a doubly linked list.",
              },
            ],
          },
        });

        const payload = extractTurnPayload(line);
        expect(payload).not.toBeNull();
        expect(payload!.role).toBe(2);
        expect(payload!.assistant_text).toBe(
          "Here is the LRU cache implementation using a doubly linked list."
        );
      });

      test("ignores Codex session_meta event lines", () => {
        const line = JSON.stringify({
          type: "session_meta",
          timestamp: "2026-09-04T14:28:00.000Z",
          payload: { id: "codex-session-001", title: "Go Project" },
        });

        expect(extractTurnPayload(line)).toBeNull();
      });
    });

    describe("Grok format", () => {
      test("parses Grok chat_history user turn", () => {
        const line = JSON.stringify({
          type: "user",
          content: "What is the computational complexity of BM25 ranking?",
        });

        const payload = extractTurnPayload(line);
        expect(payload).not.toBeNull();
        expect(payload!.role).toBe(1);
        expect(payload!.user_text).toBe(
          "What is the computational complexity of BM25 ranking?"
        );
      });

      test("parses Grok chat_history assistant turn with tool_calls", () => {
        const line = JSON.stringify({
          type: "assistant",
          content: "I will search the repository for BM25 constants.",
          tool_calls: [
            {
              id: "grok_call_1",
              name: "search_code",
              arguments: { query: "bm25(k1=1.2, b=0.75)" },
            },
          ],
        });

        const payload = extractTurnPayload(line);
        expect(payload).not.toBeNull();
        expect(payload!.role).toBe(2);
        expect(payload!.assistant_text).toContain(
          "I will search the repository for BM25 constants."
        );
        expect(payload!.tool_name).toBe("search_code");
        expect(payload!.tool_args).toContain("bm25(k1=1.2, b=0.75)");
      });

      test("parses Grok reasoning record ({ type: 'reasoning', summary: [...] })", () => {
        const line = JSON.stringify({
          type: "reasoning",
          summary: [{ text: "Evaluating ranking parameters for SQLite FTS5." }],
        });

        const payload = extractTurnPayload(line);
        expect(payload).not.toBeNull();
        expect(payload!.role).toBe(2);
        expect(payload!.assistant_text).toContain(
          "Evaluating ranking parameters for SQLite FTS5."
        );
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Robustness, Edge Cases & Bounds
  // Validates null returns on invalid input, encoding integrity, and type safety.
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Robustness, Edge Cases & Bounds", () => {
    test("returns null for empty string or whitespace-only input", () => {
      expect(extractTurnPayload("")).toBeNull();
      expect(extractTurnPayload("   ")).toBeNull();
      expect(extractTurnPayload("\t\n\r")).toBeNull();
    });

    test("returns null for malformed or truncated JSON strings without throwing", () => {
      expect(extractTurnPayload("{")).toBeNull();
      expect(extractTurnPayload('{"type": "user", "content": ')).toBeNull();
      expect(extractTurnPayload("not json at all")).toBeNull();
      expect(extractTurnPayload("{invalid: true}")).toBeNull();
    });

    test("returns null for non-object JSON values (primitives, arrays)", () => {
      expect(extractTurnPayload("12345")).toBeNull();
      expect(extractTurnPayload('"just a string"')).toBeNull();
      expect(extractTurnPayload("true")).toBeNull();
      expect(extractTurnPayload("null")).toBeNull();
      expect(extractTurnPayload("[1, 2, 3]")).toBeNull();
      expect(extractTurnPayload('["user", "assistant"]')).toBeNull();
    });

    test("returns null for JSON objects lacking recognized message or turn properties", () => {
      expect(extractTurnPayload(JSON.stringify({}))).toBeNull();
      expect(extractTurnPayload(JSON.stringify({ version: "1.0", author: "bhd" }))).toBeNull();
      expect(extractTurnPayload(JSON.stringify({ ping: "pong", status: 200 }))).toBeNull();
    });

    test("returns null for message objects with empty or whitespace-only content", () => {
      expect(
        extractTurnPayload(JSON.stringify({ type: "user", content: "" }))
      ).toBeNull();
      expect(
        extractTurnPayload(JSON.stringify({ type: "user", content: "   \n\t  " }))
      ).toBeNull();
      expect(
        extractTurnPayload(JSON.stringify({ type: "user", content: [] }))
      ).toBeNull();
      expect(
        extractTurnPayload(
          JSON.stringify({
            type: "message",
            message: { role: "assistant", content: [] },
          })
        )
      ).toBeNull();
    });

    test("preserves unicode characters, emojis, and quotes without distortion", () => {
      const unicodeContent =
        'Testing emojis 🚀🔍 and unicode: こんにちは! Quotes: "double" and \'single\'. SQL injection test: \' OR 1=1; --';
      const line = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T15:00:00.000Z",
        content: unicodeContent,
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.user_text).toBe(unicodeContent);
    });

    test("handles timestamp conversions defensively (ISO string, unix ms, missing)", () => {
      // 1. ISO string
      const isoPayload = extractTurnPayload(
        JSON.stringify({
          type: "user",
          timestamp: "2026-09-04T15:30:00.000Z",
          content: "ISO timestamp test",
        })
      );
      expect(isoPayload).not.toBeNull();
      expect(isoPayload!.timestamp).toBe(Date.parse("2026-09-04T15:30:00.000Z"));

      // 2. Unix numeric timestamp in ms
      const msPayload = extractTurnPayload(
        JSON.stringify({
          type: "user",
          timestamp: 1725450000000,
          content: "Unix ms timestamp test",
        })
      );
      expect(msPayload).not.toBeNull();
      expect(msPayload!.timestamp).toBe(1725450000000);

      // 3. Missing timestamp defaults to a valid positive number
      const noTsPayload = extractTurnPayload(
        JSON.stringify({
          type: "user",
          content: "Missing timestamp test",
        })
      );
      expect(noTsPayload).not.toBeNull();
      expect(typeof noTsPayload!.timestamp).toBe("number");
      expect(noTsPayload!.timestamp).toBeGreaterThan(0);
    });

    test("verifies full ExtractedTurnPayload interface contract", () => {
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-04T15:45:00.000Z",
        content: [
          { type: "text", text: "Verifying interface contracts." },
          { type: "tool_use", name: "bash", input: { command: "bun test" } },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();

      // Check all 6 properties of ExtractedTurnPayload
      expect(typeof payload!.user_text).toBe("string");
      expect(typeof payload!.assistant_text).toBe("string");
      expect(typeof payload!.tool_name).toBe("string");
      expect(typeof payload!.tool_args).toBe("string");
      expect(typeof payload!.role).toBe("number");
      expect(typeof payload!.timestamp).toBe("number");

      // Verify role classification (1 = user, 2 = assistant, 3 = tool/system)
      expect([1, 2, 3]).toContain(payload!.role);
    });
  });
});
