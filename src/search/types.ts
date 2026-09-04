/**
 * src/search/types.ts
 *
 * Core domain types and interfaces for the SQLite FTS5 contentless search subsystem.
 */

export interface SearchDbOptions {
  dbPath?: string;
}

export interface FileWatermark {
  file_id: number;
  path: string;
  last_scanned_bytes: number;
  mtime: number;
  agent: string;
  alias: string;
  indexed_at: number;
}

export interface MsgPointer {
  rowid: number;
  session_id: string;
  turn_index: number;
  file_id: number;
  byte_offset: number;
  byte_length: number;
  role: number; // 1 = user, 2 = assistant, 3 = tool/system
  timestamp: number;
  root_session_id?: string | null;
}

export interface ExtractedTurnPayload {
  user_text: string;
  assistant_text: string;
  tool_name: string;
  tool_args: string;
  role: number;
  timestamp: number;
}

export interface SearchQueryOptions {
  text: string;
  agent?: string;
  alias?: string;
  limit?: number;
  context?: number;
  session?: string;
}

export interface SearchHit {
  rowid: number;
  sessionId: string;
  shortId: string;
  turnIndex: number;
  role: string;
  timestamp: number;
  agent: string;
  alias: string;
  filePath: string;
  snippet: string;
  contextBefore?: Array<{ turnIndex: number; role: string; text: string }>;
  contextAfter?: Array<{ turnIndex: number; role: string; text: string }>;
}
