import { existsSync } from "node:fs";
import {
  OpenCodeAgentEntry,
  OpenCodeStorageDefaults,
  ResolvedOpenCodeStorage,
} from "./types";

export interface ResolveOpenCodeStorageOptions {
  exists?: (path: string) => boolean;
  context?: string;
}

export function resolveOpenCodeStorage(
  entry: OpenCodeAgentEntry,
  defaults: OpenCodeStorageDefaults,
  options: ResolveOpenCodeStorageOptions = {}
): ResolvedOpenCodeStorage {
  const exists = options.exists ?? existsSync;
  const contextPrefix = options.context ? `${options.context}: ` : "";

  const dbPath = entry.storage.db_path ?? defaults.dbPath;
  const jsonlPath = entry.storage.jsonl_path ?? defaults.jsonlPath;

  const dbExists = exists(dbPath);
  const jsonlExists = exists(jsonlPath);

  switch (entry.storage.mode) {
    case "auto":
      if (dbExists) {
        return { mode: "db", path: dbPath, dbPath, jsonlPath };
      }
      if (jsonlExists) {
        return { mode: "jsonl", path: jsonlPath, dbPath, jsonlPath };
      }
      throw new Error(
        `${contextPrefix}OpenCode storage not found (db: ${dbPath}, jsonl: ${jsonlPath})`
      );
    case "db":
      if (!dbExists) {
        throw new Error(`${contextPrefix}OpenCode DB not found: ${dbPath}`);
      }
      return { mode: "db", path: dbPath, dbPath, jsonlPath };
    case "jsonl":
      if (!jsonlExists) {
        throw new Error(`${contextPrefix}OpenCode JSONL not found: ${jsonlPath}`);
      }
      return { mode: "jsonl", path: jsonlPath, dbPath, jsonlPath };
    default:
      throw new Error(`${contextPrefix}Unsupported storage mode: ${entry.storage.mode}`);
  }
}
