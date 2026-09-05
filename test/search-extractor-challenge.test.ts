import { describe, expect, test } from "bun:test";
import { extractTurnPayload, truncateToByteLimit, MAX_FIELD_BYTES } from "../src/search/extractor";
import type { ExtractedTurnPayload } from "../src/search/types";

describe("Milestone 2 Challenge Test Suite: Payload Extractor", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. Realistic Provider Fixture Accuracy
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Realistic Provider Fixture Accuracy", () => {
    describe("Pi / OMP Realistic Fixture Stream", () => {
      const piFixtures = [
        // Session header
        {
          raw: JSON.stringify({
            type: "session",
            version: 1,
            id: "14ae3db7e6b21339",
            timestamp: "2026-04-05T03:48:25.114Z",
            cwd: "/home/bhd/Documents/Projects/bhd/open-agent-sessions",
          }),
          shouldExtract: false,
        },
        // Model change
        {
          raw: JSON.stringify({
            type: "model_change",
            model: "claude-3-7-sonnet-20250219",
          }),
          shouldExtract: false,
        },
        // Thinking level change
        {
          raw: JSON.stringify({
            type: "thinking_level_change",
            level: "high",
          }),
          shouldExtract: false,
        },
        // System reminder / custom message
        {
          raw: JSON.stringify({
            type: "custom_message",
            customType: "eager-todo-prelude",
            content: "<system-reminder>Create a comprehensive phased todo first.</system-reminder>",
            display: false,
            attribution: "agent",
            id: "7a333c0f",
            timestamp: "2026-04-05T03:48:35.555Z",
          }),
          shouldExtract: false,
        },
        // User turn
        {
          raw: JSON.stringify({
            type: "message",
            id: "pi-msg-usr-01",
            parentId: "7a333c0f",
            timestamp: "2026-04-05T03:48:40.000Z",
            message: {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Please inspect the git status and run the test suite for FTS5 search.",
                },
              ],
            },
          }),
          shouldExtract: true,
          expectedRole: 1,
          expectedUserText: "Please inspect the git status and run the test suite for FTS5 search.",
        },
        // Assistant turn with reasoning, text, and tool execution
        {
          raw: JSON.stringify({
            type: "message",
            id: "pi-msg-ast-01",
            parentId: "pi-msg-usr-01",
            timestamp: "2026-04-05T03:48:45.000Z",
            message: {
              role: "assistant",
              content: [
                {
                  type: "reasoning",
                  text: "I need to check the current branch and execute bun test on test/search-extractor.test.ts.",
                },
                {
                  type: "text",
                  text: "Running git status to verify current changes.",
                },
                {
                  type: "tool",
                  tool: "bash",
                  state: {
                    command: "git status --porcelain",
                    cwd: "/workspace",
                  },
                },
              ],
            },
          }),
          shouldExtract: true,
          expectedRole: 2,
          expectedAssistantTextContains: [
            "I need to check the current branch",
            "Running git status to verify current changes.",
          ],
          expectedToolName: "bash",
          expectedToolArgsContains: ["git status --porcelain", "/workspace"],
        },
        // Compaction event
        {
          raw: JSON.stringify({
            type: "compaction",
            tokens_before: 125000,
            tokens_after: 42000,
          }),
          shouldExtract: false,
        },
      ];

      test("processes full Pi event stream with 100% accuracy", () => {
        for (const fixture of piFixtures) {
          const payload = extractTurnPayload(fixture.raw);
          if (!fixture.shouldExtract) {
            expect(payload).toBeNull();
          } else {
            expect(payload).not.toBeNull();
            expect(payload!.role).toBe(fixture.expectedRole!);
            if (fixture.expectedUserText) {
              expect(payload!.user_text).toBe(fixture.expectedUserText);
            }
            if (fixture.expectedAssistantTextContains) {
              for (const snippet of fixture.expectedAssistantTextContains) {
                expect(payload!.assistant_text).toContain(snippet);
              }
            }
            if (fixture.expectedToolName) {
              expect(payload!.tool_name).toBe(fixture.expectedToolName);
            }
            if (fixture.expectedToolArgsContains) {
              for (const snippet of fixture.expectedToolArgsContains) {
                expect(payload!.tool_args).toContain(snippet);
              }
            }
          }
        }
      });
    });

    describe("Claude Realistic Fixture Stream", () => {
      const claudeFixtures = [
        // User turn with mixed text and tool_result
        {
          raw: JSON.stringify({
            type: "user",
            id: "claude-u1",
            timestamp: "2026-09-04T12:00:00.000Z",
            content: [
              {
                type: "text",
                text: "Here is the error log from the previous run. Can you fix it?",
              },
              {
                type: "tool_result",
                tool_use_id: "call_01",
                content: "Error: ENOENT: no such file or directory, open '/tmp/search.sqlite'",
              },
            ],
          }),
          shouldExtract: true,
          expectedRole: 1,
          expectedUserText: "Here is the error log from the previous run. Can you fix it?",
        },
        // Assistant turn with thinking, answer, and tool_use
        {
          raw: JSON.stringify({
            type: "assistant",
            id: "claude-a1",
            timestamp: "2026-09-04T12:01:00.000Z",
            content: [
              {
                type: "thinking",
                thinking: "The directory /tmp doesn't contain search.sqlite because the cache dir wasn't initialized.",
              },
              {
                type: "text",
                text: "I will check the directory structure and initialize the SQLite file.",
              },
              {
                type: "tool_use",
                id: "toolu_mkdir",
                name: "bash",
                input: {
                  command: "mkdir -p ~/.cache/oas && touch ~/.cache/oas/search.sqlite",
                },
              },
            ],
          }),
          shouldExtract: true,
          expectedRole: 2,
          expectedAssistantTextContains: [
            "The directory /tmp doesn't contain search.sqlite",
            "I will check the directory structure",
          ],
          expectedToolName: "bash",
          expectedToolArgsContains: ["mkdir -p ~/.cache/oas"],
        },
        // Claude base64 image turn
        {
          raw: JSON.stringify({
            type: "assistant",
            id: "claude-a2",
            timestamp: "2026-09-04T12:02:00.000Z",
            content: [
              {
                type: "text",
                text: "Generated diagram of the FTS5 contentless tables:",
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" + "A".repeat(500),
                },
              },
            ],
          }),
          shouldExtract: true,
          expectedRole: 2,
          expectedAssistantText: "Generated diagram of the FTS5 contentless tables:",
        },
      ];

      test("processes full Claude event stream with 100% accuracy", () => {
        for (const fixture of claudeFixtures) {
          const payload = extractTurnPayload(fixture.raw);
          expect(payload).not.toBeNull();
          expect(payload!.role).toBe(fixture.expectedRole);
          if (fixture.expectedUserText) {
            expect(payload!.user_text).toBe(fixture.expectedUserText);
            expect(payload!.user_text).not.toContain("Error: ENOENT");
          }
          if (fixture.expectedAssistantText) {
            expect(payload!.assistant_text).toBe(fixture.expectedAssistantText);
            expect(payload!.assistant_text).not.toContain("iVBORw0");
          }
          if (fixture.expectedAssistantTextContains) {
            for (const snippet of fixture.expectedAssistantTextContains) {
              expect(payload!.assistant_text).toContain(snippet);
            }
          }
          if (fixture.expectedToolName) {
            expect(payload!.tool_name).toBe(fixture.expectedToolName);
          }
          if (fixture.expectedToolArgsContains) {
            for (const snippet of fixture.expectedToolArgsContains) {
              expect(payload!.tool_args).toContain(snippet);
            }
          }
        }
      });
    });

    describe("OpenCode Realistic Fixture Stream", () => {
      const opencodeFixtures = [
        // User message
        {
          raw: JSON.stringify({
            id: "msg_user_01",
            sessionID: "sess_01",
            timeCreated: 1725450000000,
            role: "user",
            content: "Implement selective payload extractor in src/search/extractor.ts",
          }),
          shouldExtract: true,
          expectedRole: 1,
          expectedUserText: "Implement selective payload extractor in src/search/extractor.ts",
        },
        // Assistant message
        {
          raw: JSON.stringify({
            id: "msg_asst_01",
            sessionID: "sess_01",
            timeCreated: 1725450005000,
            role: "assistant",
            content: "I have implemented the selective payload extractor fulfilling Tasks 7-10.",
          }),
          shouldExtract: true,
          expectedRole: 2,
          expectedAssistantText:
            "I have implemented the selective payload extractor fulfilling Tasks 7-10.",
        },
      ];

      test("processes OpenCode message rows with 100% accuracy", () => {
        for (const fixture of opencodeFixtures) {
          const payload = extractTurnPayload(fixture.raw);
          expect(payload).not.toBeNull();
          expect(payload!.role).toBe(fixture.expectedRole);
          if (fixture.expectedUserText) {
            expect(payload!.user_text).toBe(fixture.expectedUserText);
          }
          if (fixture.expectedAssistantText) {
            expect(payload!.assistant_text).toBe(fixture.expectedAssistantText);
          }
        }
      });
    });

    describe("Codex Realistic Fixture Stream", () => {
      const codexFixtures = [
        // Session meta header
        {
          raw: JSON.stringify({
            type: "session_meta",
            payload: {
              id: "019e6101-a1d7-7273-bd72-333a9131685c",
              timestamp: "2026-05-26T04:19:17.000Z",
              cwd: "/workspace",
              originator: "cli",
            },
          }),
          shouldExtract: false,
        },
        // Turn context
        {
          raw: JSON.stringify({
            type: "turn_context",
            payload: {
              turn_id: "turn-1",
            },
          }),
          shouldExtract: false,
        },
        // Event msg
        {
          raw: JSON.stringify({
            type: "event_msg",
            payload: {
              type: "status_update",
            },
          }),
          shouldExtract: false,
        },
        // Developer instructions (role: developer)
        {
          raw: JSON.stringify({
            type: "response_item",
            timestamp: "2026-05-26T04:19:18.000Z",
            payload: {
              role: "developer",
              content: [
                {
                  type: "input_text",
                  text: "You are a coding assistant. Do not remove user instructions.",
                },
              ],
            },
          }),
          shouldExtract: false,
        },
        // User response_item
        {
          raw: JSON.stringify({
            type: "response_item",
            timestamp: "2026-05-26T04:19:20.000Z",
            payload: {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Please explain the difference between FTS5 contentless tables and external content tables.",
                },
              ],
            },
          }),
          shouldExtract: true,
          expectedRole: 1,
          expectedUserText:
            "Please explain the difference between FTS5 contentless tables and external content tables.",
        },
        // Assistant response_item
        {
          raw: JSON.stringify({
            type: "response_item",
            timestamp: "2026-05-26T04:19:25.000Z",
            payload: {
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "FTS5 contentless tables (content='') store zero raw document text in the SQLite database file.",
                },
              ],
            },
          }),
          shouldExtract: true,
          expectedRole: 2,
          expectedAssistantText:
            "FTS5 contentless tables (content='') store zero raw document text in the SQLite database file.",
        },
      ];

      test("processes full Codex event stream with 100% accuracy", () => {
        for (const fixture of codexFixtures) {
          const payload = extractTurnPayload(fixture.raw);
          if (!fixture.shouldExtract) {
            expect(payload).toBeNull();
          } else {
            expect(payload).not.toBeNull();
            expect(payload!.role).toBe(fixture.expectedRole!);
            if (fixture.expectedUserText) {
              expect(payload!.user_text).toBe(fixture.expectedUserText);
            }
            if (fixture.expectedAssistantText) {
              expect(payload!.assistant_text).toBe(fixture.expectedAssistantText);
            }
          }
        }
      });
    });

    describe("Grok Realistic Fixture Stream", () => {
      const grokFixtures = [
        // User turn
        {
          raw: JSON.stringify({
            type: "user",
            content: "Explain BM25 term weighting constants k1 and b.",
          }),
          shouldExtract: true,
          expectedRole: 1,
          expectedUserText: "Explain BM25 term weighting constants k1 and b.",
        },
        // Reasoning turn
        {
          raw: JSON.stringify({
            type: "reasoning",
            summary: [
              { text: "k1 controls term saturation; b controls document length normalization." },
            ],
          }),
          shouldExtract: true,
          expectedRole: 2,
          expectedAssistantText:
            "k1 controls term saturation; b controls document length normalization.",
        },
        // Assistant turn with tool_calls
        {
          raw: JSON.stringify({
            type: "assistant",
            content: "I will search the SQLite documentation for bm25 function signatures.",
            tool_calls: [
              {
                id: "call_grok_search",
                name: "search_docs",
                arguments: {
                  topic: "fts5 bm25",
                  version: "3.45",
                },
              },
            ],
          }),
          shouldExtract: true,
          expectedRole: 2,
          expectedAssistantText:
            "I will search the SQLite documentation for bm25 function signatures.",
          expectedToolName: "search_docs",
          expectedToolArgsContains: ["fts5 bm25", "3.45"],
        },
        // Tool result (skipped)
        {
          raw: JSON.stringify({
            type: "tool_result",
            tool_call_id: "call_grok_search",
            content: "Found 12 matching articles.",
          }),
          shouldExtract: false,
        },
      ];

      test("processes full Grok event stream with 100% accuracy", () => {
        for (const fixture of grokFixtures) {
          const payload = extractTurnPayload(fixture.raw);
          if (!fixture.shouldExtract) {
            expect(payload).toBeNull();
          } else {
            expect(payload).not.toBeNull();
            expect(payload!.role).toBe(fixture.expectedRole!);
            if (fixture.expectedUserText) {
              expect(payload!.user_text).toBe(fixture.expectedUserText);
            }
            if (fixture.expectedAssistantText) {
              expect(payload!.assistant_text).toBe(fixture.expectedAssistantText);
            }
            if (fixture.expectedToolName) {
              expect(payload!.tool_name).toBe(fixture.expectedToolName);
            }
            if (fixture.expectedToolArgsContains) {
              for (const snippet of fixture.expectedToolArgsContains) {
                expect(payload!.tool_args).toContain(snippet);
              }
            }
          }
        }
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Non-conversational Event Filtering
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Non-conversational Event Filtering", () => {
    test("returns null for session metadata records", () => {
      expect(extractTurnPayload(JSON.stringify({ type: "session", id: "s1" }))).toBeNull();
      expect(extractTurnPayload(JSON.stringify({ type: "session_meta", id: "s2" }))).toBeNull();
    });

    test("returns null for model_change events", () => {
      expect(extractTurnPayload(JSON.stringify({ type: "model_change", model: "gpt-4o" }))).toBeNull();
    });

    test("returns null for compaction events", () => {
      expect(
        extractTurnPayload(JSON.stringify({ type: "compaction", tokens_before: 50000, tokens_after: 10000 }))
      ).toBeNull();
    });

    test("returns null for thinking_level_change events", () => {
      expect(
        extractTurnPayload(JSON.stringify({ type: "thinking_level_change", level: "high" }))
      ).toBeNull();
    });

    test("returns null for standalone tool_result events", () => {
      expect(
        extractTurnPayload(
          JSON.stringify({
            type: "tool_result",
            tool_call_id: "c1",
            content: "some output",
          })
        )
      ).toBeNull();
    });

    test("returns null for system role events across all nested locations", () => {
      expect(extractTurnPayload(JSON.stringify({ type: "system", content: "sys prompt" }))).toBeNull();
      expect(extractTurnPayload(JSON.stringify({ role: "system", content: "sys prompt" }))).toBeNull();
      expect(
        extractTurnPayload(JSON.stringify({ type: "message", message: { role: "system", content: "sys" } }))
      ).toBeNull();
      expect(
        extractTurnPayload(JSON.stringify({ type: "response_item", payload: { role: "system", content: "sys" } }))
      ).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Base64 Images & Large Binary Stripping & Bounded Size
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Base64 Images, Binary Stripping & Bounded Size", () => {
    test("strips base64 image objects from assistant content array", () => {
      const line = JSON.stringify({
        type: "assistant",
        content: [
          { type: "text", text: "Screenshot of failure:" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
          },
          { type: "text", text: "Please review the stack trace above." },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.assistant_text).toContain("Screenshot of failure:");
      expect(payload!.assistant_text).toContain("Please review the stack trace above.");
      expect(payload!.assistant_text).not.toContain("iVBORw0");
      expect(payload!.assistant_text).not.toContain("base64");
    });

    test("strips multiple data:image/png;base64 URIs within text", () => {
      const uri1 = "data:image/png;base64," + "A".repeat(1000);
      const uri2 = "data:image/jpeg;base64," + "B".repeat(1000);
      const line = JSON.stringify({
        type: "assistant",
        content: `Before: ${uri1} and After: ${uri2}. Look at the differences.`,
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.assistant_text).toContain("Before:  and After: . Look at the differences.");
      expect(payload!.assistant_text).not.toContain("data:image");
      expect(payload!.assistant_text).not.toContain("AAAAA");
      expect(payload!.assistant_text).not.toContain("BBBBB");
    });

    test("strictly bounds extracted strings to MAX_FIELD_BYTES (65,536 bytes)", () => {
      const hugeUser = "user query " + "U".repeat(100000);
      const hugeAsst = "assistant answer " + "A".repeat(100000);
      const hugeToolName = "tool_" + "T".repeat(100000);
      const hugeToolArg = "arg_" + "X".repeat(100000);

      const userPayload = extractTurnPayload(JSON.stringify({ type: "user", content: hugeUser }));
      expect(userPayload).not.toBeNull();
      expect(Buffer.byteLength(userPayload!.user_text, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);

      const asstPayload = extractTurnPayload(
        JSON.stringify({
          type: "assistant",
          content: hugeAsst,
          tool_calls: [{ name: hugeToolName, arguments: hugeToolArg }],
        })
      );
      expect(asstPayload).not.toBeNull();
      expect(Buffer.byteLength(asstPayload!.assistant_text, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
      expect(Buffer.byteLength(asstPayload!.tool_name, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
      expect(Buffer.byteLength(asstPayload!.tool_args, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    });

    test("truncateToByteLimit preserves multi-byte UTF-8 character integrity", () => {
      // 4-byte emoji 🚀 (F0 9F 9A 80)
      const emoji = "🚀";
      expect(Buffer.byteLength(emoji, "utf8")).toBe(4);

      // Construct a string where emoji crosses byte boundary 5
      const str = "abc" + emoji; // 'abc' is 3 bytes, emoji adds 4 bytes -> total 7 bytes
      const truncatedAt5 = truncateToByteLimit(str, 5);
      // Byte limit 5 should truncate before the emoji (at 3 bytes), NOT slice halfway into the emoji
      expect(Buffer.byteLength(truncatedAt5, "utf8")).toBeLessThanOrEqual(5);
      expect(truncatedAt5).toBe("abc");

      // Truncate at 7 should include the whole emoji
      const truncatedAt7 = truncateToByteLimit(str, 7);
      expect(truncatedAt7).toBe("abc🚀");

      // 3-byte CJK character (e.g. '漢' is 3 bytes: E6 BC A2)
      const cjk = "漢";
      expect(Buffer.byteLength(cjk, "utf8")).toBe(3);
      const cjkStr = "ab" + cjk; // 2 + 3 = 5 bytes
      const truncatedCjkAt4 = truncateToByteLimit(cjkStr, 4);
      expect(Buffer.byteLength(truncatedCjkAt4, "utf8")).toBeLessThanOrEqual(4);
      expect(truncatedCjkAt4).toBe("ab");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Adversarial & Edge Case Stress Testing
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Adversarial & Edge Cases", () => {
    test("handles corrupt or partial JSON lines without crashing", () => {
      const badInputs = [
        "",
        "    ",
        "\n\r\t",
        "{",
        "}",
        '{"type": "user"',
        '{"type": "user", "content": ',
        "{unquoted_key: true}",
        "undefined",
        "NaN",
        "Infinity",
        "[object Object]",
        "null",
        "true",
        "false",
        "12345",
        "\"raw string\"",
      ];

      for (const bad of badInputs) {
        expect(() => extractTurnPayload(bad)).not.toThrow();
        expect(extractTurnPayload(bad)).toBeNull();
      }
    });

    test("handles null, missing, and bizarre nested properties gracefully", () => {
      const weirdObjects = [
        { type: "user", content: null },
        { type: "user", content: undefined },
        { type: "user", content: 123 },
        { type: "user", content: {} },
        { type: "user", content: [null, undefined, 456, {}] },
        { type: "assistant", content: null },
        { type: "assistant", content: undefined },
        { type: "assistant", content: [] },
        { type: "assistant", tool_calls: null },
        { type: "assistant", tool_calls: [null, undefined, {}] },
        { type: "tool", tool: null, arguments: null },
        { type: "tool", name: undefined, input: undefined },
        { message: null },
        { payload: null },
      ];

      for (const obj of weirdObjects) {
        expect(() => extractTurnPayload(JSON.stringify(obj))).not.toThrow();
      }
    });

    test("handles prototype pollution attempts safely", () => {
      const polluted = '{"__proto__": {"admin": true}, "type": "user", "content": "hello"}';
      const payload = extractTurnPayload(polluted);
      expect(payload).not.toBeNull();
      expect(payload!.user_text).toBe("hello");
      // Verify global Object prototype was not polluted
      expect((Object.prototype as any).admin).toBeUndefined();
    });

    test("strips system boilerplate with tricky casing and whitespace", () => {
      const trickyBoilerplate =
        "<SYSTEM>\nStrict system prompt.\n</SYSTEM>\n\n<System_Instruction>\nMore prompt.\n</System_Instruction>\n[Instructions]Do not disobey.[/Instructions]\n# System Instructions\nNever touch system files.\n\nWhat is the capital of France?";

      const line = JSON.stringify({
        type: "user",
        content: trickyBoilerplate,
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.user_text).toBe("What is the capital of France?");
      expect(payload!.user_text).not.toContain("Strict system prompt");
      expect(payload!.user_text).not.toContain("More prompt");
      expect(payload!.user_text).not.toContain("Do not disobey");
      expect(payload!.user_text).not.toContain("Never touch system files");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Latency & Throughput Benchmark (<0.1ms/line)
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Latency & Throughput Benchmark", () => {
    test("verifies sub-millisecond parsing (<0.1ms/line) across 10,000 mixed turns", () => {
      // Build an array of 10,000 realistic lines spanning all 5 providers
      const sampleLines = [
        // Pi user
        JSON.stringify({
          type: "message",
          id: "pi-bench-1",
          timestamp: "2026-09-04T12:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "How do I optimize SQLite full text search?" }],
          },
        }),
        // Pi assistant
        JSON.stringify({
          type: "message",
          id: "pi-bench-2",
          timestamp: "2026-09-04T12:00:05.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", text: "FTS5 contentless tables avoid storing raw text." },
              { type: "text", text: "Use content='' to eliminate text duplication." },
              { type: "tool", tool: "edit", state: { path: "src/search/db.ts" } },
            ],
          },
        }),
        // Claude user
        JSON.stringify({
          type: "user",
          id: "claude-bench-1",
          timestamp: "2026-09-04T12:00:10.000Z",
          content: "Run test suite and check memory usage.",
        }),
        // Claude assistant
        JSON.stringify({
          type: "assistant",
          id: "claude-bench-2",
          timestamp: "2026-09-04T12:00:15.000Z",
          content: [
            { type: "thinking", thinking: "Checking memory cap < 50MB RSS." },
            { type: "text", text: "Running memory benchmark harness." },
            { type: "tool_use", name: "bash", input: { command: "bun test --mem" } },
          ],
        }),
        // OpenCode user & assistant
        JSON.stringify({
          type: "message",
          id: "opencode-bench-1",
          timestamp: 1725450000000,
          role: "user",
          content: "Add watermark tracking for incremental sync.",
        }),
        JSON.stringify({
          type: "message",
          id: "opencode-bench-2",
          timestamp: 1725450005000,
          role: "assistant",
          content: "Watermark tracking implemented in file_watermarks table.",
        }),
        // Codex user & assistant
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-04T12:00:20.000Z",
          payload: {
            role: "user",
            content: [{ type: "input_text", text: "Explain byte offset pointers." }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-04T12:00:25.000Z",
          payload: {
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Byte offset pointers allow O(1) random file access using fs.readSync.",
              },
            ],
          },
        }),
        // Grok user & assistant
        JSON.stringify({
          type: "user",
          content: "What is the formula for BM25 score calculation?",
        }),
        JSON.stringify({
          type: "assistant",
          content: "BM25 score combines inverse document frequency with term frequency saturation.",
          tool_calls: [
            {
              name: "query_docs",
              arguments: { query: "bm25 formula" },
            },
          ],
        }),
        // Non-conversational events
        JSON.stringify({ type: "session", version: 1, id: "s-bench" }),
        JSON.stringify({ type: "model_change", model: "claude-3-7-sonnet" }),
        JSON.stringify({ type: "compaction", tokens_before: 100000, tokens_after: 30000 }),
        JSON.stringify({ type: "thinking_level_change", level: "low" }),
        JSON.stringify({ type: "tool_result", tool_call_id: "c1", content: "ok" }),
      ];

      const TOTAL_LINES = 10000;
      const lines: string[] = [];
      for (let i = 0; i < TOTAL_LINES; i++) {
        lines.push(sampleLines[i % sampleLines.length]);
      }

      // Warmup JIT compiler
      for (let i = 0; i < 500; i++) {
        extractTurnPayload(lines[i]);
      }

      // Timed benchmark run
      const startTime = performance.now();
      let extractedCount = 0;
      let nullCount = 0;

      for (let i = 0; i < TOTAL_LINES; i++) {
        const res = extractTurnPayload(lines[i]);
        if (res !== null) {
          extractedCount++;
        } else {
          nullCount++;
        }
      }

      const elapsedMs = performance.now() - startTime;
      const msPerLine = elapsedMs / TOTAL_LINES;
      const linesPerSec = (TOTAL_LINES / elapsedMs) * 1000;

      console.log(
        `\n[BENCHMARK] Parsed ${TOTAL_LINES} lines in ${elapsedMs.toFixed(2)}ms ` +
          `(${msPerLine.toFixed(4)} ms/line, ${linesPerSec.toFixed(0)} lines/sec). ` +
          `Extracted: ${extractedCount}, Nulls: ${nullCount}`
      );

      // Requirement: sub-millisecond parsing (<0.1ms/line, i.e. <100 µs/line)
      expect(msPerLine).toBeLessThan(0.1);
      // Verify all lines were processed
      expect(extractedCount + nullCount).toBe(TOTAL_LINES);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Live Real Session File Ingestion
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Live Real Session File Ingestion", () => {
    test("streams and extracts real lines from host ~/.omp and ~/.codex sessions if present", () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const os = require("node:os");

      const testFiles: string[] = [];
      const home = os.homedir();

      // Check for real Pi sessions
      const ompDir = path.join(home, ".omp/agent/sessions");
      if (fs.existsSync(ompDir)) {
        try {
          const subdirs = fs.readdirSync(ompDir);
          for (const sub of subdirs) {
            const subPath = path.join(ompDir, sub);
            if (fs.statSync(subPath).isDirectory()) {
              const files = fs.readdirSync(subPath).filter((f: string) => f.endsWith(".jsonl"));
              if (files.length > 0) {
                testFiles.push(path.join(subPath, files[0]));
                break;
              }
            }
          }
        } catch {}
      }

      // Check for real Codex sessions
      const codexDir = path.join(home, ".codex/sessions");
      if (fs.existsSync(codexDir)) {
        const findJsonl = (dir: string, depth = 0): string | null => {
          if (depth > 4) return null;
          try {
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
              const full = path.join(dir, entry);
              if (entry.endsWith(".jsonl")) return full;
              if (fs.statSync(full).isDirectory()) {
                const found = findJsonl(full, depth + 1);
                if (found) return found;
              }
            }
          } catch {}
          return null;
        };
        const codexFile = findJsonl(codexDir);
        if (codexFile) testFiles.push(codexFile);
      }

      console.log(`[REAL SESSIONS] Found ${testFiles.length} real session files to test:`, testFiles);

      for (const filePath of testFiles) {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split(/\r?\n/).filter((l: string) => l.trim().length > 0);
        let validExtracts = 0;
        let ignoredLines = 0;

        for (const line of lines) {
          expect(() => {
            const payload = extractTurnPayload(line);
            if (payload !== null) {
              validExtracts++;
              expect([1, 2, 3]).toContain(payload.role);
              expect(typeof payload.timestamp).toBe("number");
              expect(payload.timestamp).toBeGreaterThan(0);
              expect(Buffer.byteLength(payload.user_text, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
              expect(Buffer.byteLength(payload.assistant_text, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
              expect(Buffer.byteLength(payload.tool_name, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
              expect(Buffer.byteLength(payload.tool_args, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
            } else {
              ignoredLines++;
            }
          }).not.toThrow();
        }

        console.log(
          `[REAL SESSIONS] File ${path.basename(filePath)} (${lines.length} lines): ` +
            `${validExtracts} turns extracted, ${ignoredLines} ignored.`
        );
        expect(validExtracts).toBeGreaterThan(0);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Randomized Fuzzing Generator
  // ───────────────────────────────────────────────────────────────────────────
  describe("7. Randomized Fuzzing Generator", () => {
    test("maintains 100% memory and type safety across 20,000 randomized mutated inputs", () => {
      const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;':\",./<>?`~ \t\n\r\0\uFFFF";
      const roles = ["user", "assistant", "tool", "system", "developer", "unknown", 123, null, undefined, true];
      const types = ["message", "response_item", "user", "assistant", "tool", "session", "model_change", "compaction", "thinking_level_change", "custom_message"];

      function randomString(maxLen: number): string {
        const len = Math.floor(Math.random() * maxLen);
        let res = "";
        for (let i = 0; i < len; i++) {
          res += alphabet[Math.floor(Math.random() * alphabet.length)];
        }
        return res;
      }

      const FUZZ_ITERATIONS = 20000;
      let nonNullCount = 0;

      for (let i = 0; i < FUZZ_ITERATIONS; i++) {
        let input: string;
        const roll = Math.random();

        if (roll < 0.2) {
          // Pure garbage / raw non-JSON text
          input = randomString(50);
        } else if (roll < 0.4) {
          // Mutated JSON with syntax errors
          input = "{" + randomString(40);
        } else {
          // Structured but chaotic JSON
          const chaotic = {
            type: types[Math.floor(Math.random() * types.length)],
            role: roles[Math.floor(Math.random() * roles.length)],
            content: Math.random() < 0.5 ? randomString(100) : [randomString(50), { type: "text", text: randomString(50) }],
            message: Math.random() < 0.5 ? { role: roles[Math.floor(Math.random() * roles.length)], content: randomString(50) } : undefined,
            payload: Math.random() < 0.5 ? { role: roles[Math.floor(Math.random() * roles.length)], content: [{ text: randomString(50) }] } : undefined,
            timestamp: Math.random() < 0.5 ? Date.now() : randomString(10),
            tool_calls: Math.random() < 0.5 ? [{ name: randomString(20), arguments: randomString(50) }] : undefined,
          };
          input = JSON.stringify(chaotic);
        }

        // Must NEVER throw an unhandled exception
        let res: ExtractedTurnPayload | null = null;
        expect(() => {
          res = extractTurnPayload(input);
        }).not.toThrow();

        if (res !== null) {
          nonNullCount++;
          // Must satisfy all invariant bounds
          expect([1, 2, 3]).toContain(res.role);
          expect(typeof res.timestamp).toBe("number");
          expect(res.timestamp).toBeGreaterThan(0);
          expect(Buffer.byteLength(res.user_text, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
          expect(Buffer.byteLength(res.assistant_text, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
          expect(Buffer.byteLength(res.tool_name, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
          expect(Buffer.byteLength(res.tool_args, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
        }
      }

      console.log(`\n[FUZZING] Completed ${FUZZ_ITERATIONS} iterations with 0 crashes. Extracted: ${nonNullCount}`);
      expect(FUZZ_ITERATIONS).toBe(20000);
    });
  });
});

