import { describe, expect, test } from "bun:test";
import { formatRoleBadge, formatMetadata, colorize, roleColors, colors } from "../src/cli/utils/colors";

describe("cli colors utility", () => {
  describe("formatRoleBadge", () => {
    test("formats user role badge", () => {
      const badge = formatRoleBadge("user");
      // Should contain the icon and label (colors may or may not be applied depending on TTY)
      expect(badge).toContain(">");
      expect(badge).toContain("USER");
    });

    test("formats assistant role badge", () => {
      const badge = formatRoleBadge("assistant");
      expect(badge).toContain("<");
      expect(badge).toContain("ASSISTANT");
    });

    test("formats system role badge", () => {
      const badge = formatRoleBadge("system");
      expect(badge).toContain("#");
      expect(badge).toContain("SYSTEM");
    });

    test("badge output contains both icon and label", () => {
      const badge = formatRoleBadge("user");
      // Badge should be formatted as "icon label" (possibly with colors)
      expect(badge).toMatch(/>\s+USER/);
    });
  });

  describe("formatMetadata", () => {
    test("formats metadata text", () => {
      const result = formatMetadata(" (agent/model @ 2024-01-01T00:00:00Z)");
      expect(result).toContain("(agent/model");
    });

    test("handles empty string", () => {
      const result = formatMetadata("");
      expect(result).toBe("");
    });

    test("preserves text content", () => {
      const text = "test metadata content";
      const result = formatMetadata(text);
      // With NO_COLOR or non-TTY, should return plain text
      const originalNoColor = process.env.NO_COLOR;
      process.env.NO_COLOR = "1";
      const plainResult = formatMetadata(text);
      process.env.NO_COLOR = originalNoColor;
      expect(plainResult).toBe(text);
    });
  });

  describe("colorize", () => {
    test("returns plain text when NO_COLOR is set", () => {
      const originalNoColor = process.env.NO_COLOR;
      process.env.NO_COLOR = "1";
      
      const result = colorize("test", "\x1b[36m", true);
      expect(result).toBe("test");
      
      process.env.NO_COLOR = originalNoColor;
    });

    test("returns plain text when not TTY", () => {
      const originalNoColor = process.env.NO_COLOR;
      const originalIsTTY = process.stdout.isTTY;
      
      delete process.env.NO_COLOR;
      // @ts-ignore - mocking non-TTY
      process.stdout.isTTY = false;
      
      const result = colorize("test", "\x1b[36m", true);
      expect(result).toBe("test");
      
      process.env.NO_COLOR = originalNoColor;
      // @ts-ignore - restoring isTTY
      process.stdout.isTTY = originalIsTTY;
    });

    test("applies color codes when TTY is available", () => {
      const originalNoColor = process.env.NO_COLOR;
      const originalIsTTY = process.stdout.isTTY;
      
      delete process.env.NO_COLOR;
      // @ts-ignore - mocking isTTY
      process.stdout.isTTY = true;
      
      const result = colorize("test", "\x1b[36m", false);
      expect(result).toContain("test");
      expect(result).toContain("\x1b["); // Contains ANSI codes
      
      process.env.NO_COLOR = originalNoColor;
      // @ts-ignore - restoring isTTY
      process.stdout.isTTY = originalIsTTY;
    });

    test("applies bold when bold=true", () => {
      const originalNoColor = process.env.NO_COLOR;
      const originalIsTTY = process.stdout.isTTY;
      
      delete process.env.NO_COLOR;
      // @ts-ignore - mocking isTTY
      process.stdout.isTTY = true;
      
      const result = colorize("test", "\x1b[36m", true);
      expect(result).toContain("\x1b[1m"); // Bold code
      expect(result).toContain("\x1b[0m"); // Reset code
      
      process.env.NO_COLOR = originalNoColor;
      // @ts-ignore - restoring isTTY
      process.stdout.isTTY = originalIsTTY;
    });

    test("does not apply bold when bold=false", () => {
      const originalNoColor = process.env.NO_COLOR;
      const originalIsTTY = process.stdout.isTTY;
      
      delete process.env.NO_COLOR;
      // @ts-ignore - mocking isTTY
      process.stdout.isTTY = true;
      
      const result = colorize("test", "\x1b[36m", false);
      expect(result).toContain("\x1b[36m"); // Color code
      expect(result).toContain("\x1b[0m"); // Reset code
      
      process.env.NO_COLOR = originalNoColor;
      // @ts-ignore - restoring isTTY
      process.stdout.isTTY = originalIsTTY;
    });
  });

  describe("roleColors configuration", () => {
    test("has configuration for all roles", () => {
      expect(roleColors.user).toBeDefined();
      expect(roleColors.assistant).toBeDefined();
      expect(roleColors.system).toBeDefined();
    });

    test("each role has icon, color, and label", () => {
      for (const role of ["user", "assistant", "system"] as const) {
        expect(roleColors[role].icon).toBeDefined();
        expect(roleColors[role].color).toBeDefined();
        expect(roleColors[role].label).toBeDefined();
      }
    });

    test("role icons are single characters", () => {
      expect(roleColors.user.icon.length).toBe(1);
      expect(roleColors.assistant.icon.length).toBe(1);
      expect(roleColors.system.icon.length).toBe(1);
    });

    test("role labels are uppercase", () => {
      expect(roleColors.user.label).toBe("USER");
      expect(roleColors.assistant.label).toBe("ASSISTANT");
      expect(roleColors.system.label).toBe("SYSTEM");
    });
  });

  describe("colors utility object", () => {
    test("colors.cyan returns formatted text", () => {
      const originalNoColor = process.env.NO_COLOR;
      const originalIsTTY = process.stdout.isTTY;
      
      delete process.env.NO_COLOR;
      // @ts-ignore - mocking isTTY
      process.stdout.isTTY = true;
      
      const result = colors.cyan("test");
      expect(result).toContain("test");
      
      process.env.NO_COLOR = originalNoColor;
      // @ts-ignore - restoring isTTY
      process.stdout.isTTY = originalIsTTY;
    });

    test("colors.green returns formatted text", () => {
      const result = colors.green("test");
      expect(result).toContain("test");
    });

    test("colors.yellow returns formatted text", () => {
      const result = colors.yellow("test");
      expect(result).toContain("test");
    });

    test("colors.magenta returns formatted text", () => {
      const result = colors.magenta("test");
      expect(result).toContain("test");
    });

    test("colors.blue returns formatted text", () => {
      const result = colors.blue("test");
      expect(result).toContain("test");
    });

    test("colors.white returns formatted text", () => {
      const result = colors.white("test");
      expect(result).toContain("test");
    });

    test("colors.dim returns formatted text", () => {
      const result = colors.dim("test");
      expect(result).toContain("test");
    });

    test("colors.bold returns formatted text", () => {
      const result = colors.bold("test");
      expect(result).toContain("test");
    });

    test("colors.reset is defined", () => {
      expect(colors.reset).toBeDefined();
      expect(colors.reset).toContain("\x1b[");
    });

    test("color functions support bold parameter", () => {
      const originalNoColor = process.env.NO_COLOR;
      const originalIsTTY = process.stdout.isTTY;
      
      delete process.env.NO_COLOR;
      // @ts-ignore - mocking isTTY
      process.stdout.isTTY = true;
      
      const normal = colors.cyan("test", false);
      const bold = colors.cyan("test", true);
      
      // Both should contain the text
      expect(normal).toContain("test");
      expect(bold).toContain("test");
      
      // Bold should contain bold code
      expect(bold).toContain("\x1b[1m");
      
      process.env.NO_COLOR = originalNoColor;
      // @ts-ignore - restoring isTTY
      process.stdout.isTTY = originalIsTTY;
    });
  });
});
