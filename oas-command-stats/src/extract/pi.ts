/**
 * pi event_id derivation: hash(session_file_path + byte_offset_of_record).
 *
 * Resolves OT28 (rank3): naive positional index is unstable on append/compact;
 * hash(content) collides on repeated identical commands. Byte-offset hash is
 * stable across appends.
 *
 * @file src/extract/pi.ts
 */
import { createHash } from "node:crypto";

/**
 * Derive a stable event_id for a pi bash tool_use.
 *
 * @param session_file_path absolute path to the .jsonl session file
 * @param byte_offset       byte offset of the JSONL record in the file
 * @returns                 hex sha256 digest (first 32 chars)
 */
export function derivePiEventId(
  session_file_path: string,
  byte_offset: number,
): string {
  const input = `${session_file_path}:${byte_offset}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}
