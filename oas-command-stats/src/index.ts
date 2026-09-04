/**
 * Public entrypoint for oas-command-stats Phase 2.
 *
 * @file src/index.ts
 */
export { openDb, openReadOnly, setWatermark, getWatermark } from "./storage/duckdb";
export type { DbHandle, WatermarkRow } from "./storage/duckdb";
export { ingestBatch } from "./storage/ingest";
export { SchemaVersionError, KNOWN_SOURCE_SCHEMA_VERSIONS, assertKnownSchemaVersion } from "./storage/schema";
export { parseCommand, getParserVersion } from "./parse/mvdan";
export { bucketComplexity } from "./parse/complexity";
export { extractEvents } from "./extract/registry";
export { derivePiEventId } from "./extract/pi";
export { deriveZcodeEventId } from "./extract/zcode";
export { deriveHermesEventId } from "./extract/hermes";
export type {
  ExtractedEvent,
  ParsedCommand,
  ParseStatus,
  IngestResult,
  ComplexityBucket,
  SupportedAgent,
} from "./types/contract";
