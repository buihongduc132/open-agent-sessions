/**
 * src/search/reader.ts
 *
 * Direct byte-offset file reader and context window extraction for the
 * SQLite FTS5 contentless search subsystem.
 *
 * Implements O(1) random seeks into raw JSONL session files using stored
 * byte offsets without full-file scans, defensive JSON parsing, and
 * multi-turn context slicing.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { MsgPointer } from "./types";

export interface RawTurnRecord {
  sessionId: string;
  turnIndex: number;
  role: number;
  timestamp: number;
  payload: any;
  rawText: string;
}

export interface ContextWindowResult {
  hitTurn: RawTurnRecord | null;
  before: RawTurnRecord[];
  after: RawTurnRecord[];
}

/**
 * Reads a single raw turn record directly from disk using the byte offset coordinates
 * stored in the message pointer.
 *
 * Validates file existence and byte bounds, reads the exact byte slice via file descriptor
 * seek, defensively strips trailing newlines, and parses JSON without throwing.
 *
 * @param filePath Path to the raw JSONL session file on disk.
 * @param pointer Pointer containing byte_offset and byte_length coordinates.
 * @returns Parsed RawTurnRecord, or null if the file/slice is invalid or out of bounds.
 */
export function readTurnByPointer(filePath: string, pointer: MsgPointer): RawTurnRecord | null {
  if (!filePath || !pointer) {
    return null;
  }

  if (pointer.byte_offset < 0 || pointer.byte_length <= 0) {
    return null;
  }

  if (!existsSync(filePath)) {
    return null;
  }

  let fileSize: number;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
    fileSize = stat.size;
  } catch {
    return null;
  }

  if (pointer.byte_offset + pointer.byte_length > fileSize) {
    return null;
  }

  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }

  const buffer = Buffer.alloc(pointer.byte_length);
  try {
    let totalRead = 0;
    while (totalRead < pointer.byte_length) {
      const bytesRead = readSync(
        fd,
        buffer,
        totalRead,
        pointer.byte_length - totalRead,
        pointer.byte_offset + totalRead
      );
      if (bytesRead === 0) {
        break;
      }
      totalRead += bytesRead;
    }

    if (totalRead < pointer.byte_length) {
      return null;
    }
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Ignore close error
    }
  }

  let rawText = buffer.toString("utf8");
  if (rawText.endsWith("\r\n")) {
    rawText = rawText.slice(0, -2);
  } else if (rawText.endsWith("\n") || rawText.endsWith("\r")) {
    rawText = rawText.slice(0, -1);
  }

  let payload: any = null;
  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = null;
  }

  return {
    sessionId: pointer.session_id,
    turnIndex: pointer.turn_index,
    role: pointer.role,
    timestamp: pointer.timestamp,
    payload,
    rawText,
  };
}

/**
 * Retrieves a target turn and up to contextN surrounding turns before and after
 * within the same session.
 *
 * Queries msg_pointers for adjacent turn coordinates of the matching session_id,
 * fetches them via O(1) byte-offset seeks, and guarantees strict session isolation.
 *
 * @param db Active search SQLite database.
 * @param filePath Path to the session file on disk.
 * @param pointer Pointer to the target search hit turn.
 * @param contextN Number of surrounding context turns to fetch on each side (0 = none).
 * @returns ContextWindowResult containing hitTurn, before, and after records.
 */
export function readTurnContext(
  db: Database,
  filePath: string,
  pointer: MsgPointer,
  contextN: number
): ContextWindowResult {
  const hitTurn = readTurnByPointer(filePath, pointer);
  if (!hitTurn) {
    return {
      hitTurn: null,
      before: [],
      after: [],
    };
  }

  if (contextN <= 0) {
    return {
      hitTurn,
      before: [],
      after: [],
    };
  }

  const adjacentPointers = db
    .query(
      `SELECT * FROM msg_pointers
       WHERE session_id = ?
         AND turn_index >= ?
         AND turn_index <= ?
         AND turn_index != ?
       ORDER BY turn_index ASC`
    )
    .all(
      pointer.session_id,
      pointer.turn_index - contextN,
      pointer.turn_index + contextN,
      pointer.turn_index
    ) as MsgPointer[];

  const before: RawTurnRecord[] = [];
  const after: RawTurnRecord[] = [];

  for (const p of adjacentPointers) {
    let targetPath = filePath;
    if (p.file_id !== pointer.file_id) {
      const row = db
        .query("SELECT path FROM file_watermarks WHERE file_id = ?")
        .get(p.file_id) as { path: string } | null;
      if (row?.path) {
        targetPath = row.path;
      }
    }

    const record = readTurnByPointer(targetPath, p);
    if (record) {
      if (p.turn_index < pointer.turn_index) {
        before.push(record);
      } else if (p.turn_index > pointer.turn_index) {
        after.push(record);
      }
    }
  }

  return {
    hitTurn,
    before,
    after,
  };
}
