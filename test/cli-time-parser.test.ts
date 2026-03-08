import { describe, expect, test } from "bun:test";
import { parseLastDuration, parseTimestamp } from "../src/cli/utils/time-parser";

// ============================================================================
// Time Parser Unit Tests
// ============================================================================

describe("time-parser: parseLastDuration", () => {
  // ==========================================================================
  // Valid Duration Formats
  // ==========================================================================
  describe("valid duration formats", () => {
    test("parses 4h (4 hours)", () => {
      const now = Date.now();
      const result = parseLastDuration("4h", now);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(now - 4 * 60 * 60 * 1000);
      }
    });

    test("parses 2d (2 days)", () => {
      const now = Date.now();
      const result = parseLastDuration("2d", now);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(now - 2 * 24 * 60 * 60 * 1000);
      }
    });

    test("parses 1w (1 week)", () => {
      const now = Date.now();
      const result = parseLastDuration("1w", now);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(now - 7 * 24 * 60 * 60 * 1000);
      }
    });

    test("parses 24h (24 hours)", () => {
      const now = Date.now();
      const result = parseLastDuration("24h", now);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(now - 24 * 60 * 60 * 1000);
      }
    });

    test("parses 7d (7 days)", () => {
      const now = Date.now();
      const result = parseLastDuration("7d", now);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(now - 7 * 24 * 60 * 60 * 1000);
      }
    });

    test("parses 52w (52 weeks)", () => {
      const now = Date.now();
      const result = parseLastDuration("52w", now);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(now - 52 * 7 * 24 * 60 * 60 * 1000);
      }
    });

    test("handles whitespace in input", () => {
      const now = Date.now();
      const result = parseLastDuration("  4h  ", now);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(now - 4 * 60 * 60 * 1000);
      }
    });
  });

  // ==========================================================================
  // Invalid Duration Formats
  // ==========================================================================
  describe("invalid duration formats", () => {
    test("rejects 0h (zero duration)", () => {
      const result = parseLastDuration("0h", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Duration must be positive");
      }
    });

    test("rejects 0d (zero duration)", () => {
      const result = parseLastDuration("0d", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Duration must be positive");
      }
    });

    test("rejects 0w (zero duration)", () => {
      const result = parseLastDuration("0w", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Duration must be positive");
      }
    });

    test("rejects invalid unit (5m - minutes not supported)", () => {
      const result = parseLastDuration("5m", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // "5m" doesn't match the regex /^(\d+)([hdw])$/, so it returns "Invalid time format"
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects invalid unit (5s - seconds not supported)", () => {
      const result = parseLastDuration("5s", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects invalid unit (5y - years not supported)", () => {
      const result = parseLastDuration("5y", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects missing unit (5)", () => {
      const result = parseLastDuration("5", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects missing number (h)", () => {
      const result = parseLastDuration("h", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects empty string", () => {
      const result = parseLastDuration("", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects whitespace only", () => {
      const result = parseLastDuration("   ", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects negative number (-5h)", () => {
      const result = parseLastDuration("-5h", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects decimal number (1.5h)", () => {
      const result = parseLastDuration("1.5h", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects non-string input (number)", () => {
      const result = parseLastDuration(5 as any, Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects non-string input (null)", () => {
      const result = parseLastDuration(null as any, Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects non-string input (undefined)", () => {
      const result = parseLastDuration(undefined as any, Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects natural language (yesterday)", () => {
      const result = parseLastDuration("yesterday", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });

    test("rejects ISO timestamp in --last", () => {
      const result = parseLastDuration("2024-01-01T00:00:00Z", Date.now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid time format");
      }
    });
  });
});

describe("time-parser: parseTimestamp", () => {
  // ==========================================================================
  // Valid ISO-8601 Timestamps with Timezone
  // ==========================================================================
  describe("valid ISO-8601 timestamps", () => {
    test("parses ISO-8601 with Z timezone", () => {
      const result = parseTimestamp("2024-01-01T00:00:00Z");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(new Date("2024-01-01T00:00:00Z").getTime());
      }
    });

    test("parses ISO-8601 with milliseconds and Z", () => {
      const result = parseTimestamp("2024-01-01T00:00:00.123Z");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(new Date("2024-01-01T00:00:00.123Z").getTime());
      }
    });

    test("parses ISO-8601 with positive timezone offset", () => {
      const result = parseTimestamp("2024-01-01T05:00:00+05:00");
      expect(result.ok).toBe(true);
      if (result.ok) {
        // 2024-01-01T05:00:00+05:00 equals 2024-01-01T00:00:00Z
        expect(result.value).toBe(new Date("2024-01-01T00:00:00Z").getTime());
      }
    });

    test("parses ISO-8601 with negative timezone offset", () => {
      const result = parseTimestamp("2024-01-01T00:00:00-05:00");
      expect(result.ok).toBe(true);
      if (result.ok) {
        // 2024-01-01T00:00:00-05:00 equals 2024-01-01T05:00:00Z
        expect(result.value).toBe(new Date("2024-01-01T05:00:00Z").getTime());
      }
    });

    test("parses ISO-8601 with +00:00 offset", () => {
      const result = parseTimestamp("2024-01-01T12:00:00+00:00");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(new Date("2024-01-01T12:00:00Z").getTime());
      }
    });

    test("parses ISO-8601 with -00:00 offset", () => {
      const result = parseTimestamp("2024-01-01T12:00:00-00:00");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(new Date("2024-01-01T12:00:00Z").getTime());
      }
    });

    test("parses with various millisecond precision", () => {
      const result = parseTimestamp("2024-01-01T12:00:00.123456Z");
      expect(result.ok).toBe(true);
    });

    test("handles whitespace in input", () => {
      const result = parseTimestamp("  2024-01-01T00:00:00Z  ");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(new Date("2024-01-01T00:00:00Z").getTime());
      }
    });
  });

  // ==========================================================================
  // Invalid Timestamps (missing timezone)
  // ==========================================================================
  describe("invalid timestamps - missing timezone", () => {
    test("rejects date-only format (2024-01-01)", () => {
      const result = parseTimestamp("2024-01-01");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
        expect(result.error).toContain("ISO-8601 with timezone required");
        expect(result.error).toContain("Date-only strings");
      }
    });

    test("rejects datetime without timezone (2024-01-01T00:00:00)", () => {
      const result = parseTimestamp("2024-01-01T00:00:00");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
        expect(result.error).toContain("timezone required");
      }
    });

    test("rejects datetime with milliseconds but no timezone", () => {
      const result = parseTimestamp("2024-01-01T00:00:00.123");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
      }
    });
  });

  // ==========================================================================
  // Invalid Timestamps (malformed)
  // ==========================================================================
  describe("invalid timestamps - malformed", () => {
    test("rejects empty string", () => {
      const result = parseTimestamp("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
      }
    });

    test("rejects whitespace only", () => {
      const result = parseTimestamp("   ");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
      }
    });

    test("rejects natural language (yesterday)", () => {
      const result = parseTimestamp("yesterday");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
      }
    });

    test("rejects relative time (2 hours ago)", () => {
      const result = parseTimestamp("2 hours ago");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
      }
    });

    test("rejects Unix timestamp (number as string)", () => {
      const result = parseTimestamp("1704067200000");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
      }
    });

    test("rejects non-string input (number)", () => {
      const result = parseTimestamp(1704067200000 as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
      }
    });

    test("rejects non-string input (null)", () => {
      const result = parseTimestamp(null as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
      }
    });

    test("rejects non-string input (undefined)", () => {
      const result = parseTimestamp(undefined as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
      }
    });

    test("rejects malformed date (2024-13-01 - invalid month)", () => {
      const result = parseTimestamp("2024-13-01T00:00:00Z");
      // Month 13 is invalid - JavaScript Date returns NaN for invalid ISO dates
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp");
      }
    });

    test("rejects wrong separator (2024/01/01T00:00:00Z)", () => {
      const result = parseTimestamp("2024/01/01T00:00:00Z");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
      }
    });

    test("rejects missing T separator (2024-01-01 00:00:00Z)", () => {
      const result = parseTimestamp("2024-01-01 00:00:00Z");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid timestamp format");
      }
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================
  describe("edge cases", () => {
    test("rejects leap second timestamp (seconds > 59)", () => {
      const result = parseTimestamp("2016-12-31T23:59:60Z");
      // Our regex only accepts seconds 00-59
      expect(result.ok).toBe(false);
    });

    test("handles far future date", () => {
      const result = parseTimestamp("2099-12-31T23:59:59Z");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeGreaterThan(Date.now());
      }
    });

    test("handles past date", () => {
      const result = parseTimestamp("1970-01-01T00:00:00Z");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    test("handles midnight UTC", () => {
      const result = parseTimestamp("2024-01-01T00:00:00Z");
      expect(result.ok).toBe(true);
    });

    test("handles end of day UTC", () => {
      const result = parseTimestamp("2024-01-01T23:59:59Z");
      expect(result.ok).toBe(true);
    });
  });
});
