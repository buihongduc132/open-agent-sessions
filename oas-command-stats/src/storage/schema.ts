/**
 * Schema DDL + source_schema_version gate.
 *
 * @file src/storage/schema.ts
 */

/** Thrown when batch source_schema_version is unknown (OT49-X4). */
export class SchemaVersionError extends Error {
  constructor(public readonly version: string) {
    super(
      `Unknown source_schema_version '${version}'. ` +
      `Adapter schema drift detected (OT49-X4). Known versions: ${KNOWN_SOURCE_SCHEMA_VERSIONS.join(", ")}.`
    );
    this.name = "SchemaVersionError";
  }
}

/** Currently-known source schema versions from upstream adapters. */
export const KNOWN_SOURCE_SCHEMA_VERSIONS: string[] = ["0.1.0"];

/** Full DDL for oas-command-stats DuckDB file. */
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS session_watermarks (
  agent                    VARCHAR NOT NULL,
  alias                    VARCHAR NOT NULL,
  session_id               VARCHAR NOT NULL,
  scan_started_at          TIMESTAMP,
  scan_completed_at        TIMESTAMP,
  source_schema_version    VARCHAR,
  PRIMARY KEY (agent, alias, session_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  outbox_id                BIGINT PRIMARY KEY,
  agent                    VARCHAR NOT NULL,
  alias                    VARCHAR NOT NULL,
  session_id               VARCHAR NOT NULL,
  event_id                 VARCHAR NOT NULL,
  source_schema_version    VARCHAR NOT NULL,
  event_ts                 TIMESTAMP NOT NULL,
  extracted_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw_command              VARCHAR,
  cwd_hint                 VARCHAR,
  exit_code                INTEGER,
  duration_ms              INTEGER,
  processing_status        VARCHAR NOT NULL DEFAULT 'pending',
  UNIQUE (agent, alias, session_id, event_id)
);

CREATE TABLE IF NOT EXISTS cmd_events (
  agent                    VARCHAR NOT NULL,
  alias                    VARCHAR NOT NULL,
  session_id               VARCHAR NOT NULL,
  event_id                 VARCHAR NOT NULL,
  event_ts                 TIMESTAMP NOT NULL,
  program                  VARCHAR,
  subcommand               VARCHAR,
  positional_args          VARCHAR[],
  flags                    VARCHAR[],
  pipeline_depth           INTEGER,
  statement_count          INTEGER,
  cwd_hint                 VARCHAR,
  parse_status             VARCHAR NOT NULL,
  parser_version           VARCHAR NOT NULL,
  parser_notes             VARCHAR,
  processed_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent, alias, session_id, event_id)
);

CREATE TABLE IF NOT EXISTS cmd_quarantine (
  agent                    VARCHAR NOT NULL,
  alias                    VARCHAR NOT NULL,
  session_id               VARCHAR NOT NULL,
  event_id                 VARCHAR NOT NULL,
  raw_command              VARCHAR,
  parse_status             VARCHAR NOT NULL,
  parser_version           VARCHAR,
  parser_notes             VARCHAR,
  quarantined_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent, alias, session_id, event_id)
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key    VARCHAR PRIMARY KEY,
  value  VARCHAR NOT NULL
);
`;

/** Assert that a source_schema_version is known. Throw if not. */
export function assertKnownSchemaVersion(version: string): void {
  if (!KNOWN_SOURCE_SCHEMA_VERSIONS.includes(version)) {
    throw new SchemaVersionError(version);
  }
}
