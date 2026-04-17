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
