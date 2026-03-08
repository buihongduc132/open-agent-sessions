/**
 * ANSI color codes for terminal output
 * Uses standard terminal escape sequences without external dependencies
 */

// ANSI escape codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

// Foreground colors
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const WHITE = "\x1b[37m";

/**
 * Apply ANSI styling to text
 * Returns plain text if colors are disabled
 */
export function colorize(text: string, color: string, bold = false): string {
  // Check if colors should be disabled (NO_COLOR env var or non-TTY)
  if (process.env.NO_COLOR || !process.stdout.isTTY) {
    return text;
  }
  
  const codes = bold ? BOLD + color : color;
  return `${codes}${text}${RESET}`;
}

/**
 * Role-specific color schemes
 */
export const roleColors = {
  user: {
    icon: ">",
    color: CYAN,
    label: "USER",
  },
  assistant: {
    icon: "<",
    color: MAGENTA,
    label: "ASSISTANT",
  },
  system: {
    icon: "#",
    color: YELLOW,
    label: "SYSTEM",
  },
} as const;

/**
 * Format a role badge with icon, label, and color
 */
export function formatRoleBadge(role: "user" | "assistant" | "system"): string {
  const config = roleColors[role];
  const icon = colorize(config.icon, config.color, true);
  const label = colorize(config.label, config.color, true);
  return `${icon} ${label}`;
}

/**
 * Format metadata (timestamp, agent/model) with dim styling
 */
export function formatMetadata(text: string): string {
  return colorize(text, WHITE, false);
}

/**
 * Color utility object for export
 */
export const colors = {
  cyan: (text: string, bold = false) => colorize(text, CYAN, bold),
  green: (text: string, bold = false) => colorize(text, GREEN, bold),
  yellow: (text: string, bold = false) => colorize(text, YELLOW, bold),
  magenta: (text: string, bold = false) => colorize(text, MAGENTA, bold),
  blue: (text: string, bold = false) => colorize(text, BLUE, bold),
  white: (text: string, bold = false) => colorize(text, WHITE, bold),
  dim: (text: string) => colorize(text, DIM, false),
  bold: (text: string) => colorize(text, WHITE, true),
  reset: RESET,
};
