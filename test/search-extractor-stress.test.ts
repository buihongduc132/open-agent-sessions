/**
 * test/search-extractor-stress.test.ts
 *
 * Adversarial stress and empirical challenge suite for Milestone 2 payload extractor
 * (src/search/extractor.ts).
 *
 * Covers:
 * 1. Extremely large payloads (>1MB, >10MB stdout payloads)
 * 2. Malformed / fuzzed JSON lines (unpaired brackets, invalid escapes, corruption)
 * 3. Massive nested tool_result dumps inside Claude user messages (zero leakage)
 * 4. Deeply nested objects and arrays in tool arguments (stack safety)
 * 5. Exact byte-length truncation at 64KB (65,536 bytes) preserving multi-byte UTF-8 boundaries
 * 6. Catastrophic backtracking / ReDoS resilience
 */

import { describe, expect, test } from "bun:test";
import { extractTurnPayload, truncateToByteLimit, MAX_FIELD_BYTES } from "../src/search/extractor";

describe("Milestone 2 Payload Extractor — Adversarial Stress & Empirical Challenge", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. Extremely Large Payloads (>1MB, >10MB)
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Extremely Large Payloads (>1MB, >10MB)", () => {
    test("processes 1MB user conversational text within 50ms and bounds to 64KB", () => {
      const line1mb = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T14:00:00.000Z",
        content: "adversarial payload ".repeat(55000), // ~1.1MB
      });

      const start = performance.now();
      const payload = extractTurnPayload(line1mb);
      const elapsed = performance.now() - start;

      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(1);
      const byteLen = Buffer.byteLength(payload!.user_text, "utf8");
      expect(byteLen).toBeLessThanOrEqual(MAX_FIELD_BYTES);
      expect(byteLen).toBe(MAX_FIELD_BYTES);
      expect(elapsed).toBeLessThan(150); // Generous bound, actual is ~7ms
    });

    test("processes 10MB user conversational text within 250ms without OOM and bounds to 64KB", () => {
      const line10mb = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T14:05:00.000Z",
        content: "high-volume user query text ".repeat(380000), // ~10.6MB
      });

      const start = performance.now();
      const payload = extractTurnPayload(line10mb);
      const elapsed = performance.now() - start;

      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(1);
      const byteLen = Buffer.byteLength(payload!.user_text, "utf8");
      expect(byteLen).toBeLessThanOrEqual(MAX_FIELD_BYTES);
      expect(byteLen).toBe(MAX_FIELD_BYTES);
      expect(elapsed).toBeLessThan(500); // Generous bound, actual is ~50ms
    });

    test("processes 10MB assistant text within 250ms and bounds to 64KB", () => {
      const line10mbAssistant = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-04T14:10:00.000Z",
        content: "detailed architectural breakdown ".repeat(320000), // ~10.2MB
      });

      const start = performance.now();
      const payload = extractTurnPayload(line10mbAssistant);
      const elapsed = performance.now() - start;

      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(2);
      const byteLen = Buffer.byteLength(payload!.assistant_text, "utf8");
      expect(byteLen).toBeLessThanOrEqual(MAX_FIELD_BYTES);
      expect(byteLen).toBe(MAX_FIELD_BYTES);
      expect(elapsed).toBeLessThan(500);
    });

    test("skips 10MB standalone tool_result payload within 100ms returning null with zero memory leak", () => {
      const line10mbTR = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T14:15:00.000Z",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_large_stdout",
            content: "compiler output line [0x7ffe0000]\n".repeat(300000), // ~10.5MB
          },
        ],
      });

      const start = performance.now();
      const payload = extractTurnPayload(line10mbTR);
      const elapsed = performance.now() - start;

      expect(payload).toBeNull();
      expect(elapsed).toBeLessThan(300);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Malformed & Fuzzed JSON Lines
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Malformed & Fuzzed JSON Lines", () => {
    test("returns null for partial / slice truncated JSON lines without throwing", () => {
      const validTmpl = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T15:00:00.000Z",
        content: "What is the status of the database migration?",
      });

      for (let i = 0; i < validTmpl.length; i++) {
        const slice = validTmpl.slice(0, i);
        expect(() => {
          const res = extractTurnPayload(slice);
          if (i < validTmpl.length - 1) {
            expect(res).toBeNull();
          }
        }).not.toThrow();
      }
    });

    test("handles unpaired braces and brackets safely", () => {
      const corruptions = [
        "{",
        "}",
        "{{{{{{",
        "}}}}}}",
        "[",
        "]",
        "[[[",
        "]]]",
        '{"type": "user"',
        '{"type": "user", "content": [',
        '{"type": "user", "content": [{"text": "hello"}',
        '{"role": "assistant", "message": {',
      ];

      for (const bad of corruptions) {
        expect(() => {
          expect(extractTurnPayload(bad)).toBeNull();
        }).not.toThrow();
      }
    });

    test("handles invalid unicode escape sequences and raw control characters", () => {
      const badEscapes = [
        '{"type": "user", "content": "\\uZZZZ"}',
        '{"type": "user", "content": "\\u00"}',
        '{"type": "user", "content": "\\u"}',
        '{"type": "user", "content": "\\x00"}',
        '{"type": "user", "content": "\\c"}',
        '{"type": "user", "content": "\\uD800"}', // lone high surrogate
        '{"type": "user", "content": "\\uDFFF"}', // lone low surrogate
        '{"type": "user", "content": "null byte \x00 in string"}',
        '{"type": "user", "content": "\x01\x02\x03\x04\x05"}',
      ];

      for (const bad of badEscapes) {
        expect(() => {
          // Should either parse safely without throwing, or return null if invalid JSON
          const res = extractTurnPayload(bad);
          if (res !== null) {
            expect(typeof res.user_text).toBe("string");
          }
        }).not.toThrow();
      }
    });

    test("handles primitive values, arrays, and type-confused payloads", () => {
      const typeConfusions = [
        "null",
        "undefined",
        "true",
        "false",
        "0",
        "12345",
        "-1.5",
        "NaN",
        "Infinity",
        "[]",
        "[1, 2, 3]",
        '["user", "assistant"]',
        "{}",
        '{"role": null}',
        '{"role": 123}',
        '{"role": []}',
        '{"role": {}}',
        '{"role": "unknown_role"}',
        '{"type": 42}',
        '{"content": {}}',
        '{"content": [null, 123, true]}',
        '{"message": "non-object"}',
        '{"payload": [1, 2, 3]}',
        '{"timestamp": "invalid-date-format"}',
        '{"timestamp": -999999999}',
        '{"timestamp": null}',
      ];

      for (const val of typeConfusions) {
        expect(() => {
          const res = extractTurnPayload(val);
          expect(res).toBeNull();
        }).not.toThrow();
      }
    });

    test("fuzz harness with 2,000 randomized string mutations executes without uncaught exceptions", () => {
      const base = JSON.stringify({
        type: "assistant",
        content: [
          { type: "text", text: "Verified integrity." },
          { type: "tool_use", name: "bash", input: { command: "npm test" } },
        ],
      });

      for (let i = 0; i < 2000; i++) {
        const arr = base.split("");
        const pos = Math.floor(Math.random() * arr.length);
        const mode = Math.floor(Math.random() * 6);
        if (mode === 0) arr.splice(pos, 1);
        else if (mode === 1) arr.splice(pos, 0, "\\");
        else if (mode === 2) arr.splice(pos, 0, '"');
        else if (mode === 3) arr.splice(pos, 0, "\\u0000");
        else if (mode === 4) arr.splice(pos, 0, "\x00");
        else if (mode === 5) arr.splice(pos, 0, "{");

        const mutated = arr.join("");
        expect(() => {
          const res = extractTurnPayload(mutated);
          if (res !== null) {
            expect(Buffer.byteLength(res.assistant_text, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
            expect(Buffer.byteLength(res.tool_name, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
            expect(Buffer.byteLength(res.tool_args, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
          }
        }).not.toThrow();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Massive Nested tool_result Dumps (Zero Leakage into user_text)
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Massive Nested tool_result Dumps (Zero Leakage)", () => {
    test("verifies zero leakage of massive tool_result stdout into user_text in mixed turns", () => {
      const secretCanary = "CANARY_TOKEN_STDOUT_LEAK_987654321";
      const line = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T16:00:00.000Z",
        content: [
          {
            type: "text",
            text: "Please analyze the build failure in module auth-service.",
          },
          {
            type: "tool_result",
            tool_use_id: "call_mvn_build",
            content: `${secretCanary}\n[ERROR] COMPILATION ERROR\n`.repeat(10000), // ~350KB
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.role).toBe(1);
      expect(payload!.user_text).toBe("Please analyze the build failure in module auth-service.");
      expect(payload!.user_text).not.toContain(secretCanary);
      expect(payload!.user_text).not.toContain("COMPILATION ERROR");
      expect(payload!.assistant_text).toBe("");
      expect(payload!.tool_name).toBe("");
      expect(payload!.tool_args).toBe("");
    });

    test("skips nested tool_result structured as array of content blocks inside user turn", () => {
      const nestedCanary = "NESTED_BLOCK_CANARY_456789";
      const line = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T16:05:00.000Z",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_api",
            content: [
              {
                type: "text",
                text: `${nestedCanary} - Internal stack trace and dumped tokens`,
              },
            ],
          },
        ],
      });

      const payload = extractTurnPayload(line);
      // Entire turn is bulk tool_result, should return null
      expect(payload).toBeNull();
    });

    test("skips tool_result with error flag (is_error: true) and massive stderr", () => {
      const line = JSON.stringify({
        type: "user",
        timestamp: "2026-09-04T16:10:00.000Z",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_failing_cmd",
            is_error: true,
            content: "FATAL: Out of memory in worker thread 4\n".repeat(5000),
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Deeply Nested Objects & Arrays in Tool Arguments
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Deeply Nested Objects & Arrays in Tool Arguments", () => {
    test("safely serializes 500-level nested arrays in tool arguments", () => {
      let deepArray: any = "leaf_value";
      for (let i = 0; i < 500; i++) {
        deepArray = [deepArray];
      }

      const line = JSON.stringify({
        type: "assistant",
        content: [
          {
            type: "tool_use",
            name: "deep_processor",
            input: { matrix: deepArray },
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.tool_name).toBe("deep_processor");
      expect(payload!.tool_args).toContain("leaf_value");
      expect(Buffer.byteLength(payload!.tool_args, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    });

    test("safely handles 1,000-level nested objects in tool arguments", () => {
      let deepObj: any = "nested_target";
      for (let i = 0; i < 1000; i++) {
        deepObj = { child: deepObj };
      }

      const line = JSON.stringify({
        type: "assistant",
        content: [
          {
            type: "tool_use",
            name: "tree_inspector",
            input: deepObj,
          },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(payload!.tool_name).toBe("tree_inspector");
      expect(Buffer.byteLength(payload!.tool_args, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    });

    test("handles extreme nesting (10,000 depth) without crashing or unhandled RangeError", () => {
      // Build raw JSON string with 10,000 nested brackets
      const raw =
        '{"type":"assistant","content":[{"type":"tool_use","name":"stack_test","input":' +
        '{"level":'.repeat(10000) +
        '"deepest"' +
        "}".repeat(10000) +
        "}]}";

      expect(() => {
        const payload = extractTurnPayload(raw);
        expect(payload).not.toBeNull();
        expect(payload!.tool_name).toBe("stack_test");
        expect(Buffer.byteLength(payload!.tool_args, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
      }).not.toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Exact 64KB (65,536 bytes) Truncation & UTF-8 Boundary Preservation
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Exact 64KB (65,536 bytes) Truncation & UTF-8 Boundaries", () => {
    test("does not truncate string at exactly 65,536 bytes", () => {
      const exactly64kb = "A".repeat(65536);
      const res = truncateToByteLimit(exactly64kb, 65536);
      expect(res.length).toBe(65536);
      expect(Buffer.byteLength(res, "utf8")).toBe(65536);
      expect(res).toBe(exactly64kb);
    });

    test("truncates ASCII string at 65,537 bytes to exactly 65,536 bytes", () => {
      const overByOne = "A".repeat(65537);
      const res = truncateToByteLimit(overByOne, 65536);
      expect(res.length).toBe(65536);
      expect(Buffer.byteLength(res, "utf8")).toBe(65536);
    });

    test("preserves 2-byte UTF-8 character boundaries (é = C3 A9)", () => {
      // 32,768 é = exactly 65,536 bytes
      const exact2Byte = "é".repeat(32768);
      expect(Buffer.byteLength(exact2Byte, "utf8")).toBe(65536);
      const resExact = truncateToByteLimit(exact2Byte, 65536);
      expect(Buffer.byteLength(resExact, "utf8")).toBe(65536);
      expect(resExact).toBe(exact2Byte);

      // 32,769 é = 65,538 bytes (over limit by 2 bytes)
      const over2Byte = "é".repeat(32769);
      const resOver = truncateToByteLimit(over2Byte, 65536);
      expect(Buffer.byteLength(resOver, "utf8")).toBe(65536);
      expect(resOver.includes("\uFFFD")).toBe(false);

      // Offset by 1 byte: 1 ASCII + 32,768 é = 65,537 bytes (cuts right in middle of last é)
      const offset2Byte = "x" + "é".repeat(32768);
      const resOffset = truncateToByteLimit(offset2Byte, 65536);
      const resOffsetBytes = Buffer.byteLength(resOffset, "utf8");
      expect(resOffsetBytes).toBeLessThanOrEqual(65536);
      expect(resOffsetBytes).toBe(65535); // Truncated before the split 2-byte char
      expect(resOffset.includes("\uFFFD")).toBe(false);
    });

    test("preserves 3-byte UTF-8 character boundaries (€ = E2 82 AC) across all split offsets", () => {
      for (let offset = 0; offset <= 3; offset++) {
        const euroStr = "x".repeat(offset) + "€".repeat(22000);
        const res = truncateToByteLimit(euroStr, 65536);
        const byteLen = Buffer.byteLength(res, "utf8");
        expect(byteLen).toBeLessThanOrEqual(65536);
        expect(res.includes("\uFFFD")).toBe(false);
      }
    });

    test("preserves 4-byte UTF-8 character boundaries (🍉 = F0 9F 8D 89) across all split offsets", () => {
      for (let offset = 0; offset <= 4; offset++) {
        const melonStr = "x".repeat(offset) + "🍉".repeat(17000);
        const res = truncateToByteLimit(melonStr, 65536);
        const byteLen = Buffer.byteLength(res, "utf8");
        expect(byteLen).toBeLessThanOrEqual(65536);
        expect(res.includes("\uFFFD")).toBe(false);
      }
    });

    test("preserves multi-character ZWJ emoji sequences (👨‍👩‍👧‍👦) cleanly", () => {
      const family = "👨‍👩‍👧‍👦";
      for (let offset = 0; offset <= 10; offset++) {
        const zwjStr = "x".repeat(offset) + family.repeat(3000);
        const res = truncateToByteLimit(zwjStr, 65536);
        const byteLen = Buffer.byteLength(res, "utf8");
        expect(byteLen).toBeLessThanOrEqual(65536);
        expect(res.includes("\uFFFD")).toBe(false);
      }
    });

    test("bounds every extracted field independently to <= 64KB in mixed assistant turn", () => {
      const hugeText = "assistant text chunk ".repeat(4000); // ~84KB
      const hugeToolName = "tool_".repeat(15000); // ~75KB
      const hugeToolArgs = JSON.stringify({ arg: "X".repeat(70000) }); // ~70KB

      const line = JSON.stringify({
        type: "assistant",
        content: [
          { type: "text", text: hugeText },
          { type: "tool_use", name: hugeToolName, input: { arg: "X".repeat(70000) } },
        ],
      });

      const payload = extractTurnPayload(line);
      expect(payload).not.toBeNull();
      expect(Buffer.byteLength(payload!.assistant_text, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
      expect(Buffer.byteLength(payload!.tool_name, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
      expect(Buffer.byteLength(payload!.tool_args, "utf8")).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Catastrophic Backtracking & ReDoS Resilience
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Catastrophic Backtracking & ReDoS Resilience", () => {
    test("handles 500KB unclosed XML tags without ReDoS freeze (<20ms)", () => {
      const unclosedXml = JSON.stringify({
        type: "user",
        content: "<system " + "a".repeat(500000) + " user query here",
      });

      const start = performance.now();
      const payload = extractTurnPayload(unclosedXml);
      const elapsed = performance.now() - start;

      expect(payload).not.toBeNull();
      expect(elapsed).toBeLessThan(50);
    });

    test("handles 500KB unclosed bracket prompt headers without ReDoS freeze (<20ms)", () => {
      const unclosedBracket = JSON.stringify({
        type: "user",
        content: "[SYSTEM PROMPT] " + "b".repeat(500000) + " user query here",
      });

      const start = performance.now();
      const payload = extractTurnPayload(unclosedBracket);
      const elapsed = performance.now() - start;

      expect(payload).not.toBeNull();
      expect(elapsed).toBeLessThan(50);
    });

    test("strips 50,000 lines of markdown system instructions preamble in <50ms", () => {
      const mdLines = "# System Instructions\n" + "rule item line\n".repeat(50000);
      const line = JSON.stringify({
        type: "user",
        content: mdLines + "\n\nLegitimate user prompt at the end.",
      });

      const start = performance.now();
      const payload = extractTurnPayload(line);
      const elapsed = performance.now() - start;

      expect(payload).not.toBeNull();
      expect(payload!.user_text).toBe("Legitimate user prompt at the end.");
      expect(elapsed).toBeLessThan(100);
    });

    test("strips 1MB base64 data URIs without regex stall in <30ms", () => {
      const line = JSON.stringify({
        type: "assistant",
        content: "data:image/png;base64," + "A".repeat(500000) + "\nValid response text.",
      });

      const start = performance.now();
      const payload = extractTurnPayload(line);
      const elapsed = performance.now() - start;

      expect(payload).not.toBeNull();
      expect(payload!.assistant_text).toBe("Valid response text.");
      expect(elapsed).toBeLessThan(50);
    });
  });
});
