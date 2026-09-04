/**
 * src/search/sync.ts
 *
 * Incremental watermark sync engine for SQLite FTS5 contentless search.
 *
 * Fulfills Milestone 3 (Tasks 11-14):
 * - sync-append-only (Task 11): Incremental append-only byte scanning and watermark updates.
 * - sync-mtime-skip (Task 12): Fast skip on unchanged files when mtime and size match watermark.
 * - sync-truncation-handling (Task 13): Purge stale pointers and FTS entries when size < last_scanned_bytes.
 * - sync-transaction-batching (Task 14): Batch inserts to msg_fts and msg_pointers in transactions (1,000 items/tx).
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Database } from "bun:sqlite";

import { extractTurnPayload } from "./extractor";
import type { ExtractedTurnPayload, FileWatermark } from "./types";

export interface SyncFileInput {
  path: string;
  agent: string;
  alias: string;
  sessionId?: string;
}

export interface SyncFileResult {
  indexedTurns: number;
  skipped: boolean;
  lastScannedBytes: number;
  fileId: number;
}

export interface SyncOptions {
  batchSize?: number;
}

export interface SyncSummary {
  totalFiles: number;
  updatedFiles: number;
  totalTurns: number;
}

interface PreparedItem {
  sessionId: string;
  turnIndex: number;
  fileId: number;
  byteOffset: number;
  byteLength: number;
  role: number;
  timestamp: number;
  rootSessionId: string;
  payload: ExtractedTurnPayload;
}

/**
 * Synchronize a single session file into the SQLite search index.
 * Handles initial sync, incremental append, fast mtime/size skip, and truncation recovery.
 */
