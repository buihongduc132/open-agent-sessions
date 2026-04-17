/**
 * Shared CLI config resolution and error helpers.
 *
 * DRY consolidation of patterns duplicated across list.ts, search.ts,
 * detail.ts, read.ts, sessions.ts, similar.ts.
 */

import { Config } from "../../config/types";
import { CliResult } from "../types";

// ============================================================================
// Result Types
// ============================================================================

export type ConfigResult = { ok: true; value: Config } | { ok: false; error: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ============================================================================
// Config Resolution
// ============================================================================

export interface ConfigOptions {
  config?: Config;
  configPath?: string;
  loadConfig?: (path: string) => Config;
}

export function resolveConfig(options: ConfigOptions, usageMessage: string): ConfigResult {
  if (options.config) {
    return { ok: true, value: options.config };
  }

  if (options.configPath && options.loadConfig) {
    try {
      return { ok: true, value: options.loadConfig(options.configPath) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  return { ok: false, error: `Missing config. ${usageMessage}` };
}

// ============================================================================
// Error Helpers
// ============================================================================

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

export function errorResult(message: string): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${message}\n`,
  };
}

// ============================================================================
// Output Helpers
// ============================================================================

/** Threshold (bytes) beyond which stdout output gets a warning to use --output flag */
const LARGE_OUTPUT_THRESHOLD = 60000;

/**
 * Wrap stdout output with a large-output warning if it exceeds the threshold.
 *
 * Previously duplicated in read.ts and export.ts.
 */
export function wrapLargeOutput(stdout: string): CliResult {
  if (stdout.length > LARGE_OUTPUT_THRESHOLD) {
    return {
      exitCode: 0,
      stdout,
      stderr: `Warning: Large output (${stdout.length} bytes). For reliable piping, use --output flag.\n`,
    };
  }
  return { exitCode: 0, stdout, stderr: "" };
}