export async function syncSessionFile(
  db: Database,
  input: SyncFileInput,
  options?: SyncOptions
): Promise<SyncFileResult> {
  const batchSize = options?.batchSize ?? 1000;

  // 1. Stat file. If file does not exist, return skipped gracefully without throwing.
  if (!existsSync(input.path)) {
    return {
      indexedTurns: 0,
      skipped: true,
      lastScannedBytes: 0,
      fileId: 0,
    };
  }

  let stat;
  try {
    stat = statSync(input.path);
  } catch {
    return {
      indexedTurns: 0,
      skipped: true,
      lastScannedBytes: 0,
      fileId: 0,
    };
  }

  // 2. Query file_watermarks for path. If not found, insert initial row and retrieve file_id.
  let watermark = db
    .query("SELECT * FROM file_watermarks WHERE path = ?")
    .get(input.path) as FileWatermark | null;

  if (!watermark) {
    db.query(`
      INSERT INTO file_watermarks (path, last_scanned_bytes, mtime, agent, alias, indexed_at)
      VALUES (?, 0, 0, ?, ?, 0)
    `).run(input.path, input.agent, input.alias);

    watermark = db
      .query("SELECT * FROM file_watermarks WHERE path = ?")
      .get(input.path) as FileWatermark;
  }

  const fileId = watermark.file_id;

  // 3. Task 12 (sync-mtime-skip):
  // If stat.mtimeMs matches watermark.mtime and stat.size matches watermark.last_scanned_bytes, skip without reading.
  if (
    stat.size === watermark.last_scanned_bytes &&
    (stat.mtimeMs === watermark.mtime || Math.abs(stat.mtimeMs - watermark.mtime) < 1)
  ) {
    return {
      indexedTurns: 0,
      skipped: true,
      lastScannedBytes: watermark.last_scanned_bytes,
      fileId,
    };
  }

  // 4. Task 13 (sync-truncation-handling):
  // If stat.size < watermark.last_scanned_bytes, purge stale entries for this file and reset scan to 0.
  let startOffset = watermark.last_scanned_bytes;
  if (stat.size < startOffset) {
    db.run("DELETE FROM msg_fts WHERE rowid IN (SELECT rowid FROM msg_pointers WHERE file_id = ?)", [fileId]);
    db.run("DELETE FROM msg_pointers WHERE file_id = ?", [fileId]);
    startOffset = 0;
    watermark.last_scanned_bytes = 0;
  }

  // 5. Zero-byte empty file handling
  if (stat.size === 0) {
    db.query(`
      UPDATE file_watermarks
      SET last_scanned_bytes = 0, mtime = ?, agent = ?, alias = ?, indexed_at = ?
      WHERE file_id = ?
    `).run(stat.mtimeMs, input.agent, input.alias, Date.now(), fileId);

    return {
      indexedTurns: 0,
      skipped: false,
      lastScannedBytes: 0,
      fileId,
    };
  }

  // 6. No new bytes to scan (e.g. mtime changed, but size unchanged)
  if (stat.size === startOffset) {
    db.query(`
      UPDATE file_watermarks
      SET mtime = ?, agent = ?, alias = ?, indexed_at = ?
      WHERE file_id = ?
    `).run(stat.mtimeMs, input.agent, input.alias, Date.now(), fileId);

    return {
      indexedTurns: 0,
      skipped: false,
      lastScannedBytes: startOffset,
      fileId,
    };
  }

  // 7. Append scan: Read bytes from startOffset to stat.size using fs.openSync + fs.readSync
  const bytesToRead = stat.size - startOffset;
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(input.path, "r");
  try {
    readSync(fd, new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), 0, bytesToRead, startOffset);
  } finally {
    closeSync(fd);
  }

  // 8. Boundary safety: Stop scanning at the last '\n' in the buffer
  const lastNewlineIndex = buffer.lastIndexOf(0x0a);
  if (lastNewlineIndex === -1) {
    // Incomplete trailing line; leave for next sync
    return {
      indexedTurns: 0,
      skipped: false,
      lastScannedBytes: startOffset,
      fileId,
    };
  }

  const validBuffer = buffer.subarray(0, lastNewlineIndex + 1);
  const endByte = startOffset + lastNewlineIndex + 1;

  // Resolve session_id
  let sessionId = input.sessionId;
  if (!sessionId) {
    const existing = db
      .query("SELECT session_id FROM msg_pointers WHERE file_id = ? LIMIT 1")
      .get(fileId) as { session_id: string } | null;
    if (existing?.session_id) {
      sessionId = existing.session_id;
    }
  }

  // Determine starting turn_index for this file
  const maxTurnRow = db
    .query("SELECT MAX(turn_index) AS maxTurn FROM msg_pointers WHERE file_id = ?")
    .get(fileId) as { maxTurn: number | null } | null;
  let nextTurnIndex =
    maxTurnRow?.maxTurn !== null && maxTurnRow?.maxTurn !== undefined
      ? maxTurnRow.maxTurn + 1
      : 0;

  // 9. Scan lines and prepare turn payloads
  const preparedItems: PreparedItem[] = [];
  let lineStart = 0;

  while (lineStart < validBuffer.length) {
    const nextNewline = validBuffer.indexOf(0x0a, lineStart);
    if (nextNewline === -1) break;

    const lineEnd = nextNewline + 1;
    const lineBuffer = validBuffer.subarray(lineStart, lineEnd);
    const lineByteLength = lineEnd - lineStart;
    const fileByteOffset = startOffset + lineStart;

    const lineStr = lineBuffer.toString("utf8");

    // If session ID was not provided, check if line contains session identifier
    if (!sessionId) {
      try {
        const parsed = JSON.parse(lineStr);
        if (parsed?.id && typeof parsed.id === "string") {
          sessionId = parsed.id;
        } else if (parsed?.sessionId && typeof parsed.sessionId === "string") {
          sessionId = parsed.sessionId;
        } else if (parsed?.session_id && typeof parsed.session_id === "string") {
          sessionId = parsed.session_id;
        }
      } catch {
        // Ignore JSON parse error on non-turn lines
      }
    }

    const payload = extractTurnPayload(lineStr);
    if (payload) {
      const resolvedSessionId =
        sessionId || basename(input.path, extname(input.path)) || "unknown";
      sessionId = resolvedSessionId;

      preparedItems.push({
        sessionId: resolvedSessionId,
        turnIndex: nextTurnIndex++,
        fileId,
        byteOffset: fileByteOffset,
        byteLength: lineByteLength,
        role: payload.role,
        timestamp: payload.timestamp,
        rootSessionId: resolvedSessionId,
        payload,
      });
    }

    lineStart = lineEnd;
  }

  // 10. Task 14 (sync-transaction-batching):
  // Insert prepared batches into msg_pointers and msg_fts using db.transaction(...)
  if (preparedItems.length > 0) {
    const insertPointerStmt = db.query(`
      INSERT INTO msg_pointers (session_id, turn_index, file_id, byte_offset, byte_length, role, timestamp, root_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING rowid
    `);

    const insertFtsStmt = db.query(`
      INSERT INTO msg_fts (rowid, user_text, assistant_text, tool_name, tool_args)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertBatch = db.transaction((items: PreparedItem[]) => {
      for (const item of items) {
        const inserted = insertPointerStmt.get(
          item.sessionId,
          item.turnIndex,
          item.fileId,
          item.byteOffset,
          item.byteLength,
          item.role,
          item.timestamp,
          item.rootSessionId
        ) as { rowid: number };

        insertFtsStmt.run(
          inserted.rowid,
          item.payload.user_text,
          item.payload.assistant_text,
          item.payload.tool_name,
          item.payload.tool_args
        );
      }
    });

    for (let i = 0; i < preparedItems.length; i += batchSize) {
      const chunk = preparedItems.slice(i, i + batchSize);
      insertBatch(chunk);
    }
  }

  // 11. Update file_watermarks with new scanned boundary and metadata
  db.query(`
    UPDATE file_watermarks
    SET last_scanned_bytes = ?, mtime = ?, agent = ?, alias = ?, indexed_at = ?
    WHERE file_id = ?
  `).run(endByte, stat.mtimeMs, input.agent, input.alias, Date.now(), fileId);

  return {
    indexedTurns: preparedItems.length,
    skipped: false,
    lastScannedBytes: endByte,
    fileId,
  };
}

/**
 * Export alias matching syncFileWatermarks specification in task dispatch.
 */
export const syncFileWatermarks = syncSessionFile;

/**
 * Synchronize an array of session files into the search index.
 * Returns summary metrics including total files, updated files, and total turns indexed.
 */
export async function syncAllSessions(
  db: Database,
  files: SyncFileInput[],
  options?: SyncOptions
): Promise<SyncSummary> {
  let updatedFiles = 0;
  let totalTurns = 0;

  for (const file of files) {
    const result = await syncSessionFile(db, file, options);
    if (!result.skipped) {
      updatedFiles++;
      totalTurns += result.indexedTurns;
    }
  }

  return {
    totalFiles: files.length,
    updatedFiles,
    totalTurns,
  };
}
